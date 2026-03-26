import { Bot, InputFile, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { runAgentLoop, EMBED_WAIT_MESSAGE } from "./agent.js";
import { transcribeAudio, generateSpeech } from "./services/audio.js";
import { db, getSetting, savePendingConfirmation, getChannelCollections } from "./memory/index.js";
import fs from "fs";
import path from "path";

/**
 * Escapes characters for Telegram HTML mode.
 */
function escapeHTML(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}


// ── Create bot ──────────────────────────────────────────────────────

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// ── Security middleware — user ID whitelist ──────────────────────────

bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof Error) {
        console.error("Error in bot.catch:", e.message);
    } else {
        console.error("Unknown error in bot.catch:", e);
    }
});

bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;

    // Silently ignore all messages from non-whitelisted users
    if (!userId || !config.ALLOWED_USER_IDS.includes(userId)) {
        return; // No response, no error — silent drop
    }

    await next();
});

// ── Utilities ───────────────────────────────────────────────────────

/**
 * Runs the agent loop, but if it returns the "wait" message,
 * it polls until ready and then re-runs for the final answer.
 */
async function runAgentWithRetry(ctx: any, message: string): Promise<string> {
    const { isLocalEmbeddingAvailable } = await import("./memory/embed.js");

    // 1. INSTANT CHECK: If not ready, tell them immediately
    if (!(await isLocalEmbeddingAvailable())) {
        await ctx.reply(EMBED_WAIT_MESSAGE);
        
        // 2. WAIT: Poll until ready
        let attempts = 0;
        while (!(await isLocalEmbeddingAvailable()) && attempts < 60) {
            await new Promise(r => setTimeout(r, 1000)); // Faster polling for better UX
            attempts++;
        }
    }

    // 3. ANSWER: Proceed to agent loop
    return await runAgentLoop(message);
}

// ── Commands ────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
    const userName = ctx.from?.first_name ?? "User";
    const welcome = `Greetings, <b>${escapeHTML(userName)}</b>! I am <b>Gravity Claw</b> 🦀

I am your personal AI agent. I can remember our conversations, search through your documents, and even help you code.

<b>Getting Started:</b>
• Just type a message to start chatting!
• Upload a document to index it into your memory.
• Use <code>/clear</code> if you want to wipe my memory of this channel and start fresh.

<b>Current Status:</b>
• Channel: <code>${escapeHTML(getSetting("active_channel:tg") ?? "Default")}</code>
• Memory: <code>${await import("./memory/index.js").then(m => m.getMessageCount(getSetting("active_channel:tg") ?? "D"))}</code> messages stored.

How can I help you today?`;

    await ctx.reply(welcome, { parse_mode: "HTML" });
});

bot.command("clear", async (ctx) => {
    const channel = getSetting("active_channel:tg") ?? "D";
    const { savePendingConfirmation } = await import("./memory/index.js");

    savePendingConfirmation(
        "tg",
        { tool: "propose_clear_channel", params: { confirm: true, channel } },
        `🧹 <b>Clear History Request</b>\n\nAre you sure you want to wipe all conversation history and summaries for this channel (<code>${escapeHTML(channel === "D" ? "Default" : channel)}</code>)?\n\nThis cannot be undone.`
    );

    await ctx.reply("🧹 <b>CLEAR CHANNEL REQUESTED</b>\n\nI've prepared a history wipe for this channel.\n\n<b>Are you sure?</b> Respond with <b>yes</b> or <b>no</b>.", { parse_mode: "HTML" });
});

bot.command("global_reset", async (ctx) => {
    const { savePendingConfirmation } = await import("./memory/index.js");
    
    savePendingConfirmation(
        "tg",
        { tool: "propose_global_reset", params: { confirm: true } },
        "⚠️ <b>TOTAL SYSTEM WIPE REQUESTED</b>\n\nThis will delete ALL conversations, ALL document records, and ALL summaries across ALL channels.\n\nOnly your API settings and .env will remain. <b>Are you absolutely sure you want to proceed?</b> (yes / no)"
    );

    await ctx.reply("⚠️ <b>GLOBAL RESET REQUESTED</b>\n\nI've prepared a total system wipe. This is a destructive action.\n\n<b>Are you absolutely sure?</b> Respond with <b>yes</b> or <b>no</b>.", { parse_mode: "HTML" });
});

