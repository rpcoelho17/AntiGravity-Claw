/**
 * memory/sync.ts — Model drift detection and synchronization
 */

import { db, getSetting, updateSetting, createEmbeddingTable } from "./db.js";
import http from "http";

export interface ModelMetadata {
    model: string;
    dimension: number;
    max_seq_length: number;
}

/**
 * Fetches current model metadata from the embedding server.
 * Retries for up to 5 seconds if server is starting.
 */
export async function fetchServerMetadata(retries = 5): Promise<ModelMetadata | null> {
    const url = process.env["EMBED_SERVER_URL"] || "127.0.0.1";
    const port = process.env["EMBED_SERVER_PORT"] || "11435";

    for (let i = 0; i < retries; i++) {
        const result = await new Promise<ModelMetadata | null>((resolve) => {
            const req = http.get(`http://${url}:${port}/health`, (res) => {
                let data = "";
                res.on("data", (chunk) => data += chunk);
                res.on("end", () => {
                    if (res.statusCode === 200) {
                        try { resolve(JSON.parse(data)); } catch { resolve(null); }
                    } else { resolve(null); }
                });
            });
            req.on("error", () => resolve(null));
            req.setTimeout(1000, () => { req.destroy(); resolve(null); });
            req.end();
        });

        if (result) return result;
        if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

export async function checkModelDrift(): Promise<ModelMetadata | null> {
    const lastModel = getSetting("last_used_model_name");
    const lastDim = parseInt(getSetting("last_used_model_dim") || "0", 10);
    const envModel = process.env["EMBED_MODEL"];

    console.log(`🔍 Drift Check: DB=${lastModel} (${lastDim}d), ENV=${envModel}`);

    // 1. Try server metadata (most accurate)
    const serverMeta = await fetchServerMetadata(1); // Quick check if caller is already waiting
    if (serverMeta) {
        console.log(`🔍 Server is up: ${serverMeta.model} (${serverMeta.dimension}d)`);
        if (serverMeta.model !== lastModel || serverMeta.dimension !== lastDim) {
            console.log("⚠️ Drift detected via Server Meta");
            return serverMeta;
        }
    } else if (envModel && envModel !== lastModel) {
        // 2. Fallback: Server is down/starting, but .env clearly wants a drift
        console.log("⚠️ Drift detected via .env (Server still loading)");
        return { model: envModel, dimension: 0, max_seq_length: 0 }; 
    }

    return null;
}

/**
 * Synchronizes the database schema and settings with the new model.
 * WARNING: This clears all existing embeddings and documents.
 */
export function performMigration(meta: ModelMetadata) {
    console.log(`🚀 Migrating to new model: ${meta.model} (${meta.dimension}d)`);
    
    // 1. Recreate embedding table with correct dimension
    createEmbeddingTable(meta.dimension);

    // 2. Wipe incompatible data
    db.exec(`DELETE FROM memory`);
    db.exec(`DELETE FROM documents`);
    db.exec(`DELETE FROM summaries`);

    // 3. Update settings
    updateSetting("last_used_model_name", meta.model);
    updateSetting("last_used_model_dim", (meta.dimension ?? 768).toString());
    updateSetting("last_used_model_max_len", (meta.max_seq_length ?? 512).toString());

    console.log(`✅ Migration complete.`);
}
