import { split } from "sentence-splitter";
import { embedBatch } from "./embed.js";

interface ChunkOptions {
    maxChars?: number;
    threshold?: number;
    bufferSize?: number; // sentences to look at for similarity
}

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Semantically split text into chunks based on topic transitions.
 */
export async function semanticChunk(
    text: string,
    options: ChunkOptions = {}
): Promise<string[]> {
    const {
        maxChars = 1500,
        threshold = 0.82,
        bufferSize = 3
    } = options;

    // 1. Split into sentences
    const sentences = split(text)
        .filter(node => node.type === "Sentence")
        .map(node => node.raw.trim())
        .filter(s => s.length > 5); // ignore tiny fragments

    if (sentences.length <= 1) return [text];

    // 2. Create "Windows" of sentences for more stable similarity comparison
    // We group every 'bufferSize' sentences to have a more stable "topic" representation
    const windows: string[] = [];
    for (let i = 0; i < sentences.length; i++) {
        const start = Math.max(0, i - bufferSize);
        const end = Math.min(sentences.length, i + bufferSize + 1);
        windows.push(sentences.slice(start, end).join(" "));
    }

    // 3. Embed windows in batch
    console.log(`Embedding ${windows.length} sentence windows for semantic analysis...`);
    const windowEmbeddings = await embedBatch(windows);

    // 4. Calculate similarities between adjacent windows
    const similarities: number[] = [];
    for (let i = 0; i < windowEmbeddings.length - 1; i++) {
        similarities.push(cosineSimilarity(windowEmbeddings[i], windowEmbeddings[i + 1]));
    }

    // 5. Group sentences into chunks based on similarity drops
    const chunks: string[] = [];
    let currentChunkSentences: string[] = [sentences[0]];
    let currentLength = sentences[0].length;

    for (let i = 0; i < similarities.length; i++) {
        const sim = similarities[i];
        const nextSentence = sentences[i + 1];

        // Break if similarity is too low (new topic) OR chunk is getting too big
        const shouldBreak = sim < threshold || (currentLength + nextSentence.length > maxChars);

        if (shouldBreak && currentChunkSentences.length > 0) {
            chunks.push(currentChunkSentences.join(" "));
            currentChunkSentences = [];
            currentLength = 0;
        }

        currentChunkSentences.push(nextSentence);
        currentLength += nextSentence.length;
    }

    if (currentChunkSentences.length > 0) {
        chunks.push(currentChunkSentences.join(" "));
    }

    return chunks;
}
