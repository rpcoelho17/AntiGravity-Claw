import type { ToolDefinition } from "./registry.js";

export const getCurrentTimeTool: ToolDefinition = {
    spec: {
        name: "get_current_time",
        description:
            "Returns the current date and time with timezone. Use this when the user asks about the current time, date, or when you need temporal context.",
        parameters: {
            type: "object",
            properties: {
                timezone: {
                    type: "string",
                    description:
                        'IANA timezone string (e.g. "America/New_York"). Defaults to system timezone if omitted.',
                },
            },
            required: [],
        },
    },

    execute: async (input) => {
        const tz =
            (input.timezone as string | undefined) ??
            Intl.DateTimeFormat().resolvedOptions().timeZone;

        try {
            const now = new Date();
            const formatted = now.toLocaleString("en-US", {
                timeZone: tz,
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZoneName: "long",
            });

            return JSON.stringify({
                iso: now.toISOString(),
                formatted,
                timezone: tz,
                unix: Math.floor(now.getTime() / 1000),
            });
        } catch {
            return JSON.stringify({
                error: `Invalid timezone "${tz}". Use an IANA timezone like "America/Sao_Paulo".`,
            });
        }
    },
};
