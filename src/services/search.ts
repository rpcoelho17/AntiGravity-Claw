import { config } from "../config.js";

export interface SearchResult {
    title: string;
    url: string;
    content: string;
}

/**
 * High-quality Google search results via SerpAPI
 */
async function searchSerpAPI(query: string): Promise<SearchResult[]> {
    if (!config.SERPAPI_API_KEY) {
        throw new Error("SerpAPI API key not found");
    }

    const params = new URLSearchParams({
        engine: "google",
        q: query,
        api_key: config.SERPAPI_API_KEY,
        num: "5",
    });

    const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`SerpAPI error: ${error}`);
    }

    const data = await response.json();
    const results: SearchResult[] = [];

    // Map organic results
    if (data.organic_results) {
        data.organic_results.forEach((r: any) => {
            results.push({
                title: r.title,
                url: r.link,
                content: r.snippet || "",
            });
        });
    }

    // Capture "Answer Box" if it exists (highly relevant for LLMs)
    if (data.answer_box && data.answer_box.answer) {
        results.unshift({
            title: "Direct Answer",
            url: data.answer_box.link || "N/A",
            content: data.answer_box.answer,
        });
    } else if (data.answer_box && data.answer_box.snippet) {
        results.unshift({
            title: "Direct Answer (Snippet)",
            url: data.answer_box.link || "N/A",
            content: data.answer_box.snippet,
        });
    }

    return results.slice(0, 5);
}

/**
 * High-quality search via Tavily (built for AI agents)
 */
async function searchTavily(query: string): Promise<SearchResult[]> {
    if (!config.TAVILY_API_KEY) {
        throw new Error("Tavily API key not found");
    }

    const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            api_key: config.TAVILY_API_KEY,
            query,
            search_depth: "basic",
            include_answer: false,
            include_images: false,
            max_results: 5,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Tavily error: ${error}`);
    }

    const data = await response.json();
    return data.results.map((r: any) => ({
        title: r.title,
        url: r.url,
        content: r.content,
    }));
}

/**
 * Fallback search via DuckDuckGo (free, no key)
 */
async function searchDDG(query: string): Promise<SearchResult[]> {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
        });

        if (!response.ok) throw new Error("DDG Lite unreachable");

        const html = await response.text();
        const results: SearchResult[] = [];
        const resultRegex = /<td[^>]*class="result-link"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<td[^>]*class="result-snippet"[^>]*>([^<]+)<\/td>/g;

        let match;
        let count = 0;
        while ((match = resultRegex.exec(html)) !== null && count < 5) {
            results.push({
                url: match[1],
                title: match[2].trim(),
                content: match[3].trim(),
            });
            count++;
        }

        return results;
    } catch (e) {
        console.error("DDG search failed:", e);
        return [];
    }
}

/**
 * Unified search entry point with tiered priority:
 * 1. Tavily (AI-optimized, primary)
 * 2. SerpAPI (Google, secondary)
 * 3. DuckDuckGo (Free fallback)
 */
export async function performWebSearch(query: string): Promise<SearchResult[]> {
    console.log(`🔍 Searching the web for: "${query}"...`);

    // Tier 1: Tavily
    try {
        if (config.TAVILY_API_KEY) {
            console.log("  📡 Using Tavily (Primary)...");
            return await searchTavily(query);
        }
    } catch (e) {
        console.warn("  ⚠️ Tavily failed, falling back to SerpAPI:", e);
    }

    // Tier 2: SerpAPI
    try {
        if (config.SERPAPI_API_KEY) {
            console.log("  📡 Using SerpAPI (Secondary)...");
            return await searchSerpAPI(query);
        }
    } catch (e) {
        console.warn("  ⚠️ SerpAPI failed, falling back to DDG:", e);
    }

    // Tier 3: DuckDuckGo
    console.log("  📡 Using DuckDuckGo (Fallback)...");
    return await searchDDG(query);
}
