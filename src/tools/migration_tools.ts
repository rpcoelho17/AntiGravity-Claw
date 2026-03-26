/**
 * tools/migration_tools.ts — Tools for model migration and re-ingestion
 */

import { defineTool } from "./registry.js";
import { checkModelDrift, performMigration } from "../memory/sync.js";
import { savePendingConfirmation } from "../memory/index.js";
import { COLLECTIONS_PATH } from "../memory/db.js";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const propose_model_migration = defineTool({
    name: "propose_model_migration",
    description: "Wipes incompatible embeddings and adapts the database schema for the new model detected in .env. This is Step 1 of the migration process. It does NOT re-index documents.",
    parameters: {
        type: "object",
        properties: {
            confirm: { type: "boolean", description: "Must be true to proceed with the wipe." }
        },
        required: ["confirm"]
    },
    execute: async ({ confirm }) => {
        if (!confirm) return "Migration cancelled by user.";

        const drift = await checkModelDrift();
        if (!drift) return "No model drift detected. Database is already in sync with .env.";

        try {
            performMigration(drift);
            return `✅ Migration successful. Database schema updated for ${drift.model} (${drift.dimension}d). All old embeddings have been cleared.\n\n— would you like to re-ingest all documents in your existing collections now? (yes / no)`;
        } catch (err: any) {
            return `❌ Migration failed: ${err.message}`;
        }
    }
});

import { runIngestion } from "../memory/ingest.js";
import { updateSetting, getSetting } from "../memory/db.js";
import { bot } from "../bot.js";
import { config } from "../config.js";

/** Send a message to all allowed Telegram users (fire-and-forget). */
async function notifyUsers(text: string) {
    for (const userId of config.ALLOWED_USER_IDS) {
        await bot.api.sendMessage(userId, text).catch(() => {});
    }
}

export const propose_reingest_collections = defineTool({
    name: "propose_reingest_collections",
    description: "Iterates through all folders in workspace/collections and re-indexes every document using the current embedding model. This is Step 2 of the migration process, but can also be used independently to refresh data.",
    parameters: {
        type: "object",
        properties: {
            confirm: { type: "boolean", description: "Must be true to proceed with re-ingestion." }
        },
        required: ["confirm"]
    },
    execute: async ({ confirm }) => {
        if (!confirm) return "Re-ingestion cancelled.";

        if (!fs.existsSync(COLLECTIONS_PATH)) return "No collections folder found.";

        const collections = fs.readdirSync(COLLECTIONS_PATH).filter(f => fs.statSync(path.join(COLLECTIONS_PATH, f)).isDirectory());
        
        if (collections.length === 0) return "No collections found to re-ingest.";

        // Count total files for progress tracking
        let totalFileCount = 0;
        for (const col of collections) {
            const colPath = path.join(COLLECTIONS_PATH, col);
            totalFileCount += fs.readdirSync(colPath).filter(f => fs.statSync(path.join(colPath, f)).isFile()).length;
        }

        await notifyUsers(`📂 Starting re-ingestion of ${totalFileCount} files across ${collections.length} collections...`);

        let completedFiles = 0;
        const results: string[] = [];

        // Auto-link collections to Default channel to ensure they are searchable
        const key = "channel_collections:D";
        const current = getSetting(key) || "";
        const linked = new Set(current.split(",").map(c => c.trim()).filter(Boolean));
        
        for (const col of collections) {
            linked.add(col);
            const colPath = path.join(COLLECTIONS_PATH, col);
            const files = fs.readdirSync(colPath).filter(f => fs.statSync(path.join(colPath, f)).isFile());
            
            for (const file of files) {
                const filePath = path.join(colPath, file);
                try {
                    console.log(`🔄 Re-ingesting: ${col}/${file}`);
                    await runIngestion(filePath, col);
                    completedFiles++;
                    await notifyUsers(`✅ [${completedFiles}/${totalFileCount}] ${col}/${file}`);
                } catch (err: any) {
                    console.error(`❌ Failed ${col}/${file}:`, err.message);
                    results.push(`❌ Failed ${col}/${file}: ${err.message}`);
                    await notifyUsers(`❌ [${completedFiles}/${totalFileCount}] Failed: ${col}/${file}`);
                }
            }
        }

        // Save updated links
        updateSetting(key, Array.from(linked).join(","));

        const summary = `✅ Re-ingestion complete! ${completedFiles} files processed across ${collections.length} collections.`;
        await notifyUsers(summary);

        return `${summary} All collections have been linked to the Default channel for immediate access.\n${results.join("\n")}`;
    }
});

