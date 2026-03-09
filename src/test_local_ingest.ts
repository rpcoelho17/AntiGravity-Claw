import { runIngestion } from './memory/ingest.js';
import path from 'path';

async function test() {
    console.log("Starting Local BGE Ingestion Test...");
    const testFile = "d:/FILES/Code/AntiGravityClaw/data/collections/Articles/Chain_of_Draft.pdf";
    try {
        const result = await runIngestion(testFile, "Articles");
        console.log("SUCCESS:", result);
    } catch (e: any) {
        console.error("FAILED:", e.message);
        process.exit(1);
    }
}

test();
