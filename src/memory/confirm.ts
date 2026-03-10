import { db, updateSetting, getSetting } from "./db.js";

export interface PendingConfirmation {
    interface: string;
    tool_name: string;
    tool_params: string;
    prompt_shown: string;
    created_at: string;
}

export function savePendingConfirmation(
    iface: string,
    action: { tool: string; params: any },
    prompt: string
) {
    db.prepare(
        `INSERT OR REPLACE INTO pending_confirmations 
    (interface, tool_name, tool_params, prompt_shown) 
    VALUES (?, ?, ?, ?)`
    ).run(iface, action.tool, JSON.stringify(action.params), prompt);
}

export function getPendingConfirmation(iface: string): PendingConfirmation | null {
    const row = db.prepare(
        `SELECT * FROM pending_confirmations WHERE interface = ?`
    ).get(iface) as PendingConfirmation | null;

    if (!row) return null;

    // Check expiry (5 minutes)
    const ageMs = Date.now() - new Date(row.created_at + "Z").getTime();
    if (ageMs > 5 * 60 * 1000) {
        clearPendingConfirmation(iface);
        return null;
    }

    return row;
}

export function clearPendingConfirmation(iface: string) {
    db.prepare(`DELETE FROM pending_confirmations WHERE interface = ?`).run(iface);
}

export async function handleConfirmation(
    iface: string,
    userText: string
): Promise<string | null> {
    const pending = getPendingConfirmation(iface);
    if (!pending) return null; // No action pending

    const text = userText.trim().toLowerCase();

    // Detect affirmative responses
    const isYes = /^(yes|y|yeah|yep|correct|confirm|ok|okay|sure|do it|go ahead|affirmative)$/i.test(text);

    // Detect negative responses
    const isNo = /^(no|n|nope|cancel|stop|abort|negative|don't|dont|never mind|nevermind)$/i.test(text);

    if (!isYes && !isNo) {
        // Ambiguous response — re-show the confirmation prompt
        return `I didn't catch that. ${pending.prompt_shown}`;
    }

    clearPendingConfirmation(iface);

    if (isNo) {
        return `Got it — cancelled. The action was not performed.`;
    }

    // Execute the confirmed action
    return executeConfirmedAction(pending.tool_name, JSON.parse(pending.tool_params), iface);
}

async function executeConfirmedAction(
    toolName: string,
    params: Record<string, unknown>,
    iface: string
): Promise<string> {
    switch (toolName) {
        case "execute_switch_channel": {
            const channel = params.channel as string;
            updateSetting(`active_channel:${iface}`, channel);

            let response = `Done — switched to the "${channel}" channel.`;

            // Proactive instructions if it's a RAG channel
            const root = getSetting(`channel_root:${channel}`);
            if (root) {
                response += `\n\n📂 **Channel Tip:** This channel is linked to \`${root}\`. 
You can upload PDF or Text files here to index them! 
• To add to a specific collection, type the name (e.g., 'Research') in the **Caption** before sending.
• Leave it blank to use the default collection.`;
            }

            return response;
        }
        case "execute_rename_channel": {
            db.prepare("UPDATE memory SET channel=? WHERE channel=?").run(
                params.new_name,
                params.current_channel
            );
            db.prepare("UPDATE summaries SET channel=? WHERE channel=?").run(
                params.new_name,
                params.current_channel
            );
            updateSetting(`active_channel:${iface}`, params.new_name as string);
            return `Done — channel renamed to "${params.new_name}".`;
        }
        case "execute_sync_channels": {
            const fromChannel = getSetting(`active_channel:${params.from_interface}`) ?? "D";
            updateSetting(`active_channel:${params.to_interface}`, fromChannel);
            return `Done — ${params.to_interface} is now on the "${fromChannel}" channel.`;
        }
        case "execute_change_setting": {
            updateSetting(params.key as string, params.value as string);
            return `Done — ${params.human_description}.`;
        }
        case "execute_delete_channel": {
            const ch = params.channel as string;
            // Delete conversation messages only
            db.prepare("DELETE FROM memory WHERE type='M' AND channel=?").run(ch);
            // Reassign any RAG chunks in this channel to Default
            db.prepare("UPDATE memory SET channel='D' WHERE type='R' AND channel=?").run(ch);
            // Clean up summary
            db.prepare("DELETE FROM summaries WHERE channel=?").run(ch);
            // Clean up per-channel settings
            db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`%:${ch}`);
            // Switch user to default channel
            updateSetting(`active_channel:${iface}`, "D");
            return `Done — deleted the "${ch}" channel. Collections have been reassigned to the Default channel. You are now on the Default channel.`;
        }
        case "execute_delete_collection": {
            const col = params.collection as string;
            // CASCADE delete: removing documents will cascade-delete memory rows (type='R')
            // which also removes their embeddings
            db.prepare("DELETE FROM documents WHERE collection=?").run(col);
            return `Done — deleted the "${col}" collection and all its indexed chunks.`;
        }
        case "execute_link_collection": {
            const colsToProcess: string[] = params.collections ? (params.collections as string[]) : [params.collection as string];
            const ch = params.channel as string;
            const key = `channel_collections:${ch}`;
            const current = getSetting(key) || "";
            const collections = current.split(",").map(c => c.trim()).filter(Boolean);
            
            const newlyLinked: string[] = [];
            const alreadyLinked: string[] = [];

            for (const col of colsToProcess) {
                if (collections.includes(col)) {
                    alreadyLinked.push(col);
                } else {
                    collections.push(col);
                    newlyLinked.push(col);
                }
            }
            
            if (newlyLinked.length > 0) {
                updateSetting(key, collections.join(","));
            }

            let msg = "";
            if (newlyLinked.length > 0) {
                msg += `Done — linked the "${newlyLinked.join(", ")}" collection(s) to the "${ch === 'D' ? 'Default' : ch}" channel. `;
            }
            if (alreadyLinked.length > 0) {
                msg += `The "${alreadyLinked.join(", ")}" collection(s) were already linked.`;
            }
            return msg.trim() || `No collections were linked.`;
        }
        case "execute_unlink_collection": {
            const colsToProcess: string[] = params.collections ? (params.collections as string[]) : [params.collection as string];
            const ch = params.channel as string;
            const key = `channel_collections:${ch}`;
            const current = getSetting(key) || "";
            const collections = current.split(",").map(c => c.trim()).filter(Boolean);
            
            const unlinked: string[] = [];
            const notLinked: string[] = [];

            for (const col of colsToProcess) {
                if (!collections.includes(col)) {
                    notLinked.push(col);
                } else {
                    unlinked.push(col);
                    // Remove from array
                    const idx = collections.indexOf(col);
                    if (idx > -1) collections.splice(idx, 1);
                }
            }
            
            if (unlinked.length > 0) {
                updateSetting(key, collections.join(","));
            }

            let msg = "";
            if (unlinked.length > 0) {
                msg += `Done — unlinked the "${unlinked.join(", ")}" collection(s) from the "${ch === 'D' ? 'Default' : ch}" channel. `;
            }
            if (notLinked.length > 0) {
                msg += `The "${notLinked.join(", ")}" collection(s) were not linked.`;
            }
            return msg.trim() || `No collections were unlinked.`;
        }
        default:
            return `Unknown action: ${toolName}`;
    }
}