bot.command("help", async (ctx) => {
    const helpMessage = `🦀 **Gravity Claw - Help Guide**

**Slash Commands:**
• \`/start\` - Welcome message and current bot status.
• \`/help\` - Show this help guide.
• \`/settings\` - View current system settings and configuration.
• \`/documents\` - List all ingested documents and their link status.
• \`/collections\` - List all document collections.
• \`/clear\` - Wipe history for the **current** channel (requires confirmation).
• \`/global_reset\` - Wipe **everything** (history, docs, segments) across all channels (requires confirmation).

**Voice / Natural Language Examples:**
You can talk to me naturally or send voice messages. Try:
• _"Which channel am I on?"_
• _"List my collections."_
• _"Create a new channel named Research."_
• _"Switch to the Articles channel."_
• _"Link the 'Papers' collection to this channel."_
• _"Delete the document study.pdf from the Default collection."_
• _"What do you remember about our last conversation?"_

💡 **Tip:** To see which settings you can change, use the \`/settings\` command.`;

    await ctx.reply(helpMessage, { parse_mode: "Markdown" });
});

bot.command("settings", async (ctx) => {
    const settings = db.prepare("SELECT key, value FROM settings ORDER BY key ASC").all() as { key: string, value: string }[];
    
    if (settings.length === 0) {
        await ctx.reply("System settings are empty.");
        return;
    }

    let table = "| Setting | Value |\n| :--- | :--- |\n";
    settings.forEach(s => {
        table += `| <code>${escapeHTML(s.key)}</code> | <code>${escapeHTML(s.value)}</code> |\n`;
    });

    const examples = `🛠️ <b>System Settings</b>\n` +
        `Below is the list of current bot settings. You can change these by speaking or typing to me.\n\n` +
        `<pre>${table}</pre>\n` +
        `<b>Voice Command Examples:</b>\n` +
        `• <i>"Change <b>summarization_model</b> to <b>arcee-ai/trinity-large-preview:free</b>"</i>\n` +
        `• <i>"Set <b>vector_weight</b> to <b>0.8</b>"</i>\n` +
        `• <i>"Update <b>recent_messages_limit</b> to <b>10</b>"</i>`;

    await ctx.reply(examples, { parse_mode: "HTML" });
});

bot.command("documents", async (ctx) => {
    const channel = getSetting("active_channel:tg") ?? "D";
    const channelName = channel === "D" ? "Default" : channel;

    // Get linked collections for this channel
    const { getChannelCollections } = await import("./memory/index.js");
    const linked = getChannelCollections(channel);

    const rows = db.prepare("SELECT name, collection FROM documents ORDER BY collection, name").all() as { name: string; collection: string }[];

    if (rows.length === 0) {
        await ctx.reply("📄 No documents have been ingested yet.");
        return;
    }

    const lines = rows.map(r => {
        const isLinked = linked.includes(r.collection);
        return `• <b>${escapeHTML(r.name)}</b> (<i>${escapeHTML(r.collection)}</i>)${isLinked ? "" : " — ⚠️ <i>Not linked</i>"}`;
    });

    const msg = `📄 <b>All Documents (${rows.length})</b> — Channel: <b>${escapeHTML(channelName)}</b>\n\n${lines.join("\n")}`;
    await ctx.reply(msg, { parse_mode: "HTML" });
});

