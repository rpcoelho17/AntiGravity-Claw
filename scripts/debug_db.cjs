const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.cwd(), 'workspace', 'memory.db');
if (!fs.existsSync(dbPath)) {
    console.error('DB NOT FOUND at', dbPath);
    process.exit(1);
}

const db = new Database(dbPath);

try {
    const docCount = db.prepare('SELECT COUNT(*) as count FROM documents').get();
    const docs = db.prepare('SELECT * FROM documents LIMIT 5').all();
    const links = db.prepare("SELECT * FROM settings WHERE key LIKE 'channel_collections:%'").all();
    
    console.log('--- DB SUMMARY ---');
    console.log('DOC_COUNT:', docCount.count);
    console.log('DOCS_SAMPLE:', JSON.stringify(docs, null, 2));
    console.log('COLLECTION_LINKS:', JSON.stringify(links, null, 2));
} catch (err) {
    console.error('DB_ERROR:', err.message);
} finally {
    db.close();
}
