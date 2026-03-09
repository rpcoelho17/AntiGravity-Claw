import { spawn } from 'child_process';
import path from 'path';
import { db } from './db.js';
import { embedBatch, embeddingToBuffer } from './embed.js';
import { callLLM } from '../llm.js';
import { semanticChunk } from './chunker.js';

export async function runIngestion(filePath: string, collection: string): Promise<string> {
    // 1. Extract text using Python script
    const scriptPath = path.join(process.cwd(), 'scripts', 'ingest.py');
    
    // Choose most robust Python command for the environment
    let pythonExe = "python3";
    let args = [scriptPath, filePath];

    if (process.platform === 'win32') {
        pythonExe = 'C:\\Python313\\python.exe'; // Full path for GPU/CUDA reliability
        args = [scriptPath, filePath];
    }

    console.log(`Executing sync: ${pythonExe} ${args.join(' ')}`);

    let result: { stdout: Buffer; stderr: Buffer; status: number | null };
    try {
        const { execSync } = await import('child_process');
        
        // On Windows, manually quote all paths to handle spaces correctly
        const cmd = process.platform === 'win32' 
            ? `"${pythonExe}" "${scriptPath}" "${filePath}"`
            : `${pythonExe} "${scriptPath}" "${filePath}"`;

        console.log(`Executing: ${cmd}`);
        
        const stdout = execSync(cmd, {
            env: { ...process.env, PYTHONIOENCODING: "utf-8" },
            maxBuffer: 50 * 1024 * 1024 // 50MB for large docs
        });
        
        result = {
            stdout: stdout as Buffer,
            stderr: Buffer.from(""), // execSync doesn't return stderr unless it fails
            status: 0
        };
    } catch (e: any) {
        console.error("ExecSync error:", e.message);
        // e.stderr contains the Python traceback if it failed
        if (e.stderr) console.error("Stderr:", e.stderr.toString());
        throw e;
    }

    const stdoutData = result.stdout;
    const resultJson = stdoutData.toString().trim();
    const stderrStr = result.stderr ? result.stderr.toString().trim() : "";
    
    let resultObj: any;
    try {
        resultObj = JSON.parse(resultJson);
    } catch (e: any) {
        console.error("JSON Parse Error. Raw stdout:", resultJson);
        console.error("Raw Sync Stderr:", stderrStr);
        throw new Error(`Failed to parse Python output: ${e.message}. Status: ${result.status}. Stderr: ${stderrStr}`);
    }
    const { text, file_name, chunks, embeddings } = resultObj;

    if (!chunks || !embeddings || chunks.length === 0) {
        throw new Error("Python script failed to provide chunks or embeddings");
    }

    // 2. Generate description via LLM
    console.log(`Generating summary for ${file_name}...`);
    const summaryResponse = await callLLM(
        "Summarize this document in one paragraph, describing what it contains and what it is useful for.",
        [{ role: "user", content: text.substring(0, 5000) }],
        []
    );
    const description = summaryResponse.content;

    // 3. Register document (Handle duplicates)
    console.log(`Registering ${file_name} in collection ${collection}...`);
    const relPath = `collections/${collection}/`;
    // Use INSERT OR IGNORE to avoid UNIQUE constraint failures
    const info = db.prepare(`
        INSERT OR IGNORE INTO documents (name, collection, file_path, description, status)
        VALUES (?, ?, ?, ?, 'ingesting')
    `).run(file_name, collection, relPath, description);

    let docId: number | bigint;
    if (info.changes === 0) {
        // Document already exists, get its ID and clear old chunks for re-ingestion
        const existing = db.prepare('SELECT doc_id FROM documents WHERE name = ? AND collection = ?').get(file_name, collection) as any;
        docId = existing.doc_id;
        db.prepare('DELETE FROM memory WHERE doc_id = ?').run(docId);
        db.prepare('UPDATE documents SET description = ?, status = \'ingesting\' WHERE doc_id = ?').run(description, docId);
    } else {
        docId = info.lastInsertRowid;
    }

    // 4. Store in DB (Transaction for speed)
    console.log(`Storing ${chunks.length} local chunks in DB...`);
    const insertMemory = db.prepare("INSERT INTO memory (type, channel, doc_id, chunk_text, speaker) VALUES ('R', '__rag__', ?, ?, NULL)");
    const insertEmbedding = db.prepare("INSERT INTO memory_embeddings (rowid, embedding) VALUES (?, ?)");

    const transaction = db.transaction((chunks: string[], embeddings: number[][], docId: number | bigint) => {
        for (let i = 0; i < chunks.length; i++) {
            const memInfo = insertMemory.run(docId, chunks[i]);
            const rowid = BigInt(memInfo.lastInsertRowid);
            // Convert numerical array from Python to Float32Array for buffer conversion
            const vector = new Float32Array(embeddings[i]);
            insertEmbedding.run(rowid, embeddingToBuffer(vector));
        }
        db.prepare("UPDATE documents SET chunk_count=?, status='ready' WHERE doc_id=?").run(chunks.length, docId);
    });

    transaction(chunks, embeddings, docId);

    return `Successfully ingested ${chunks.length} chunks from ${file_name} (Local BGE)`;
}
