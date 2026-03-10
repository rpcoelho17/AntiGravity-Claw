/**
 * memory/store.ts — Message storage and retrieval
 * 
 * Stores every conversation message with its embedding.
 * Provides retrieval of recent messages for context injection.
 * Handles large paste detection (Section 11 of V4 spec).
 */

import { db, getSetting, getSettingNum, COLLECTIONS_PATH } from "./db.js";
import { embed, embeddingToBuffer } from "./embed.js";
import { runIngestion } from "./ingest.js";
import fs from "fs";
import path from "path";

// ── Token estimation ────────────────────────────────────────────────
// Tuned for English (~1.3 tokens/word) and Portuguese (~1.5 tokens/word).

export function estimateTokens(text: string): number {
    const words = text.split(/\s+/).filter(Boolean).length;
    const ptPattern = /[àáâãçéêíóôõúü]|ção|ções|mente\b|ando\b|endo\b|indo\b/i;
    const multiplier = ptPattern.test(text) ? 1.5 : 1.3;
    return Math.ceil(words * multiplier);
}

// ── Types ───────────────────────────────────────────────────────────

export interface StoredMessage {
    id: number;
    type: "M" | "R";
    channel: string;
    chunk_text: string;
    speaker: "U" | "A";
    timestamp: string;
}

// ── Summary cache ───────────────────────────────────────────────────

export const summaryCache = new Map<string, string>();

// Load existing summaries on startup
db.prepare("SELECT channel, summary FROM summaries").all().forEach((row: any) => {
    summaryCache.set(row.channel, row.summary);
});

export function getSummary(channel: string): string | undefined {
    return summaryCache.get(channel);
}

// ── Message count tracker (for summary trigger) ────────────────────

const messageCounter = new Map<string, number>();

// ── Store a message ─────────────────────────────────────────────────

/**
 * Store a conversation message + its embedding.
 * Returns the memory row id, or 'LARGE_PASTE' if the message was
 * auto-ingested as a paste document (Section 11).
 */
export async function storeMessage(
    channel: string,
    speaker: "U" | "A",
    text: string
): Promise<number | "LARGE_PASTE"> {
    // ── Large paste detection (Section 11) ──────────────────────
    if (speaker === "U") {
        const tokens = estimateTokens(text);
        if (tokens > 8000) {
            try {
                const pasteCollection = `p:${channel}`;
                const pasteDir = path.join(COLLECTIONS_PATH, pasteCollection);
                fs.mkdirSync(pasteDir, { recursive: true });
                const timestamp = Date.now();
                const pasteFile = `paste_${timestamp}.txt`;
                const pastePath = path.join(pasteDir, pasteFile);
                fs.writeFileSync(pastePath, text, "utf-8");

                // Run ingestion pipeline on the paste
                await runIngestion(pastePath, pasteCollection);

                // Store a short reference in memory
                const ref = `[Large paste — collection: ${pasteCollection} — ${pasteFile}]`;
                db.prepare(
                    `INSERT INTO memory (type, channel, doc_id, chunk_text, speaker)
                     VALUES ('M', ?, NULL, ?, 'U')`
                ).run(channel, ref);

                console.log(`📋 Large paste (~${tokens} tokens) auto-ingested to ${pasteCollection}`);
                return "LARGE_PASTE";
            } catch (err) {
                console.warn("⚠️ Large paste ingestion failed, storing as normal message:", err);
                // Fall through to normal storage
            }
        }
    }

    // ── Normal message storage ──────────────────────────────────
    const result = db.prepare(
        `INSERT INTO memory (type, channel, doc_id, chunk_text, speaker)
         VALUES ('M', ?, NULL, ?, ?)`
    ).run(channel, text, speaker);

    const memoryId = Number(result.lastInsertRowid);

    // Generate and store embedding
    try {
        const embedding = await embed(text);
        const buffer = embeddingToBuffer(embedding);
        db.prepare(
            `INSERT INTO memory_embeddings (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`
        ).run(memoryId, buffer);
    } catch (err) {
        console.warn(`⚠️ Embedding failed for message ${memoryId}:`, err);
        db.prepare(
            `UPDATE memory SET embedding_status = 'failed' WHERE id = ?`
        ).run(memoryId);
    }

    // Track message count for summary triggers
    const count = (messageCounter.get(channel) ?? 0) + 1;
    messageCounter.set(channel, count);

    return memoryId;
}

// ── Retrieve recent messages ────────────────────────────────────────

/**
 * Get the last N messages from a channel, ordered oldest-first.
 */
export function getRecentMessages(
    channel: string,
    limit?: number
): StoredMessage[] {
    const n = limit ?? getSettingNum("recent_messages_limit", 20);

    const rows = db.prepare(`
        SELECT id, type, channel, chunk_text, speaker, timestamp
        FROM memory
        WHERE type = 'M' AND channel = ?
        ORDER BY timestamp DESC
        LIMIT ?
    `).all(channel, n) as StoredMessage[];

    // Reverse to get oldest-first (chronological order)
    return rows.reverse();
}

/**
 * Get messages in a specific range (offset from most recent).
 * Used for the summary band (messages 11-30).
 */
export function getMessageRange(
    channel: string,
    start: number,
    end: number
): StoredMessage[] {
    const limit = end - start + 1;
    const offset = start - 1;

    return db.prepare(`
        SELECT id, type, channel, chunk_text, speaker, timestamp
        FROM (
            SELECT id, type, channel, chunk_text, speaker, timestamp
            FROM memory
            WHERE type = 'M' AND channel = ?
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        )
        ORDER BY timestamp ASC
    `).all(channel, limit, offset) as StoredMessage[];
}

