import { exec } from 'child_process';
import path from 'path';
import { db } from './db.js';
import { callLLM } from '../llm.js';

export async function runIngestion(
    filePath: string, 
    collection: string, 
    onProgress?: (msg: string) => void
): Promise<string> {
    const scriptPath = path.join(process.cwd(), 'scripts', 'ingest.py');
    const dbPath = path.join(process.cwd(), 'data', 'memory.db');
    const vecExtPath = path.join(process.cwd(), 'node_modules', 'sqlite-vec-windows-x64', 'vec0');
    
    let pythonExe = "python3";
    if (process.platform === 'win32') {
        pythonExe = 'C:\\Python313\\python.exe'; 
    }

    // Build command — Python writes directly to SQLite, no temp files needed
    const cmd = `"${pythonExe}" "${scriptPath}" "${filePath}" --db "${dbPath}" --collection "${collection}" --vec-ext "${vecExtPath}"`;
    console.log(`Executing: ${cmd}`);

    if (onProgress) onProgress('📄 Starting ingestion...');

    return new Promise((resolve, reject) => {
        let stdout = '';

        const child = exec(cmd, {
            env: { ...process.env, PYTHONIOENCODING: "utf-8" },
            maxBuffer: 10 * 1024 * 1024,
            timeout: 1800000 // 30 mins
        });

        // Capture stdout (small JSON status)
        child.stdout?.on('data', (data) => {
            stdout += data.toString();
        });

        // Stream stderr for real-time progress
        child.stderr?.on('data', (data) => {
            const lines = data.toString().split('\n').filter((l: string) => l.trim());
            for (const line of lines) {
                console.log(`  [ingest-py] ${line}`);
                
                // Forward progress to Telegram
                if (onProgress) {
                    if (line.startsWith('EXTRACTING:')) onProgress(`📄 ${line}`);
                    else if (line.startsWith('CHUNKING:')) onProgress(`✂️ ${line}`);
                    else if (line.startsWith('EMBEDDING:')) onProgress(`🧠 ${line}`);
                    else if (line.startsWith('STORING:')) onProgress(`💾 ${line}`);
                    else if (line.startsWith('STORED:')) onProgress(`✅ ${line}`);
                }
            }
        });

        child.on('error', (error) => {
            return reject(new Error(`Python process error: ${error.message}`));
        });

        child.on('close', async (code) => {
            try {
                if (code !== 0) {
                    // Try to parse error from stdout
                    try {
                        const result = JSON.parse(stdout.trim());
                        if (result.error) {
                            return reject(new Error(`Ingestion error: ${result.error}`));
                        }
                    } catch {}
                    return reject(new Error(`Python script exited with code ${code}`));
                }

                // Parse the small status JSON from stdout
                let result: any;
                try {
                    result = JSON.parse(stdout.trim());
                } catch (e) {
                    return reject(new Error(`Failed to parse Python output: ${stdout.substring(0, 200)}`));
                }

                if (result.error) {
                    return reject(new Error(`Ingestion error: ${result.error}`));
                }

                const { file_name, chunks: chunkCount, time: elapsed } = result;

                // Optional: Generate LLM summary and update the document
                try {
                    if (onProgress) onProgress("📝 Generating summary...");
                    const doc = db.prepare('SELECT doc_id, file_path FROM documents WHERE name = ? AND collection = ?')
                        .get(file_name, collection) as any;
                    
                    if (doc) {
                        const firstChunk = db.prepare('SELECT chunk_text FROM memory WHERE doc_id = ? LIMIT 1')
                            .get(doc.doc_id) as any;
                        
                        if (firstChunk) {
                            const summaryResponse = await callLLM(
                                "Summarize this document in one paragraph, describing what it contains and what it is useful for.",
                                [{ role: "user", content: firstChunk.chunk_text.substring(0, 5000) }],
                                []
                            );
                            db.prepare('UPDATE documents SET description = ? WHERE doc_id = ?')
                                .run(summaryResponse.content, doc.doc_id);
                        }
                    }
                } catch (e: any) {
                    console.warn(`  [ingest] LLM summary failed (non-fatal): ${e.message}`);
                }

                if (onProgress) onProgress(`✅ Done! ${chunkCount} chunks stored in ${elapsed}s.`);
                resolve(`Successfully ingested ${chunkCount} chunks from ${file_name} in ${elapsed}s (Local BGE)`);

            } catch (e: any) {
                reject(new Error(`Ingestion post-processing failed: ${e.message}`));
            }
        });
    });
}
