import { Bot, InputFile, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { runAgentLoop } from "./agent.js";
import { transcribeAudio, generateSpeech } from "./services/audio.js";
import { getSetting } from "./memory/index.js";
import fs from "fs";
import path from "path";


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
        const response = await runAgentLoop(userMessage);

        try {
            // Telegram has a 4096 char message limit — split if needed
            if (response.length <= 4096) {
                await ctx.reply(response, { parse_mode: "Markdown" });
            } else {
                // Split into chunks, respecting the limit
                const chunks = splitMessage(response, 4096);
                for (const chunk of chunks) {
                    await ctx.reply(chunk, { parse_mode: "Markdown" });
                }
            }
        } catch (replyErr) {
            console.error("❌ Agent reply error (maybe markdown issue?):", replyErr);
            await ctx.reply(response); // Fallback to plain text
        }
    } catch (err) {
        console.error("❌ Agent error:", err);
        await ctx.reply("Sorry, something went wrong processing your message.");
    }
});

// ── Voice Message Handler ───────────────────────────────────────────

bot.on("message:voice", async (ctx) => {
    // ... (existing code)
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
            const tempDir = path.join(process.cwd(), "data", "temp_uploads");
            fs.mkdirSync(tempDir, { recursive: true });
            const tempPath = path.join(tempDir, doc.file_name || "unnamed_doc");
            fs.writeFileSync(tempPath, buffer);

            await ctx.reply(`❓ I've received \`${doc.file_name}\`. In which collection should I store it?`, {
                parse_mode: "Markdown",
                reply_markup: kb
            });
            return;
        }

        // Direct ingestion (when caption is provided)
        const collectionDir = path.join(process.cwd(), "data", "collections", collection);
        fs.mkdirSync(collectionDir, { recursive: true });

        const localPath = path.join(collectionDir, doc.file_name || "unnamed_doc");
        fs.writeFileSync(localPath, buffer);

        await ctx.reply(`💾 _Received ${doc.file_name}. Ingesting into ${collection} collection..._`, { parse_mode: "Markdown" });

        // Trigger ingestion
        const { runIngestion } = await import("./memory/index.js");
        const result = await runIngestion(localPath, collection);
        console.log(`✅ Ingestion result: ${result}`);

        await ctx.reply(`✅ *Ingestion complete:* \`${doc.file_name}\`\n\nSuccessfully indexed into the *${collection}* collection. It is now available for semantic search.`, { parse_mode: "Markdown" });

        // Notify agent loop so it can acknowledge the document
        const llmResponse = await runAgentLoop(`I have uploaded a document named ${doc.file_name}. It has been ingested into the ${collection} collection.`);
        await ctx.reply(llmResponse, { parse_mode: "Markdown" });

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
            const tempDir = path.join(process.cwd(), "data", "temp_uploads");
            const tempPath = path.join(tempDir, fileName);

            if (!fs.existsSync(tempPath)) {
                throw new Error("Temporary file not found. Please try uploading again.");
            }

            const collectionDir = path.join(process.cwd(), "data", "collections", collection);
            fs.mkdirSync(collectionDir, { recursive: true });

            const finalPath = path.join(collectionDir, fileName);
            fs.renameSync(tempPath, finalPath);

            await ctx.editMessageText(`💾 _Ingesting ${fileName} into ${collection} collection..._`, { parse_mode: "Markdown" });

            const { runIngestion } = await import("./memory/index.js");
            const result = await runIngestion(finalPath, collection);
            console.log(`✅ Ingestion result: ${result}`);

            await ctx.editMessageText(`✅ *Ingestion complete:* \`${fileName}\`\n\nSuccessfully indexed into the *${collection}* collection. It is now available for semantic search.`, { parse_mode: "Markdown" });

            const llmResponse = await runAgentLoop(`I have uploaded a document named ${fileName}. It has been ingested into the ${collection} collection.`);
            await ctx.reply(llmResponse, { parse_mode: "Markdown" });

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