bot.command("collections", async (ctx) => {
    const rows = db.prepare("SELECT DISTINCT collection FROM documents ORDER BY collection").all() as { collection: string }[];
    
    if (rows.length === 0) {
        await ctx.reply("📂 No document collections have been ingested yet.");
        return;
    }

    const lines = rows.map(r => `• <i>${escapeHTML(r.collection)}</i>`);
    await ctx.reply(`📂 <b>Available Collections (${rows.length}):</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

// ── Message handler ─────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
    const userMessage = ctx.message.text;
    const userName = ctx.from.first_name ?? "User";

    console.log(`💬 ${userName} (${ctx.from.id}): ${userMessage}`);

    // Show "typing..." indicator while processing, but don't await it
    // because Telegram endpoints can sometimes hang or fail, and we
    // don't want to block the actual agent loop.
    ctx.replyWithChatAction("typing").catch(e => console.error("Could not send chat action:", e.message));

    try {
        const response = await runAgentWithRetry(ctx, userMessage);

        // Skip if tool already sent the message directly (DIRECT_SENT path)
        if (!response || response.trim() === "") {
            return;
        }

        try {
            // Telegram has a 4096 char message limit — split if needed
            if (response.length <= 4096) {
                await ctx.reply(response, { parse_mode: "HTML" });
            } else {
                // Split into chunks, respecting the limit
                const chunks = splitMessage(response, 4096);
                for (const chunk of chunks) {
                    await ctx.reply(chunk, { parse_mode: "HTML" });
                }
            }
        } catch (replyErr) {
            console.error("❌ Agent reply error (maybe HTML issue?):", replyErr);
            await ctx.reply(response); // Fallback to plain text
        }
    } catch (err) {
        console.error("❌ Agent error:", err);
        await ctx.reply("Sorry, something went wrong processing your message.");
    }
});

// ── Voice Message Handler ───────────────────────────────────────────

bot.on("message:voice", async (ctx) => {
    const userName = ctx.from.first_name ?? "User";
    console.log(`🎙️ Voice message from ${userName} (${ctx.from.id})`);

    ctx.replyWithChatAction("typing").catch(e => console.error("Could not send chat action:", e.message));

    try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        
        if (!response.ok) throw new Error(`Failed to fetch voice: ${response.statusText}`);

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 1. Transcribe
        const transcription = await transcribeAudio(buffer);
        console.log(`📝 Transcribed: "${transcription}"`);
        
        // Reply directly to the user's voice message so it links contextually to their bubble
        await ctx.reply(`<i>“${escapeHTML(transcription)}”</i>`, { 
            parse_mode: "HTML",
            reply_parameters: { message_id: ctx.message.message_id }
        });

        // 2. Process through agent
        const agentResponse = await runAgentWithRetry(ctx, transcription);

        // 3. Send text in italics first
        try {
            await ctx.reply(`<i>${agentResponse}</i>`, { parse_mode: "HTML" });
        } catch {
            await ctx.reply(agentResponse);
        }

        // 4. Convert response to speech
        try {
            const speechBuffer = await generateSpeech(agentResponse);
            await ctx.replyWithVoice(new InputFile(speechBuffer, "response.voice"));
        } catch (ttsErr) {
            console.error("❌ TTS error:", ttsErr);
            await ctx.reply(`_${agentResponse}_`, { parse_mode: "Markdown" });
        }

    } catch (err: any) {
        console.error("❌ Voice handler error:", err);
        await ctx.reply(`Sorry, I couldn't process your voice message: ${err.message}`);
    }
});

// ── Document Handler ───────────────────────────────────────────────

bot.on("message:document", async (ctx) => {
    const userName = ctx.from.first_name ?? "User";
    const doc = ctx.message.document;
    const caption = ctx.message.caption?.trim(); // Use caption as collection name if provided
    const channel = getSetting("active_channel:tg") ?? "D";

    // Use caption if available, otherwise default to channel/Articles
    const collection = caption || (channel === "D" ? "Default" : channel);

    console.log(`📄 ${userName} (${ctx.from.id}) uploaded document: ${doc.file_name} to collection: ${collection}`);

    ctx.replyWithChatAction("upload_document").catch(e => console.error("Could not send chat action:", e.message));

    try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Failed to fetch document: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // If no caption, ask for collection via buttons
        if (!caption) {
            const kb = new InlineKeyboard()
                .text(`Active Channel (${channel === "D" ? "Default" : channel})`, `doc_ingest:${doc.file_name}:${channel === "D" ? "Default" : channel}`)
                .text("Articles Collection", `doc_ingest:${doc.file_name}:Articles`)
                .row()
                .text("❌ Cancel", "doc_cancel");

            // Store the buffer temporarily in memory or disk (using path for simplicity)
            const tempDir = path.join(process.cwd(), "workspace", "temp_uploads");
            fs.mkdirSync(tempDir, { recursive: true });
            const tempPath = path.join(tempDir, doc.file_name || "unnamed_doc");
            fs.writeFileSync(tempPath, buffer);

            await ctx.reply(`❓ I've received "${doc.file_name}". In which collection should I store it?`, {
                reply_markup: kb
            });
            return;
        }

        // Direct ingestion (when caption is provided)
        const collectionDir = path.join(process.cwd(), "workspace", "collections", collection);
        fs.mkdirSync(collectionDir, { recursive: true });

        const localPath = path.join(collectionDir, doc.file_name || "unnamed_doc");
        fs.writeFileSync(localPath, buffer);

        await ctx.reply(`💾 Received "${doc.file_name}". Ingesting into "${collection}" collection...`);

        // Trigger ingestion asynchronously with progress updates
        const { runIngestion } = await import("./memory/index.js");
        
        let lastProgressMsg = "";
        const onProgress = async (msg: string) => {
            if (msg !== lastProgressMsg) {
                lastProgressMsg = msg;
                await ctx.reply(msg).catch(() => {});
            }
        };

        runIngestion(localPath, collection, onProgress).then(async (result) => {
            console.log(`✅ Ingestion result: ${result}`);
            const channel = getSetting("active_channel:tg") ?? "D";
            const linkedCollections = getChannelCollections(channel);

            if (!linkedCollections.includes(collection)) {
                savePendingConfirmation(
                    "tg",
                    { tool: "execute_link_collection", params: { channel, collection } },
                    `Would you like to link the collection '${collection}' to this channel?`
                );
                await ctx.reply(`✅ Ingestion complete: "${doc.file_name}"\n\nSuccessfully indexed into the "${collection}" collection.\n\n❓ Would you like to link the collection '${collection}' to this channel?`);
            } else {
                await ctx.reply(`✅ Ingestion complete: "${doc.file_name}"\n\nSuccessfully indexed into the "${collection}" collection.`);
            }
        }).catch(async (err) => {
            console.error("❌ Ingestion error:", err);
            await ctx.reply(`❌ Ingestion failed for \`${doc.file_name}\`: ${err.message}`);
        });

    } catch (err: any) {
        console.error("❌ Agent document error:", err);
        await ctx.reply(`Sorry, I couldn't process that document: ${err.message}`);
    }
});

