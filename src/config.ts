import "dotenv/config";

export interface Config {
    TELEGRAM_BOT_TOKEN: string;
    OPENROUTER_API_KEY: string;
    GOOGLE_API_KEY: string;
    GROQ_API_KEY: string;
    HUGGINGFACE_API_KEY: string;
    TAVILY_API_KEY?: string;
    SERPAPI_API_KEY?: string; // Optional: Primary Google search
    ALLOWED_USER_IDS: number[];
    MAX_AGENT_ITERATIONS: number;
    BASE_PROJECT_PATH: string;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(`❌ Missing required environment variable: ${name}`);
        console.error(`   Copy .env.example to .env and fill in all values.`);
        process.exit(1);
    }
    return value;
}

export const config: Config = {
    TELEGRAM_BOT_TOKEN: requireEnv("TELEGRAM_BOT_TOKEN"),
    OPENROUTER_API_KEY: requireEnv("OPENROUTER_API_KEY"),
    GOOGLE_API_KEY: requireEnv("GOOGLE_API_KEY"),
    GROQ_API_KEY: requireEnv("GROQ_API_KEY"),
    HUGGINGFACE_API_KEY: requireEnv("HUGGINGFACE_API_KEY"),
    TAVILY_API_KEY: process.env["TAVILY_API_KEY"],
    SERPAPI_API_KEY: process.env["SERPAPI_API_KEY"],

    ALLOWED_USER_IDS: requireEnv("ALLOWED_USER_IDS")
        .split(",")
        .map((id) => {
            const parsed = parseInt(id.trim(), 10);
            if (isNaN(parsed)) {
                console.error(`❌ Invalid user ID in ALLOWED_USER_IDS: "${id}"`);
                process.exit(1);
            }
            return parsed;
        }),

    MAX_AGENT_ITERATIONS: parseInt(
        process.env["MAX_AGENT_ITERATIONS"] ?? "10",
        10
    ),
    BASE_PROJECT_PATH: process.env["BASE_PROJECT_PATH"] ?? "D:\\FILES\\Code\\BotProjects",
};