/**
 * Get total message count for a channel.
 */
export function getMessageCount(channel: string): number {
    const row = db.prepare(
        `SELECT COUNT(*) as count FROM memory WHERE type = 'M' AND channel = ?`
    ).get(channel) as { count: number };
    return row.count;
}

/**
 * Check if the summary update threshold has been reached.
 */
export function shouldUpdateSummary(channel: string): boolean {
    const freq = getSettingNum("summary_update_frequency", 20);
    const count = messageCounter.get(channel) ?? 0;
    return count >= freq;
}

/**
 * Reset the message counter after a summary update.
 */
export function resetMessageCounter(channel: string): void {
    messageCounter.set(channel, 0);
}

/**
 * Format recent messages as a readable string for the LLM prompt.
 * Translates compact values: U → User, A → Assistant
 */
export function formatRecentMessages(messages: StoredMessage[]): string {
    if (messages.length === 0) return "";

    return messages
        .map(m => {
            const speaker = m.speaker === "U" ? "User" : "Assistant";
            return `${speaker}: ${m.chunk_text}`;
        })
        .join("\n");
}

// ── Sanitization ────────────────────────────────────────────────────

/**
 * Strip injected context markers from LLM responses before storage.
 * Prevents feedback loops where RAG content gets re-stored as "memories".
 */
const INJECTION_MARKERS = [
    /^---\s+Relevant conversation history\s+---\n?/gm,
    /^---\s+Relevant documents\s+---\n?/gm,
    /^## Conversation Summary\n/gm,
    /^## Relevant Context\n/gm,
    /^## Recent Conversation.*\n/gm,
    /^## Active Channel:.*\n/gm,
    /^\[.+? — collection: .+?\]\n?/gm,
    /^\.\.\..*?\.\.\.\n?/gm,
    /^─────\n?/gm,
];

export function sanitizeForStorage(text: string): string {
    let clean = text;
    for (const pattern of INJECTION_MARKERS) {
        clean = clean.replace(pattern, "");
    }
    return clean.trim();
}

// ── Rolling Summary ─────────────────────────────────────────────────

/**
 * Background summarization of the middle band (messages 11-30).
 * Uses Gemini to compress older history.
 * Fire-and-forget — never blocks response delivery.
 */
export async function updateSummary(
    channel: string,
    callSummarizationLLM: (prompt: string) => Promise<string>
): Promise<void> {
    try {
        const recentLimit = getSettingNum("recent_messages_limit", 10);
        const totalMessages = getMessageCount(channel);

        // Only summarize if we have messages beyond the verbatim window
        if (totalMessages <= recentLimit) return;

        // Get messages just beyond the verbatim window up to 20 messages deep
        // (these are the newest unsummarized messages)
        const unsummarized = getMessageRange(channel, recentLimit + 1, recentLimit + 20);
        if (unsummarized.length === 0) return;

        const previousSummary = summaryCache.get(channel);

        const prompt = previousSummary
            ? `You are updating an ongoing conversation summary.
Below is the EXISTING summary of all previous conversation history, followed by
NEW messages that have not yet been incorporated.
Merge the new information into the existing summary. Produce a single cohesive
paragraph. Preserve all important facts, decisions, and user preferences from
the existing summary. Add new information from the recent messages.
Do not repeat anything likely still in the last ${recentLimit} verbatim messages.
Be concise but complete.

EXISTING SUMMARY:
${previousSummary}

NEW MESSAGES:
${unsummarized.map(m => `${m.speaker === "U" ? "User" : "Assistant"}: ${m.chunk_text}`).join("\n")}

Updated summary:`
            : `You are summarizing conversation history beyond the most recent messages.
This summary will be injected into context alongside the last ${recentLimit} verbatim messages,
so do not repeat anything likely still in the recent window.
Focus on: decisions made, facts established, topics covered, user preferences expressed.
Write as a single cohesive paragraph. Be concise but complete.

Messages to summarize:
${unsummarized.map(m => `${m.speaker === "U" ? "User" : "Assistant"}: ${m.chunk_text}`).join("\n")}

Summary:`;

        const newSummary = await callSummarizationLLM(prompt);
        summaryCache.set(channel, newSummary);
        db.prepare(
            `INSERT OR REPLACE INTO summaries (channel, summary, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
        ).run(channel, newSummary);

        console.log(`📝 Summary updated for channel "${channel === "D" ? "Default" : channel}"`);
        resetMessageCounter(channel);
    } catch (err) {
        console.warn("⚠️ Summary update failed (non-blocking):", err);
    }
}

// ── Embedding Retry ──────────────────────────────────────────────────

export async function retryFailedEmbeddings(): Promise<void> {
    const failed = db.prepare(`
        SELECT id, chunk_text FROM memory 
        WHERE type='R' AND embedding_status='failed'
        LIMIT 50
    `).all() as { id: number; chunk_text: string }[];

    if (!failed.length) return;

    try {
        const { embedBatch } = await import("./embed.js");
        const embeddings = await embedBatch(failed.map(f => f.chunk_text));

        const insertVec = db.prepare(`INSERT OR REPLACE INTO memory_embeddings (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`);
        const updateMem = db.prepare(`UPDATE memory SET embedding_status='ok' WHERE id=?`);

        db.transaction(() => {
            for (let i = 0; i < failed.length; i++) {
                insertVec.run(failed[i].id, embeddingToBuffer(embeddings[i]));
                updateMem.run(failed[i].id);
            }
        })();
        console.log(`✅ successfully retried and embedded ${failed.length} chunks`);
    } catch (err) {
        console.error("❌ Failed to retry embeddings:", err);
    }
}
