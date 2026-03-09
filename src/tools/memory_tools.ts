import type { ToolDefinition } from "./registry.js";
import { savePendingConfirmation } from "../memory/confirm.js";
import { db, getSetting } from "../memory/db.js";
import { deepMemorySearch } from "../memory/deep-search.js";

// ── CHANNEL MANAGEMENT ────────────────────────────────────────

export const proposeSwitchChannelTool: ToolDefinition = {
    spec: {
        name: "propose_switch_channel",
        description: "Propose switching to a different conversation channel, or creating a new one. Always call this tool when the user wants to change channels — never execute the switch directly.",
        parameters: {
            type: "object",
            properties: {
                channel: {
                    type: "string",
                    description: "The channel name to switch to. If it does not exist, it will be created."
                },
                interface: { type: "string", enum: ["tg", "owui"] }
            },
            required: ["channel", "interface"]
        }
    },
    execute: async (params: any) => {
        const targetChannel = params.channel.toLowerCase() === "default" ? "D" : params.channel;
        const displayChannel = targetChannel === "D" ? "Default" : targetChannel;
        const action = { tool: "execute_switch_channel", params: { ...params, channel: targetChannel } };
        const prompt = `You want me to switch to the "${displayChannel}" channel — is that correct? (yes / no)`;
        savePendingConfirmation(params.interface, action, prompt);
        return prompt;
    }
};

export const proposeRenameChannelTool: ToolDefinition = {
    spec: {
        name: "propose_rename_channel",
        description: "Propose renaming the current channel. Always call this tool — never rename directly.",
        parameters: {
            type: "object",
            properties: {
                new_name: { type: "string" },
                current_channel: { type: "string" },
                interface: { type: "string", enum: ["tg", "owui"] }
            },
            required: ["new_name", "current_channel", "interface"]
        }
    },
    execute: async (params: any) => {
        const action = { tool: "execute_rename_channel", params };
        const prompt = `You want me to rename the "${params.current_channel}" channel to "${params.new_name}" — is that correct? (yes / no)`;
        savePendingConfirmation(params.interface, action, prompt);
        return prompt;
    }
};

export const proposeSyncChannelsTool: ToolDefinition = {
    spec: {
        name: "propose_sync_channels",
        description: "Propose syncing one interface to the active channel of another interface (e.g., make tg match owui).",
        parameters: {
            type: "object",
            properties: {
                from_interface: { type: "string", enum: ["tg", "owui"] },
                to_interface: { type: "string", enum: ["tg", "owui"] }
            },
            required: ["from_interface", "to_interface"]
        }
    },
    execute: async (params: any) => {
        const fromChannel = getSetting(`active_channel:${params.from_interface}`) ?? "D";
        const action = { tool: "execute_sync_channels", params };
        const prompt = `You want me to switch ${params.to_interface} to match ${params.from_interface} (which is on the "${fromChannel}" channel) — is that correct? (yes / no)`;
        savePendingConfirmation(params.to_interface, action, prompt);
        return prompt;
    }
};

export const proposeDeleteChannelTool: ToolDefinition = {
    spec: {
        name: "propose_delete_channel",
        description: "Propose deleting a channel. Its messages are deleted forever, but its collections are reassigned to the 'Default' channel. The 'Default' channel itself cannot be deleted.",
        parameters: {
            type: "object",
            properties: {
                channel: { type: "string", description: "The name of the channel to delete." },
                interface: { type: "string", enum: ["tg", "owui"] }
            },
            required: ["channel", "interface"]
        }
    },
    execute: async (params: any) => {
        const ch = params.channel;
        if (ch === "D" || ch.toLowerCase() === "default") {
            return `I cannot delete the Default channel.`;
        }

        const msgCount = db.prepare("SELECT COUNT(*) as c FROM memory WHERE type='M' AND channel=?").get(ch) as { c: number };
        const colCountStr = db.prepare("SELECT COUNT(DISTINCT collection) as c FROM documents WHERE collection IN (SELECT REPLACE(key, 'active_channel:', '') FROM settings WHERE value=?)")
        // Actually, collections don't belong to channels natively, but RAG chunks do.
        // Let's just find memory type='R' count for this channel
        // The spec says "2 collection(s) will be reassigned".
        // Since collections themselves don't have a channel (chunks do), let's just count chunks.
        // Or count distinct documents mapped to chunks in this channel.
        const chunkCount = db.prepare("SELECT COUNT(*) as c FROM memory WHERE type='R' AND channel=?").get(ch) as { c: number };

        const action = { tool: "execute_delete_channel", params };
        const prompt = `You want me to delete the "${ch}" channel (${msgCount.c} messages will be permanently removed). ${chunkCount.c} chunk(s) will be reassigned to the Default channel. Is that correct? (yes / no)`;
        savePendingConfirmation(params.interface, action, prompt);
        return prompt;
    }
};

