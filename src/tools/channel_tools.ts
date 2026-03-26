/**
 * tools/channel_tools.ts — Tools for channel and collection management
 */

import { defineTool } from "./registry.js";
import { savePendingConfirmation, db, getChannelCollections } from "../memory/index.js";
import { getSetting } from "../memory/db.js";
import fs from "fs";
import path from "path";

export const propose_switch_channel = defineTool({
    name: "propose_switch_channel",
    description: "Switches the current conversation to a different channel (e.g., 'Articles', 'ProjectX'). Each channel has its own memory and linked collections.",
    parameters: {
        type: "object",
        properties: {
            channel: { type: "string", description: "The name of the channel to switch to." }
        },
        required: ["channel"]
    },
    execute: async ({ channel }) => {
        const current = getSetting("active_channel:tg") ?? "D";
        if (channel === current) return `You are already on the "${channel === 'D' ? 'Default' : channel}" channel.`;

        savePendingConfirmation(
            "tg",
            { tool: "execute_switch_channel", params: { channel } },
            `Switch to the "${channel}" channel?`
        );
        return `❓ I've prepared a switch to the "${channel}" channel. Should I proceed? (Yes/No)`;
    }
});

export const propose_link_collection = defineTool({
    name: "propose_link_collection",
    description: "Links one or more document collections to the current channel so you can search them. Use this if the user asks you to look into a specific directory of documents.",
    parameters: {
        type: "object",
        properties: {
            collections: { 
                type: "array", 
                items: { type: "string" },
                description: "The names of the collections to link (e.g., ['Articles', 'Research'])." 
            }
        },
        required: ["collections"]
    },
    execute: async ({ collections }) => {
        const channel = getSetting("active_channel:tg") ?? "D";
        savePendingConfirmation(
            "tg",
            { tool: "execute_link_collection", params: { channel, collections } },
            `Link the collection(s) "${collections.join(", ")}" to the "${channel === 'D' ? 'Default' : channel}" channel?`
        );
        return `❓ Should I link ${collections.length} collection(s) to this channel? (Yes/No)`;
    }
});

export const propose_unlink_collection = defineTool({
    name: "propose_unlink_collection",
    description: "Unlinks collections from the current channel.",
    parameters: {
        type: "object",
        properties: {
            collections: { 
                type: "array", 
                items: { type: "string" },
                description: "The collection names to unlink." 
            }
        },
        required: ["collections"]
    },
    execute: async ({ collections }) => {
        const channel = getSetting("active_channel:tg") ?? "D";
        savePendingConfirmation(
            "tg",
            { tool: "execute_unlink_collection", params: { channel, collections } },
            `Unlink the collection(s) "${collections.join(", ")}" from the "${channel === 'D' ? 'Default' : channel}" channel?`
        );
        return `❓ Should I unlink these collection(s)? (Yes/No)`;
    }
});

export const propose_rename_channel = defineTool({
    name: "propose_rename_channel",
    description: "Renames the current channel. This updates all memory records for this channel.",
    parameters: {
        type: "object",
        properties: {
            new_name: { type: "string", description: "The new name for the channel." }
        },
        required: ["new_name"]
    },
    execute: async ({ new_name }) => {
        const current = getSetting("active_channel:tg") ?? "D";
        savePendingConfirmation(
            "tg",
            { tool: "execute_rename_channel", params: { current_channel: current, new_name } },
            `Rename the current channel from "${current}" to "${new_name}"?`
        );
        return `❓ Should I rename this channel to "${new_name}"? (Yes/No)`;
    }
});

export const propose_delete_channel = defineTool({
    name: "propose_delete_channel",
    description: "Deletes all conversation history for a channel. Ingested documents are preserved but unlinked.",
    parameters: {
        type: "object",
        properties: {
            channel: { type: "string", description: "The channel to delete." }
        },
        required: ["channel"]
    },
    execute: async ({ channel }) => {
        savePendingConfirmation(
            "tg",
            { tool: "execute_delete_channel", params: { channel } },
            `DELETE all conversation history for the "${channel}" channel? This cannot be undone.`
        );
        return `⚠️ **DANGER**: Should I delete all history for the "${channel}" channel? (Yes/No)`;
    }
});

