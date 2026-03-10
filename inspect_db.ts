import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "workspace", "memory.db");
const db = new Database(dbPath);

try {
    const count = db.prepare("SELECT COUNT(*) as count FROM memory").get();
    console.log(`Memory count: ${count.count}`);

    if (count.count > 0) {
        const sample = db.prepare("SELECT * FROM memory LIMIT 5").all();
        console.log("Samples:", JSON.stringify(sample, null, 2));
    }

    const settings = db.prepare("SELECT * FROM settings").all();
    console.log("Settings:", JSON.stringify(settings, null, 2));

} catch (err) {
    console.error("Error inspecting DB:", err);
} finally {
    db.close();
}
