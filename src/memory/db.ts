/**
 * memory/db.ts — SQLite connection + schema initialization
 * 
 * Opens memory.db, loads sqlite-vec extension, and creates all tables
 * on first startup. Exports the db singleton and settings helpers.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import fs from "fs";

// ── Workspace paths ─────────────────────────────────────────────────

const WORKSPACE = process.env["ANTIGRAVITY_WORKSPACE"]
    ?? path.join(process.cwd(), "data");

export const DB_PATH = path.join(WORKSPACE, "memory.db");
export const COLLECTIONS_PATH = path.join(WORKSPACE, "collections");
export const MEMORY_MD_PATH = path.join(WORKSPACE, "MEMORY.md");

// Ensure directories exist
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.mkdirSync(COLLECTIONS_PATH, { recursive: true });

// Create MEMORY.md if it doesn't exist
if (!fs.existsSync(MEMORY_MD_PATH)) {
    fs.writeFileSync(MEMORY_MD_PATH, `# Memory\n\nCurated facts about the user.\n`, "utf-8");
}

// ── Database connection ─────────────────────────────────────────────

export const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");       // safe concurrent access
db.pragma("busy_timeout = 5000");      // wait up to 5s if DB is locked (for Python ingest concurrency)
db.pragma("foreign_keys = ON");

// Load sqlite-vec extension
sqliteVec.load(db);

// ── Schema ──────────────────────────────────────────────────────────

const SCHEMA = `
-- Memory table: stores ALL chunks (conversation + RAG)
CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL CHECK(type IN ('M', 'R')),
    channel     TEXT NOT NULL,
    doc_id      INTEGER REFERENCES documents(doc_id) ON DELETE CASCADE,
    chunk_text  TEXT NOT NULL,
    speaker     TEXT CHECK(speaker IN ('U', 'A') OR speaker IS NULL),
    embedding_status TEXT DEFAULT 'ok' CHECK(embedding_status IN ('ok', 'failed')),
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memory_channel ON memory(channel);
CREATE INDEX IF NOT EXISTS idx_memory_type_channel ON memory(type, channel);
CREATE INDEX IF NOT EXISTS idx_memory_doc_id ON memory(doc_id);
CREATE INDEX IF NOT EXISTS idx_memory_timestamp ON memory(timestamp);

-- Vector embeddings (sqlite-vec)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
    embedding FLOAT[768]
);

-- Documents registry (for RAG)
CREATE TABLE IF NOT EXISTS documents (
    doc_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    collection  TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'pending',
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    chunk_count INTEGER DEFAULT 0,
    UNIQUE(name, collection)
);

-- Rolling summaries (one per channel)
CREATE TABLE IF NOT EXISTS summaries (
    channel     TEXT PRIMARY KEY,
    summary     TEXT NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Pending confirmations (one per interface)
CREATE TABLE IF NOT EXISTS pending_confirmations (
    interface       TEXT PRIMARY KEY,
    tool_name       TEXT NOT NULL,
    tool_params     TEXT NOT NULL,
    prompt_shown    TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Settings (user-configurable)
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

-- Full-text search (BM25)
-- We drop and recreate FTS to ensure it's in sync if we changed something
DROP TABLE IF EXISTS memory_fts;
CREATE VIRTUAL TABLE memory_fts USING fts5(
    chunk_text,
    content='memory',
    content_rowid='id'
);

-- Re-populate FTS from existing memory
INSERT INTO memory_fts(rowid, chunk_text) SELECT id, chunk_text FROM memory;

CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, chunk_text) VALUES('delete', old.id, old.chunk_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, chunk_text) VALUES('delete', old.id, old.chunk_text);
    INSERT INTO memory_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
END;
`;

const DEFAULT_SETTINGS = `
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('recent_messages_limit',               '20'),
    ('summary_update_frequency',            '10'),
    ('semantic_search_top_k',               '5'),
    ('summarization_model',                 'ollama/qwen3:8b'),
    ('vector_weight',                       '0.7'),
    ('bm25_weight',                         '0.3'),
    ('memory_decay_halflife_days',          '90'),
    ('deep_memory_search_token_threshold',  '4000'),
    ('active_channel:tg',                   'D'),
    ('active_channel:owui',                 'D'),
    ('channel_root:Articles',               'collections/Articles');
`;

// Run schema
db.exec(SCHEMA);

// Inline migrations for existing databases
try {
    db.exec(`ALTER TABLE memory ADD COLUMN embedding_status TEXT DEFAULT 'ok' CHECK(embedding_status IN ('ok', 'failed'))`);
} catch (e) {
    // Column likely already exists
}
try {
    // SQLite doesn't support adding UNIQUE constraints directly via ALTER TABLE, 
    // creating a unique index achieves exactly the same effect.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_name_collection ON documents(name, collection)`);
} catch (e) {
    // Index likely already exists
}
try {
    db.exec(`ALTER TABLE documents ADD COLUMN status TEXT DEFAULT 'pending'`);
} catch (e) {
    // Column likely already exists
}

// ── Migration: Upgrade dimension if needed ──────────────────────────
try {
    // Check if current embeddings have a different dimension
    const testRow = db.prepare("SELECT embedding FROM memory_embeddings LIMIT 1").get();
    if (testRow) {
        const buf = (testRow as any).embedding;
        if (buf.length !== 768 * 4) { // Float32 is 4 bytes, BGE-base = 768
            console.log("⚠️ Wrong-dimension embeddings detected. Recreating for BGE-base (768d)...");
            db.exec(`
                DROP TABLE IF EXISTS memory_embeddings;
                CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
                    embedding FLOAT[768]
                );
                DELETE FROM memory;
                DELETE FROM documents;
            `);
        }
    }
} catch (e) {
    // Table might be empty or not yet created, which is fine
}

db.exec(DEFAULT_SETTINGS);

console.log(`🧠 Memory DB initialized at ${DB_PATH} (Dimension: 768)`);

// ── Settings helpers ────────────────────────────────────────────────

const settingsCache = new Map<string, string>();

// Load all settings into cache
db.prepare("SELECT key, value FROM settings").all().forEach((row: any) => {
    settingsCache.set(row.key, row.value);
});

export function getSetting(key: string): string | undefined {
    return settingsCache.get(key);
}

export function getSettingNum(key: string, fallback: number): number {
    const val = settingsCache.get(key);
    return val ? parseInt(val, 10) : fallback;
}

export function updateSetting(key: string, value: string): void {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    settingsCache.set(key, value);
}

/**
 * Returns the list of collections linked to a channel.
 * Always includes the channel's paste collection (p:CHANNEL).
 */
export function getChannelCollections(channel: string): string[] {
    const raw = getSetting(`channel_collections:${channel}`) || "";
    const linked = raw.split(",").map(c => c.trim()).filter(Boolean);
    const pastes = `p:${channel}`;
    return [...new Set([pastes, ...linked])];
}

// ── Embedding dimension constant ────────────────────────────────────

export const EMBEDDING_DIM = 768;