import { MEMORY_MD_PATH } from "../memory/db.js";
import { db } from "../memory/db.js";

export const propose_global_reset = defineTool({
    name: "propose_global_reset",
    description: "DANGEROUS: Wipes ALL conversation history, ALL summaries, and ALL document ingestions across ALL channels. Preserves only the 'settings' table.",
    parameters: {
        type: "object",
        properties: {
            confirm: { type: "boolean", description: "Must be true to proceed with the total wipe." }
        },
        required: ["confirm"]
    },
    execute: async ({ confirm }) => {
        if (!confirm) return "Global reset cancelled.";

        try {
            // Re-initialize embedding table to be safe
            const { EMBEDDING_DIM } = await import("../memory/db.js");
            
            db.transaction(() => {
                db.exec(`DELETE FROM memory`);
                db.exec(`DELETE FROM memory_embeddings`);
                db.exec(`DELETE FROM documents`);
                db.exec(`DELETE FROM summaries`);
                db.exec(`DELETE FROM memory_fts`);
            })();
            
            // Reset MEMORY.md too
            if (fs.existsSync(MEMORY_MD_PATH)) {
                fs.writeFileSync(MEMORY_MD_PATH, "# Memory\n\nCurated facts about the user.\n", "utf-8");
            }

            return "✅ GLOBAL RESET COMPLETE. All conversations and document records have been wiped. Settings were preserved.\n\n— would you like to re-ingest your collections now? (yes / no)";
        } catch (err: any) {
            return `❌ Global reset failed: ${err.message}`;
        }
    }
});

export const propose_clear_channel = defineTool({
    name: "propose_clear_channel",
    description: "Wipes conversation history and summaries for a specific channel. Does NOT affect document ingestions or settings.",
    parameters: {
        type: "object",
        properties: {
            confirm: { type: "boolean", description: "Must be true to proceed." },
            channel: { type: "string", description: "The channel ID to clear." }
        },
        required: ["confirm", "channel"]
    },
    execute: async ({ confirm, channel }) => {
        if (!confirm) return "Clear history cancelled.";
        const { clearChannelHistory } = await import("../memory/index.js");
        try {
            await clearChannelHistory(channel);
            return `🧹 **Memory Cleared!**\n\nI have wiped all conversation history and summaries for channel \`${channel}\` from my database.\n\n**Note:** To make it a truly fresh start, you should now also delete the messages in this Telegram chat window.`;
        } catch (err: any) {
            return `❌ Failed to clear history: ${err.message}`;
        }
    }
});

export const propose_change_setting = defineTool({
    name: "propose_change_setting",
    description: "Changes a system setting (e.g., 'summarization_model', 'recent_messages_limit', 'vector_weight').",
    parameters: {
        type: "object",
        properties: {
            key: { type: "string", description: "The setting key to change." },
            value: { type: "string", description: "The new value for the setting." },
            human_description: { type: "string", description: "A friendly description of what this change does." }
        },
        required: ["key", "value", "human_description"]
    },
    execute: async ({ key, value, human_description }) => {
        savePendingConfirmation(
            "tg",
            { tool: "execute_change_setting", params: { key, value, human_description } },
            `Change system setting **${key}** to **${value}**?\n\n*${human_description}*`
        );
        return `❓ I've prepared a setting change: **${key}** → **${value}**. Should I proceed? (Yes/No)`;
    }
});

export const allMigrationTools = [propose_model_migration, propose_reingest_collections, propose_global_reset, propose_clear_channel, propose_change_setting];
