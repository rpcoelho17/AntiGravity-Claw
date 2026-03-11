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
    search,
    formatSearchContext,
    shouldUpdateSummary,
    updateSummary,
    sanitizeForStorage,
    retryFailedEmbeddings,
    initDeepSearch,
    MEMORY_MD_PATH,
} from "./memory/index.js";
import fs from "fs";
import path from "path";

// ── Skills Context ──────────────────────────────────────────────────

function getSkillsContext(): string {
    const skillsDir = path.resolve(process.cwd(), "workspace/skills");
    if (!fs.existsSync(skillsDir)) return "";

    const skills: { name: string; description: string; dir: string }[] = [];
    
    try {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            
            const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
            if (!fs.existsSync(skillMdPath)) continue;

            const content = fs.readFileSync(skillMdPath, "utf-8");
            
            // Simple regex to extract name and description from YAML frontmatter
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            
            if (nameMatch && descMatch) {
                skills.push({
                    name: nameMatch[1].trim(),
                    description: descMatch[1].trim(),
                    dir: entry.name
                });
            }
        }
    } catch (err) {
        console.warn("⚠️ Failed to parse skills directory:", err);
    }

    if (skills.length === 0) return "";

    let prompt = `## Installed Skills\nYou have access to the following extensible skills. If one matches the user's request, you MUST use the \`read_file\` tool to read its \`SKILL.md\` file to learn how to execute it BEFORE taking action. Note: Skills are GLOBALLY available. You DO NOT need to check if the channel is linked to a project to use skills. Just read the SKILL.md file and execute it.\n\n`;
    
    for (const skill of skills) {
        prompt += `- **${skill.name}** (Path: \`workspace/skills/${skill.dir}/SKILL.md\`): ${skill.description}\n`;
    }
    
    return prompt;
}

// ── System prompt (base) ────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Gravity Claw — a personal AI assistant running as a Telegram bot.
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

You are running locally on the user's machine. Be security-conscious.`;

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
    parts.push(BASE_SYSTEM_PROMPT);

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

export async function runAgentLoop(userMessage: string): Promise<string> {
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

    // Build enriched system prompt with full three-band context
    const systemPrompt = await buildSystemPrompt(channel, userMessage);

    const tools = getToolsForLLM();
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

            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }

        if (hasProposeTool) {
            break; // Stop LLM processing entirely since we must present the prompt to the user
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
