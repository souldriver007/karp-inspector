#!/usr/bin/env node
// ============================================================================
// KARP Inspector — Model Downloader
// Downloads bge-small-en-v1.5 ONNX model for local bundling.
// Run once: node scripts/download-model.js
// After this, the model is cached in models/ and no network is needed.
// ============================================================================

const path = require('path');
const fs = require('fs');

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const MODEL_DIR = path.join(__dirname, '..', 'models');

async function main() {
    console.log('');
    console.log('  KARP Inspector — Model Downloader');
    console.log('  by SoulDriver (souldriver.com.au)');
    console.log('');

    process.env.TRANSFORMERS_CACHE = MODEL_DIR;

    console.log(`  Model: ${MODEL_ID}`);
    console.log(`  Cache: ${MODEL_DIR}`);
    console.log('');

    fs.mkdirSync(MODEL_DIR, { recursive: true });

    console.log('  Downloading and caching model (may take a minute on first run)...');
    console.log('');

    try {
        const { pipeline } = await import('@huggingface/transformers');
        const embedder = await pipeline('feature-extraction', MODEL_ID, {
            cache_dir: MODEL_DIR,
            // Must match server/graph.js MODEL_DTYPE. If this fetches a
            // different precision than the server asks for, the server finds
            // no matching .onnx in the bundle and — with local_files_only:
            // true — has no way to recover.
            dtype: 'q8',
        });

        const output = await embedder('test embedding', { pooling: 'mean', normalize: true });
        const dim = output.data.length;

        let totalSize = 0;
        function walkSize(dir) {
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fp = path.join(dir, entry.name);
                    if (entry.isDirectory()) walkSize(fp);
                    else totalSize += fs.statSync(fp).size;
                }
            } catch {}
        }
        walkSize(MODEL_DIR);

        console.log(`  Done! Model downloaded and verified.`);
        console.log(`  Dimensions: ${dim}`);
        console.log(`  Size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
        console.log(`  Location: ${MODEL_DIR}`);
        console.log('');
        console.log('  No network needed from now on.');
    } catch (e) {
        console.error(`  Failed: ${e.message}`);
        process.exit(1);
    }
}

main();
