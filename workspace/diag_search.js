
const db = require('better-sqlite3')('workspace/memory.db');

function getChannelCollections(channel) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('channel_collections:' + channel);
    const raw = row ? row.value : "";
    const linked = raw.split(",").map(c => c.trim()).filter(Boolean);
    const pastes = 'p:' + channel;
    return [...new Set([pastes, ...linked])];
}

const channel = 'D';
const collections = getChannelCollections(channel);
console.log('Target Channel:', channel);
console.log('Linked Collections:', JSON.stringify(collections));

const query = 'CSM training Rodrigo Coelho Certified Scrum Master';
// Simulating the search logic
const rows = db.prepare(`
    SELECT 
        m.id, m.type, m.channel, m.chunk_text, m.speaker, m.timestamp,
        d.name AS doc_name, d.file_path, d.collection, d.doc_id
    FROM memory m
    LEFT JOIN documents d ON d.doc_id = m.doc_id
    WHERE m.chunk_text LIKE '%CSM%' OR m.chunk_text LIKE '%Scrum%'
`).all();

console.log('Scan results (LIKE %CSM%):', rows.length);
rows.forEach(r => {
    if (r.type === 'R') {
        const isMatch = collections.includes(r.collection);
        console.log(`Doc ID ${r.doc_id}: "${r.doc_name}" | Collection: "${r.collection}" | In Linked? ${isMatch}`);
    }
});

const doc37 = db.prepare('SELECT * FROM documents WHERE doc_id = 37').get();
if (doc37) {
    console.log('Doc 37 info:', JSON.stringify(doc37));
} else {
    console.log('Doc 37 NOT FOUND in documents table!');
}

const chunks37 = db.prepare('SELECT COUNT(*) as count FROM memory WHERE doc_id = 37').get();
console.log('Chunks for Doc 37 in memory table:', chunks37.count);