export const list_collections = defineTool({
    name: "list_collections",
    description: "Lists all available document collections. The result is sent directly to the user — do NOT repeat or rephrase it.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
        const rows = db.prepare("SELECT DISTINCT collection FROM documents ORDER BY collection").all() as { collection: string }[];
        if (rows.length === 0) return "No document collections have been ingested yet.";

        const lines = rows.map(r => `• <i>${r.collection}</i>`);
        const msg = `📂 <b>Available Collections (${rows.length}):</b>\n\n${lines.join("\n")}`;

        // Send directly to all allowed users
        const { bot } = await import("../bot.js");
        const { config } = await import("../config.js");
        for (const userId of config.ALLOWED_USER_IDS) {
            await bot.api.sendMessage(userId, msg, { parse_mode: "HTML" }).catch(() => {});
        }

        return "[DIRECT_SENT]";
    }
});

export const list_documents = defineTool({
    name: "list_documents",
    description: "Lists ALL ingested documents across all collections, showing which ones are linked to the current channel.",
    parameters: {
        type: "object",
        properties: {
            collection: { type: "string", description: "Optional: Only list documents from this specific collection." }
        }
    },
    execute: async ({ collection }) => {
        const channel = getSetting("active_channel:tg") ?? "D";
        const linked = getChannelCollections(channel);
        
        let sql = "SELECT name, collection FROM documents ORDER BY collection, name";
        const params: any[] = [];

        if (collection) {
            sql = "SELECT name, collection FROM documents WHERE collection = ? ORDER BY name";
            params.push(collection);
        }

        const rows = db.prepare(sql).all(...params) as { name: string; collection: string }[];
        if (rows.length === 0) return "No documents have been ingested yet.";

        const lines = rows.map(r => {
            const isLinked = linked.includes(r.collection);
            return `• ${r.name} (_${r.collection}_)${isLinked ? "" : " — ⚠️ Not linked"}`;
        });

        const channelName = channel === "D" ? "Default" : channel;
        return `📄 **All Documents (${rows.length})** — Channel: ${channelName}\n${lines.join("\n")}`;
    }
});

export const get_channel_info = defineTool({
    name: "get_channel_info",
    description: "Displays detailed information about the current channel, including linked collections and project folder.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
        const channel = getSetting("active_channel:tg") ?? "D";
        const linked = getChannelCollections(channel);
        const root = getSetting(`channel_root:${channel}`) || "[Not linked to a project]";
        
        return `📺 **Channel Info: ${channel === 'D' ? 'Default' : channel}**\n` +
               `📂 **Root:** \`${root}\`\n` +
               `🔗 **Linked Collections:** ${linked.join(", ")}`;
    }
});

export const propose_delete_document = defineTool({
    name: "propose_delete_document",
    description: "Deletes a specific document from a collection. Physically removes the file from disk and wipes all indexed segments.",
    parameters: {
        type: "object",
        properties: {
            document_name: { type: "string", description: "The filename of the document (e.g., 'report.pdf')." },
            collection: { type: "string", description: "The collection the document belongs to." }
        },
        required: ["document_name", "collection"]
    },
    execute: async ({ document_name, collection }) => {
        let doc = db.prepare("SELECT doc_id, file_path FROM documents WHERE name = ? AND collection = ?").get(document_name, collection) as { doc_id: number, file_path: string } | undefined;

        let docId = doc?.doc_id ?? -1;
        let filePath = doc?.file_path ?? path.join("collections", collection, document_name);

        const workspace = process.env["ANTIGRAVITY_WORKSPACE"] || path.join(process.cwd(), "workspace");
        const absolutePath = path.resolve(workspace, filePath);

        // If not in DB, check if it at least exists on disk to allow cleanup of orphans
        if (!doc) {
            if (!fs.existsSync(absolutePath)) {
                return `❌ Could not find document "${document_name}" in database or at its expected location on disk.`;
            }
        }

        savePendingConfirmation(
            "tg",
            { tool: "execute_delete_document", params: { doc_id: docId, name: document_name, collection, path: filePath } },
            `⚠️ <b>DELETE DOCUMENT</b>\n\nAre you sure you want to permanently delete <b>${document_name}</b> from the <b>${collection}</b> collection?\n\n<b>Full Path:</b> <code>${absolutePath}</code>\n\nThis will remove the file from disk and wipe all search memory segments for this file.`
        );

        return `❓ I've prepared the deletion of <b>${document_name}</b>.\n\n<b>Target Path:</b> <code>${absolutePath}</code>\n\nShould I proceed? (Yes/No)`;
    }
});

export const allChannelTools = [
    propose_switch_channel,
    propose_link_collection,
    propose_unlink_collection,
    propose_rename_channel,
    propose_delete_channel,
    propose_delete_document,
    list_collections,
    list_documents,
    get_channel_info
];
