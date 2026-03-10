import { db } from './src/memory/db.js';
import { embed, embeddingToBuffer } from './src/memory/embed.js';

async function test() {
    const query = 'what is the document Chan of draft about?';
    const queryEmbedding = await embed(query);
    const queryBuffer = embeddingToBuffer(queryEmbedding);

    let sql = `
        SELECT
            m.id, m.type, m.channel, m.chunk_text,
            e.distance,
            d.name AS doc_name, d.collection, d.doc_id
        FROM memory_embeddings e
        JOIN memory m ON m.id = e.rowid
        LEFT JOIN documents d ON d.doc_id = m.doc_id
        WHERE e.embedding MATCH ?
        AND k = 25 ORDER BY e.distance ASC
    `;

    const rows = db.prepare(sql).all(queryBuffer);
    console.log("Vector rows:", rows.length);
    console.log(rows.map(r => ({ id: r.id, type: r.type, collection: r.collection, distance: r.distance })));

    let sql2 = `
        WITH fts_results AS (
            SELECT rowid, bm25(memory_fts) AS distance
            FROM memory_fts
            WHERE memory_fts MATCH ?
            ORDER BY distance ASC
            LIMIT 25
        )
        SELECT
            m.id, m.type, m.channel, m.chunk_text,
            f.distance,
            d.name AS doc_name, d.collection, d.doc_id
        FROM fts_results f
        JOIN memory m ON m.id = f.rowid
        LEFT JOIN documents d ON d.doc_id = m.doc_id
        WHERE 1=1
    `;
    const rows2 = db.prepare(sql2).all('what document Chan of draft about');
    console.log("BM25 rows:", rows2.length);
    console.log(rows2.map(r => ({ id: r.id, type: r.type, collection: r.collection })));
}
test().catch(console.error);
