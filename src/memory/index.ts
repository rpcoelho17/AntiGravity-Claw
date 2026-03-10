/**
 * memory/index.ts — Public API barrel file
 * 
 * All memory module exports go through here.
 */

export { db, getSetting, getSettingNum, updateSetting, getChannelCollections, EMBEDDING_DIM, MEMORY_MD_PATH, COLLECTIONS_PATH } from "./db.js";
export { embed, embedBatch, embeddingToBuffer } from "./embed.js";
export {
    storeMessage,
    getRecentMessages,
    getMessageRange,
    getMessageCount,
    getSummary,
    summaryCache,
    shouldUpdateSummary,
    resetMessageCounter,
    formatRecentMessages,
    sanitizeForStorage,
    updateSummary,
    retryFailedEmbeddings,
    estimateTokens,
} from "./store.js";
export type { StoredMessage } from "./store.js";
export { handleConfirmation, savePendingConfirmation, getPendingConfirmation, clearPendingConfirmation } from "./confirm.js";
export { search, formatSearchContext } from "./search.js";
export type { SearchResult } from "./search.js";
export { initDeepSearch, deepMemorySearch } from "./deep-search.js";
export { runIngestion } from "./ingest.js";
export { registerPendingUpload, getCollectionChoices, handleIngestCallback, handleNewCollectionName, chunkArray } from "./upload.js";
