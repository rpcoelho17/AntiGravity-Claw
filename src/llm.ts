import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { config } from "./config.js";
import OpenAI from "openai";
import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from "openai/resources/chat/completions.js";

// Re-export for agent.ts compatibility
export type { ChatCompletionMessageParam, ChatCompletionTool };

// Initialize OpenRouter client (OpenAI compatible)
const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: config.OPENROUTER_API_KEY,
});

// Initialize the native Google SDK
const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);

// Use the model the user requested
// Model chain
const PRIMARY_MODEL = config.PRIMARY_MODEL;
const FALLBACK_MODEL = "gemini-1.5-flash";

export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

export interface LLMResponse {
    content: string | null;
    toolCalls: ToolCall[];
    finishReason: string | null;
}

/**
 * Maps OpenAI-style messages to Google Generative AI format.
 * Ensures FunctionResponses are not mixed with text and have correct names.
 */
function mapMessages(messages: ChatCompletionMessageParam[]) {
    return messages.map((m, index) => {
        const parts: any[] = [];

        if (m.role === "tool") {
            const toolCallId = (m as any).tool_call_id;
            let functionName = "unknown";

            // Look back for the matching tool call in the previous assistant message
            for (let i = index - 1; i >= 0; i--) {
                const prev = messages[i];
                if (prev.role === "assistant" && prev.tool_calls) {
                    const call = prev.tool_calls.find(c => c.id === toolCallId);
                    if (call && "function" in call) {
                        functionName = call.function.name;
                        break;
                    }
                }
            }

            let responseValue: any;
            try {
                // Try to parse content as JSON if it's a string, otherwise wrap it
                responseValue = typeof m.content === "string" ? JSON.parse(m.content) : m.content;
            } catch {
                responseValue = { result: m.content };
            }

            parts.push({
                functionResponse: {
                    name: functionName,
                    response: responseValue
                }
            });
            return { role: "function", parts };
        }

        if (m.role === "assistant") {
            if (m.content) {
                parts.push({ text: m.content });
            }
            if (m.tool_calls) {
                m.tool_calls.forEach(tc => {
                    if ("function" in tc) {
                        parts.push({
                            functionCall: {
                                name: tc.function.name,
                                args: JSON.parse(tc.function.arguments)
                            }
                        });
                    }
                });
            }
            return { role: "model", parts };
        }

        // Default to user role
        const content = typeof m.content === "string" ? m.content : "";
        parts.push({ text: content });
        return { role: "user", parts };
    });
}

/**
 * Maps OpenAI-style tools to Google Generative AI format
 */
function mapTools(tools: ChatCompletionTool[]) {
    const functionDeclarations = tools.map(t => {
        if ("function" in t) {
            return {
                name: t.function.name,
                description: t.function.description || "",
                parameters: t.function.parameters as any
            };
        }
        return null;
    }).filter(Boolean);

    return [{ functionDeclarations }];
}

/**
 * Executes a generation request with a specific model.
 */
async function generateWithModel(
    modelName: string,
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
): Promise<LLMResponse> {
    const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
        tools: mapTools(tools) as any,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
    });

    const googleMessages = mapMessages(messages);
    const result = await model.generateContent({ contents: googleMessages });
    const response = result.response;

    let content = "";
    try {
        content = response.text();
    } catch (e) { }

    const toolCalls: ToolCall[] = [];
    const parts = response.candidates?.[0]?.content?.parts;
    const functionCalls = parts?.filter(p => p.functionCall);

    if (functionCalls) {
        functionCalls.forEach((p, idx) => {
            if (p.functionCall) {
                toolCalls.push({
                    id: `call_${Date.now()}_${idx}`,
                    name: p.functionCall.name,
                    arguments: JSON.stringify(p.functionCall.args)
                });
            }
        });
    }

    return {
        content: content || null,
        toolCalls,
        finishReason: response.candidates?.[0]?.finishReason || "STOP"
    };
}

/**
 * Executes a generation request with OpenRouter (OpenAI SDK).
 */
async function generateWithOpenRouter(
    modelName: string,
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
): Promise<LLMResponse> {
    const response = await openai.chat.completions.create({
        model: modelName,
        messages: [
            { role: "system", content: systemPrompt },
            ...messages
        ],
        tools: tools.length > 0 ? tools : undefined,
    });

    const choice = response.choices[0];
    const message = choice.message;

    const toolCalls: ToolCall[] = [];
    if (message.tool_calls) {
        message.tool_calls.forEach(tc => {
            if (tc.type === "function") {
                toolCalls.push({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: tc.function.arguments
                });
            }
        });
    }

    return {
        content: message.content || null,
        toolCalls,
        finishReason: choice.finish_reason || "STOP"
    };
}

export async function callLLM(
    systemPrompt: string,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
): Promise<LLMResponse> {
    try {
        // Try the primary model (OpenRouter) first
        return await generateWithOpenRouter(PRIMARY_MODEL, systemPrompt, messages, tools);
    } catch (err: any) {
        // If OpenRouter fails (rate limit, etc.), fall back to Gemini
        console.warn(`⚠️ Primary model ${PRIMARY_MODEL} failed. Falling back to ${FALLBACK_MODEL}...`, err.message || err);
        try {
            return await generateWithModel(FALLBACK_MODEL, systemPrompt, messages, tools);
        } catch (fallbackErr: any) {
            console.error("❌ Fallback model failed:", fallbackErr);
            return {
                content: "I'm sorry, but both my primary and fallback AI models are currently unavailable. Please try again in a moment.",
                toolCalls: [],
                finishReason: "STOP"
            };
        }
    }
}
