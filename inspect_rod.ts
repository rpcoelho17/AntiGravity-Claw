import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "data", "memory.db");
const db = new Database(dbPath);

try {
    const rows = db.prepare("SELECT id, channel, chunk_text FROM memory WHERE type='M' AND chunk_text LIKE '%Rod%'").all();
    console.log("Memory containing 'Rod':", rows);
    const channels = db.prepare("SELECT DISTINCT channel FROM memory WHERE type='M'").all();
    console.log("All channels with messages:", channels);
} catch (err) {
    console.error(err);
} finally {
    db.close();
}