// ── READ-ONLY TOOLS ───────────────────────────────────────────

export const listChannelsTool: ToolDefinition = {
    spec: {
        name: "list_channels",
        description: "Returns a list of all channels that have memory.",
        parameters: { type: "object", properties: {} }
    },
    execute: async () => {
        const rows = db.prepare("SELECT DISTINCT channel FROM memory ORDER BY channel").all() as { channel: string }[];
        const channels = rows.map(r => r.channel === "D" ? "Default" : r.channel);
        return JSON.stringify([...new Set(channels)]);
    }
};

export const getCurrentChannelTool: ToolDefinition = {
    spec: {
        name: "get_current_channel",
        description: "Returns the current active channel for a given interface.",
        parameters: {
            type: "object",
            properties: {
                interface: { type: "string", enum: ["tg", "owui"] }
            },
            required: ["interface"]
        }
    },
    execute: async (params: any) => {
        const ch = getSetting(`active_channel:${params.interface}`) ?? "D";
        const displayChannel = ch === "D" ? "Default" : ch;
        return `The active channel for ${params.interface} is: ${displayChannel}`;
    }
};

export const listCollectionsTool: ToolDefinition = {
    spec: {
        name: "list_collections",
        description: "Returns a list of all collections with their document counts.",
        parameters: { type: "object", properties: {} }
    },
    execute: async () => {
        const rows = db.prepare(`
            SELECT collection, COUNT(*) as doc_count 
            FROM documents 
            GROUP BY collection
        `).all();
        return JSON.stringify(rows);
    }
};

// ── SETTINGS & COLLECTIONS ─────────────────────────────────────────

export const proposeChangeSettingTool: ToolDefinition = {
    spec: {
        name: "propose_change_setting",
        description: "Propose changing a memory system setting (e.g., recent_messages_limit, memory_decay_halflife_days, summarization_model).",
        parameters: {
            type: "object",
            properties: {
                key: { type: "string" },
                value: { type: "string" },
                human_description: { type: "string", description: "What to tell the user we are doing in the confirmation prompt." },
                interface: { type: "string", enum: ["tg", "owui"] }
            },
            required: ["key", "value", "human_description", "interface"]
        }
    },
    execute: async (params: any) => {
        const action = { tool: "execute_change_setting", params };
        const prompt = `You want me to ${params.human_description} — is that correct? (yes / no)`;
        savePendingConfirmation(params.interface, action, prompt);
        return prompt;
    }
};

export const proposeDeleteCollectionTool: ToolDefinition = {
    spec: {
        name: "propose_delete_collection",
        description: "Propose deleting a document collection and all its embedded chunks. This removes the documents from all channels.",
        parameters: {
            type: "object",
            properties: {
                collection: { type: "string" },
                interface: { type: "string", enum: ["tg", "owui"] }
            },
            required: ["collection", "interface"]
        }
    },
    execute: async (params: any) => {
        const col = params.collection;
        const msgCount = db.prepare("SELECT COUNT(*) as c FROM documents WHERE collection=?").get(col) as { c: number };

        const action = { tool: "execute_delete_collection", params };
        const prompt = `You want me to delete the "${col}" collection (${msgCount.c} document(s) and all indexed chunks will be permanently removed). Is that correct? (yes / no)`;
        savePendingConfirmation(params.interface, action, prompt);
        return prompt;
    }
};

// ── DEEP MEMORY SEARCH ─────────────────────────────────────────

export const deepMemorySearchTool: ToolDefinition = {
    spec: {
        name: "deep_memory_search",
        description: `Perform exhaustive research across ALL document collections ingested in the current channel. Use when the user asks for comprehensive, cross-document analysis of a topic.
Primary trigger phrase: "do a deep memory search about/for/on X".
Also triggers on: "search all my documents for", "compare all my sources on",
"what do all my books say about", "find everywhere X is mentioned".
Do NOT use for regular conversational questions — use only when the user explicitly wants exhaustive cross-collection coverage.
Do NOT use for internet or web searches — this searches only ingested local documents.
Returns per-collection findings which you must synthesize into a coherent answer.`,
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The research question or concept to investigate across all collections."
                },
                top_k_per_collection: {
                    type: "number",
                    description: "Number of results to retrieve per collection. Default 5. Increase for broader coverage on dense topics."
                }
            },
            required: ["query"]
        }
    },
    execute: async (params: any) => {
        const channel = getSetting("active_channel:tg") ?? "D";
        return deepMemorySearch(params.query, params.top_k_per_collection ?? 5, channel);
    }
};

export const allMemoryTools = [
    proposeSwitchChannelTool,
    proposeRenameChannelTool,
    proposeSyncChannelsTool,
    proposeDeleteChannelTool,
    listChannelsTool,
    getCurrentChannelTool,
    listCollectionsTool,
    proposeChangeSettingTool,
    proposeDeleteCollectionTool,
    deepMemorySearchTool,
];
