
import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "workspace", "memory.db");
const db = new Database(dbPath);

try {
    const rows = db.prepare("SELECT * FROM settings WHERE key LIKE 'last_used_model%';").all();
    console.log("DATABASE_SETTINGS:" + JSON.stringify(rows));
    
    if (rows.length === 0) {
        console.log("Setting old model name to trigger migration...");
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("last_used_model_name", "models/bge-base-en-v1.5");
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("last_used_model_dim", "768");
        console.log("Done.");
    }
} catch (e) {
    console.log("DATABASE_ERROR:" + e.message);
}
db.close();
