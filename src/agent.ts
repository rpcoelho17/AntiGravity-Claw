import { callLLM } from "./llm.js";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "./llm.js";
import { allToolSpecs, executeTool } from "./tools/registry.js";
import { config } from "./config.js";
import {
    storeMessage,
    getRecentMessages,
    getMessageCount,
    formatRecentMessages,
    getSummary,
    getSetting,
    getSettingNum,
    handleConfirmation,
    getPendingConfirmation,
    clearPendingConfirmation,
    search,
    formatSearchContext,
    shouldUpdateSummary,
    updateSummary,
    sanitizeForStorage,
    retryFailedEmbeddings,
    initDeepSearch,
    MEMORY_MD_PATH,
    checkModelDrift,
    getChannelCollections,
} from "./memory/index.js";
import fs from "fs";
import path from "path";

// ── Skills Context ──────────────────────────────────────────────────

function getSkillsContext(): string {
    const skillsDir = path.resolve(process.cwd(), "workspace/skills");
    if (!fs.existsSync(skillsDir)) return "";

    const skills: { name: string; description: string; path: string }[] = [];
    
    // Recursive function to find SKILL.md files up to depth 3
    function findSkillFiles(dir: string, depth: number = 0) {
        if (depth > 3) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    // Skip hidden dirs, common noise, and node_modules
                    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.startsWith('_')) continue;
                    findSkillFiles(fullPath, depth + 1);
                } else if (entry.name === "SKILL.md") {
                    const content = fs.readFileSync(fullPath, "utf-8");
                    const nameMatch = content.match(/^name:\s*(.+)$/m);
                    const descMatch = content.match(/^description:\s*(.+)$/m);
                    
                    if (nameMatch && descMatch) {
                        skills.push({
                            name: nameMatch[1].trim(),
                            description: descMatch[1].trim(),
                            path: path.relative(process.cwd(), fullPath).replace(/\\/g, "/")
                        });
                    }
                }
            }
        } catch (err) {
            console.warn(`⚠️ Failed to scan dir ${dir}:`, err);
        }
    }

    findSkillFiles(skillsDir);

    if (skills.length === 0) return "";

    let prompt = `## Installed Skills\nYou have access to the following extensible skills. If one matches the user's request, you MUST use the \`read_file\` tool to read its \`SKILL.md\` file to learn how to execute it BEFORE taking action. Note: Skills are GLOBALLY available. You DO NOT need to check if the channel is linked to a project to use skills. Just read the SKILL.md file and execute it.\n\n`;
    
    for (const skill of skills) {
        prompt += `- **${skill.name}** (Path: \`${skill.path}\`): ${skill.description}\n`;
    }
    
    return prompt;
}

// ── System prompt (base) ────────────────────────────────────────────

function getBaseSystemPrompt(): string {
    const base = `You are Gravity Claw — a personal AI assistant running as a Telegram bot.
You are an extension of the AntiGravity IDE agent, accessible from the user's phone.

Core traits:
- Concise and direct. Don't be overly verbose unless the user asks for detail.
- Helpful and proactive. If a tool can answer the question better, use it.
- Honest about limitations. If you can't do something, say so.

You have access to tools. Use them when they can improve your answer.
When using tools, think step by step about which tool fits the user's request.

Channel management, settings changes, and destructive actions all go through
the "propose" tool system — you call a propose_ tool, the user confirms (yes/no),
then the action executes. Never propose more than one state change per response.

You have persistent memory across conversations and channels. Each channel
is like a separate project workspace. You can recall what the user has told
you previously. Use this context naturally.

You are running locally on the user's machine. Be security-conscious.

## Source Authority
If information in the "Relevant Context" (documents) conflicts with your previous statements in "Recent Conversation", the documents are the absolute source of truth. Admit the mistake, use the newer information, and provide the updated answer.

## Tool Usage Constraints
- **Documents**: Use \`search\` or \`deep_memory_search\` for ANY document inside \`workspace/collections/\`. NEVER use \`read_file\` or \`list_files\` for these.
- **Code/Projects**: Use \`read_file\`, \`list_files\`, and \`write_file\` ONLY for project source code and configuration files.
- **Sandboxing**: If a tool fails with "Access Denied", do NOT ask the user to link a project unless you are explicitly trying to work on code. If you are trying to find document information, you likely forgot to link the collection via \`propose_link_collection\`.`;

    // Try to load extra instructions from project root
    const instructionsPath = path.resolve(process.cwd(), ".antigravity/instructions.md");
    if (fs.existsSync(instructionsPath)) {
        try {
            const extra = fs.readFileSync(instructionsPath, "utf-8").trim();
            return `${base}\n\n## Global Instructions\n${extra}`;
        } catch (err) {
            console.warn("⚠️ Failed to read .antigravity/instructions.md:", err);
        }
    }

    return base;
}

