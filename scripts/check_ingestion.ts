import { db } from './src/memory/db.js';

try {
    const docCount = db.prepare('SELECT COUNT(*) as count FROM documents').get();
    const links = db.prepare('SELECT * FROM channel_collections').all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    
    console.log('--- DB INFO ---');
    console.log('TABLES:', JSON.stringify(tables));
    console.log('DOC_COUNT:', JSON.stringify(docCount));
    console.log('LINKS:', JSON.stringify(links));
} catch (err) {
    console.error('DB ERROR:', err);
}
