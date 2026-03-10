import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "workspace", "memory.db");
const db = new Database(dbPath);

try {
    // Reset back to default channel for Telegram
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("active_channel:tg", "D");
    console.log("✅ Reset active_channel:tg back to 'D'");
} catch (err) {
    console.error("Error setting DB:", err);
} finally {
    db.close();
}