// ── Build enriched system prompt with memory context ────────────────
// Assembly order per V4 spec Section 8:
//   1. Base system prompt (identity + instructions)
//   2. MEMORY.md (curated facts — most stable, cache checkpoint)
//   3. Rolling summary (changes every N messages — cache checkpoint)
//   4. Semantic search results (changes per query)
//   5. Active channel indicator
//   6. Last N messages verbatim (changes every message)

async function buildSystemPrompt(channel: string, userMessage: string): Promise<string> {
    const parts: string[] = [];

    // 1. Base system prompt (most stable — always first)
    parts.push(getBaseSystemPrompt());

    // 1.5. Installed Skills (changes only on skill install)
    const skillsContext = getSkillsContext();
    if (skillsContext) {
        parts.push(skillsContext);
    }

    // 2. MEMORY.md — curated facts (rarely changes → cache checkpoint)
    try {
        const memoryMd = fs.readFileSync(MEMORY_MD_PATH, "utf-8").trim();
        if (memoryMd && memoryMd !== "# Memory\n\nCurated facts about the user.") {
            parts.push(memoryMd);
        }
    } catch {
        // MEMORY.md doesn't exist yet — that's fine
    }

    // 2.5 Pending Confirmation (Context awareness)
    const pending = getPendingConfirmation("tg");
    if (pending) {
        parts.push(`## Pending Action Required\nYou recently proposed an action: "${pending.prompt_shown}". 
The user's next message might be a response to this prompt, or a clarifying question. 
If they hasn't answered yet, you can briefly remind them if it's relevant, or answer their unrelated question first.`);
    }

    // 3. Rolling summary (changes every N messages → cache checkpoint)
    const summary = getSummary(channel);
    if (summary) {
        parts.push(`## Conversation Summary\n${summary}`);
    }

    // 4. Semantic search — always run to retrieve RAG documents and old messages
    const msgLimit = getSettingNum("recent_messages_limit", 20);
    const recent = getRecentMessages(channel);
    const oldestVerbatimId = recent.length > 0 ? recent[0].id : Infinity;

    try {
        const searchResults = await search(userMessage, {
            channel,
            topK: getSettingNum("semantic_search_top_k", 5),
            beforeId: oldestVerbatimId
        });
        const searchContext = formatSearchContext(searchResults);
        if (searchContext) {
            parts.push(`## Relevant Context\n${searchContext}`);
        }
    } catch (err) {
        console.warn("⚠️ Semantic search failed (non-blocking):", err);
    }

    // 5. Active channel indicator
    const channelDisplay = channel === "D" ? "Default" : channel;
    parts.push(`## Active Channel: ${channelDisplay}`);

    // 5.5. Linked Collections (to prevent redundant linking prompts)
    const linked = getChannelCollections(channel);
    if (linked.length > 0) {
        parts.push(`## Linked Collections\nThe following collections are already linked to this channel:\n${linked.map((c: string) => `- ${c}`).join("\n")}`);
    }

    // 6. Recent messages verbatim (least stable — always last)
    const recentText = formatRecentMessages(recent);
    if (recentText) {
        parts.push(`## Recent Conversation\n${recentText}`);
    }

    return parts.join("\n\n---\n\n");
}

// ── Convert tool specs to OpenAI format ─────────────────────────────

