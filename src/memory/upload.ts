/**
 * memory/upload.ts — File upload handling for Telegram
 * 
 * Manages pending upload state, collection selection via inline keyboard,
 * and triggers the ingestion pipeline.
 * Spec Section 13: File Upload Flow.
 */

import path from "path";
import fs from "fs";
import { COLLECTIONS_PATH, db } from "./db.js";
import { runIngestion } from "./ingest.js";

// ── Pending upload state ────────────────────────────────────────────

interface PendingUpload {
    filePath: string;
    fileName: string;
}

const pendingUploads = new Map<number, PendingUpload>();
const awaitingNewCollection = new Map<number, PendingUpload>();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Store a downloaded file as a pending upload and return collection choices.
 * The caller (bot.ts) should present these as inline keyboard buttons.
 */
export function registerPendingUpload(chatId: number, filePath: string, fileName: string): void {
    pendingUploads.set(chatId, { filePath, fileName });
}

/**
 * Get existing non-paste collections for the collection picker.
 */
export function getCollectionChoices(): string[] {
    const rows = db.prepare(
        `SELECT DISTINCT collection FROM documents WHERE collection NOT LIKE 'p:%'`
    ).all() as { collection: string }[];
    return rows.map(r => r.collection);
}

/**
 * Handle a collection selection callback (e.g. "ingest:work").
 * Returns a status message.
 */
export async function handleIngestCallback(
    chatId: number,
    callbackData: string
): Promise<{ action: "new_collection" | "ingesting" | "no_pending"; message: string }> {
    const pending = pendingUploads.get(chatId);
    if (!pending) {
        return { action: "no_pending", message: "No pending upload found." };
    }

    if (callbackData === "ingest:__new__") {
        awaitingNewCollection.set(chatId, pending);
        pendingUploads.delete(chatId);
        return { action: "new_collection", message: "What would you like to call the new collection?" };
    }

    const collection = callbackData.replace("ingest:", "");
    pendingUploads.delete(chatId);

    const result = await performIngestion(pending.filePath, pending.fileName, collection);
    return { action: "ingesting", message: result };
}

/**
 * Check if a text message is a new collection name reply.
 * Returns the ingestion result if it was, null otherwise.
 */
export async function handleNewCollectionName(
    chatId: number,
    text: string
): Promise<string | null> {
    const pending = awaitingNewCollection.get(chatId);
    if (!pending) return null;

    awaitingNewCollection.delete(chatId);
    const collection = text.trim().replace(/\s+/g, "_").toLowerCase();
    return performIngestion(pending.filePath, pending.fileName, collection);
}

// ── Internal ────────────────────────────────────────────────────────

async function performIngestion(
    tmpPath: string,
    fileName: string,
    collection: string
): Promise<string> {
    const destDir = path.join(COLLECTIONS_PATH, collection);
    const destPath = path.join(destDir, fileName);
    fs.mkdirSync(destDir, { recursive: true });

    // Move file from temp to collections
    if (tmpPath !== destPath) {
        fs.copyFileSync(tmpPath, destPath);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }

    const result = await runIngestion(destPath, collection);
    return `✅ ${result}`;
}

/**
 * Helper to chunk an array into sub-arrays of a given size.
 */
export function chunkArray<T>(arr: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
        arr.slice(i * size, i * size + size));
}
