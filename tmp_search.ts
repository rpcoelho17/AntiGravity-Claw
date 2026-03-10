import { search, formatSearchContext } from './src/memory/search.js';
async function test() {
    const res = await search('what is the document Chan of draft about?', { channel: 'D', topK: 5, beforeId: 10000 });
    console.log("=== RESULTS ===");
    console.log(formatSearchContext(res));
    console.log("Total docs found:", res.filter(r => r.type === 'R').length);
}
test().catch(console.error);