function getToolsForLLM(): ChatCompletionTool[] {
    return allToolSpecs().map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

// ── Simple LLM call for summarization ───────────────────────────────

async function callSummarizationLLM(prompt: string): Promise<string> {
    const response = await callLLM(
        "You are a concise summarizer. Output only the summary, nothing else.",
        [{ role: "user", content: prompt }],
        [] // no tools for summarization
    );
    return response.content || "";
}

// Initialize deep memory search handler with the LLM caller
initDeepSearch(callSummarizationLLM);

// ── Agent loop ──────────────────────────────────────────────────────

export const EMBED_WAIT_MESSAGE = "Wait for a second while I finish loading my embedding model into memory... 🧠";

export async function runAgentLoop(userMessage: string): Promise<string> {
    // -0. CHECK IF EMBEDDING SERVER IS READY
    const { isLocalEmbeddingAvailable } = await import("./memory/embed.js");
    if (!(await isLocalEmbeddingAvailable())) {
        return EMBED_WAIT_MESSAGE;
    }

    // 0. CHECK FOR MODEL DRIFT (Mandatory for GPU/CPU safety)
    let driftWarning = "";
    try {
        const drift = await checkModelDrift();
        if (drift) {
            driftWarning = `
⚠️ **EMBEDDING MODEL CHANGE DETECTED**
- Action Required: You MUST respond to the user with EXACTLY THIS MESSAGE: "I've detected that your default embedding model has changed. Should I switch to the new model? This will wipe clean your memory.db and all the ingestions! Respond by typing Yes or no."
- Logic: If the user says "Yes", you MUST call the \`propose_model_migration\` tool with \`confirm: true\`. If they say "No", explain that search will remain disabled until they revert .env or migrate.
- Restriction: Do NOT use any other tools except migration tools.
`;
        }
    } catch (err) {
        console.warn("⚠️ Failed to check model drift:", err);
    }

    // Get active channel for Telegram
    const channel = getSetting("active_channel:tg") ?? "D";

    // ── V4 PROPOSE-CONFIRM FLOW ──
    // Check for pending confirmation BEFORE any other processing
    const confirmResult = await handleConfirmation("tg", userMessage);
    if (confirmResult !== null) {
        return confirmResult;
    }

    // Store user message BEFORE any LLM call
    const storeResult = await storeMessage(channel, "U", userMessage);
    if (storeResult === "LARGE_PASTE") {
        return `That looked like a large paste. I've saved and indexed it in your p:${channel} collection. What would you like to know about it?`;
    }

    // Build system prompt
    let systemPrompt: string;
    let tools = getToolsForLLM();

    if (driftWarning) {
        // DRIFT MODE: Minimal prompt, restricted tools, NO search/context assembly
        systemPrompt = `
You are Gravity Claw. 
${driftWarning}

CRITICAL: You are in MIGRATION MODE. Access to memory and search is DISABLED.
You MUST ONLY respond with the migration message or call a migration tool.
`;
        // Restrict tools to only migration and core
        tools = tools.filter(t => (t as any).function?.name.startsWith("propose_") || (t as any).function?.name === "get_current_time");
    } else {
        // NORMAL MODE: Full context assembly
        systemPrompt = await buildSystemPrompt(channel, userMessage);
    }

    const messages: ChatCompletionMessageParam[] = [
        { role: "user", content: userMessage },
    ];

    let finalResponse = "(No response generated)";

    for (let i = 0; i < config.MAX_AGENT_ITERATIONS; i++) {
        console.log(`🔄 Agent iteration ${i + 1}...`);
        const response = await callLLM(systemPrompt, messages, tools);

        // If no tool calls, we have our final response
        if (response.toolCalls.length === 0) {
            console.log(`🏁 Final response received.`);
            finalResponse = response.content || "(No response generated)";
            break;
        }

        console.log(`🧩 LLM requested ${response.toolCalls.length} tool calls.`);
        // LLM wants to call tools — append assistant message with tool calls
        messages.push({
            role: "assistant",
            content: response.content,
            tool_calls: response.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
            })),
        });

        // Execute each tool and append results
        let hasProposeTool = false;
        let directSent = false;

        for (const toolCall of response.toolCalls) {
            console.log(`  🔧 Tool call: ${toolCall.name}`, toolCall.arguments);

            let parsedInput: Record<string, unknown> = {};
            try {
                parsedInput = JSON.parse(toolCall.arguments);
            } catch {
                // If JSON parse fails, send empty object
            }

            const result = await executeTool(toolCall.name, parsedInput);
            console.log(`  ✅ Tool result: ${result.substring(0, 200)}`);

            // V4 Propose-Confirm: intercept propose tools and halt loop
            if (toolCall.name.startsWith("propose_")) {
                hasProposeTool = true;
                finalResponse = result;
                break;
            }

            // Direct-send: tool already sent the message to the user
            if (result.includes("[DIRECT_SENT]")) {
                directSent = true;
                finalResponse = "";
                break;
            }

            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }

        if (hasProposeTool || directSent) {
            break; // Stop LLM processing entirely
        }

        // Check if this was the last iteration
        if (i === config.MAX_AGENT_ITERATIONS - 1) {
            console.warn(`⚠️ Agent loop hit max iterations (${config.MAX_AGENT_ITERATIONS})`);
            finalResponse = "I've reached my processing limit for this request. Please try rephrasing or breaking your question into smaller parts.";
        }
    }

    // Sanitize and store the assistant's response
    // V4 Propose-Confirm: do not store confirmation prompts in conversation history
    if (!finalResponse.includes("— is that correct? (yes / no)")) {
        const cleanResponse = sanitizeForStorage(finalResponse);
        await storeMessage(channel, "A", cleanResponse);
    }

    // Fire-and-forget: update rolling summary if threshold reached
    if (shouldUpdateSummary(channel)) {
        updateSummary(channel, callSummarizationLLM).catch(err =>
            console.warn("⚠️ Background summary update failed:", err)
        );
    }

    // Fire-and-forget: retry any failed embeddings
    retryFailedEmbeddings().catch(err =>
        console.warn("⚠️ Background embedding retry failed:", err)
    );

    return finalResponse;
}