// ── Callback Query Handler ──────────────────────────────────────────

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data === "doc_cancel") {
        await ctx.answerCallbackQuery("Cancelled.");
        await ctx.editMessageText("❌ Upload cancelled.");
        return;
    }

    if (data.startsWith("doc_ingest:")) {
        const [, fileName, collection] = data.split(":");
        await ctx.answerCallbackQuery(`Ingesting into ${collection}...`);

        try {
            const tempDir = path.join(process.cwd(), "workspace", "temp_uploads");
            const tempPath = path.join(tempDir, fileName);

            if (!fs.existsSync(tempPath)) {
                throw new Error("Temporary file not found. Please try uploading again.");
            }

            const collectionDir = path.join(process.cwd(), "workspace", "collections", collection);
            fs.mkdirSync(collectionDir, { recursive: true });

            const finalPath = path.join(collectionDir, fileName);
            fs.renameSync(tempPath, finalPath);

            await ctx.editMessageText(`💾 Ingesting "${fileName}" into "${collection}" collection...`);

            const { runIngestion } = await import("./memory/index.js");
            
            let lastProgressMsg = "";
            const onProgress = async (msg: string) => {
                if (msg !== lastProgressMsg) {
                    lastProgressMsg = msg;
                    await ctx.reply(msg).catch(() => {});
                }
            };

            runIngestion(finalPath, collection, onProgress).then(async (result) => {
                console.log(`✅ Ingestion result: ${result}`);
                const channel = getSetting("active_channel:tg") ?? "D";
                const linkedCollections = getChannelCollections(channel);

                if (!linkedCollections.includes(collection)) {
                    savePendingConfirmation(
                        "tg",
                        { tool: "execute_link_collection", params: { channel, collection } },
                        `Would you like to link the collection '${collection}' to this channel?`
                    );
                    await ctx.reply(`✅ Ingestion complete: "${fileName}"\n\nSuccessfully indexed into the "${collection}" collection.\n\n❓ Would you like to link the collection '${collection}' to this channel?`);
                } else {
                    await ctx.reply(`✅ Ingestion complete: "${fileName}"\n\nSuccessfully indexed into the "${collection}" collection.`);
                }
            }).catch(async (err) => {
                console.error("❌ Ingestion error:", err);
                await ctx.reply(`❌ Ingestion failed for \`${fileName}\`: ${err.message}`);
            });

        } catch (err: any) {
            console.error("❌ Callback ingestion error:", err);
            await ctx.editMessageText(`❌ Ingestion failed: ${err.message}`);
        }
    }
});

// ── Utilities ───────────────────────────────────────────────────────

function splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Try to split at a newline near the limit
        let splitIndex = remaining.lastIndexOf("\n", maxLength);
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            // Fallback: split at space
            splitIndex = remaining.lastIndexOf(" ", maxLength);
        }
        if (splitIndex === -1) {
            // Last resort: hard split
            splitIndex = maxLength;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
}
