// ============================================================================
// KARP Inspector — MCPB Build Script
// Author: SoulDriver (Adelaide, Australia)
//
// Bundle structure:
//   karp-inspector.mcpb (ZIP)
//   ├── manifest.json              ← entry_point: server/index.js
//   ├── server/
//   │   ├── index.js               ← MCP server (stdio JSON-RPC)
//   │   ├── database.js
//   │   ├── filesystem.js
//   │   ├── graph.js
//   │   ├── inspector.js
//   │   ├── intelligence.js
//   │   └── utils.js
//   ├── models/                    ← bundled ONNX embeddings (~33MB, q8 quantized)
//   │   └── Xenova/bge-small-en-v1.5/
//   ├── node_modules/              ← production deps only (sharp/onnxruntime-node pruned)
//   ├── package.json
//   └── icon.png
//
// NOTE: the proxy/detached-HTTP-server architecture (proxy/index.js
// spawning server/index.js in HTTP mode) was retired 23 Jul 2026 after
// consistently causing ~30s initialize handshakes (right at the proxy's
// own health-check timeout) and installer issues in Claude Desktop.
// server/index.js already supports plain stdio mode on its own (same
// pattern as every other KARP MCPB server) — Desktop now runs it directly.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'dist', 'stage');
const OUTPUT = path.join(ROOT, 'dist', 'karp-inspector.mcpb');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyDir(src, dest, exclude = []) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (exclude.includes(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(s, d, exclude);
        else fs.copyFileSync(s, d);
    }
}

function cleanDir(dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
}

function fileSize(fp) {
    const b = fs.statSync(fp).size;
    if (b > 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
    if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
    if (b > 1024) return `${(b / 1024).toFixed(0)}KB`;
    return `${b}B`;
}

function dirSize(dir) {
    let total = 0;
    function walk(d) {
        try {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const fp = path.join(d, entry.name);
                if (entry.isDirectory()) walk(fp);
                else total += fs.statSync(fp).size;
            }
        } catch {}
    }
    walk(dir);
    return total;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

console.log('');
console.log('  ╔═══════════════════════════════════════════╗');
console.log('  ║  KARP Inspector — MCPB Builder     ║');
console.log('  ║  Direct stdio server (no proxy)            ║');
console.log('  ║  by SoulDriver (souldriver.com.au)         ║');
console.log('  ╚═══════════════════════════════════════════╝');
console.log('');

// Step 1: Verify required files
console.log('[1/6] Checking project...');
const required = [
    'config/manifest.json',
    'server/index.js',
    'server/database.js',
    'server/filesystem.js',
    'server/graph.js',
    'server/inspector.js',
    'server/intelligence.js',
    'server/utils.js',
    'package.json',
];

for (const f of required) {
    if (!fs.existsSync(path.join(ROOT, f))) {
        console.error(`  ✗ Missing: ${f}`);
        process.exit(1);
    }
    console.log(`  ✓ ${f}`);
}

// Check for bundled models
const modelsDir = path.join(ROOT, 'models');
const modelExists = fs.existsSync(modelsDir) &&
    fs.readdirSync(modelsDir).filter(f => !f.startsWith('.')).length > 0;

if (modelExists) {
    const modelSize = dirSize(modelsDir);
    console.log(`  ✓ models/ (${(modelSize / 1024 / 1024).toFixed(1)}MB bundled)`);
} else {
    console.log('  ⚠ models/ not found — run "npm run download-model" first for offline support');
    console.log('    Bundle will still work but requires internet on first use.');
}

// Step 2: Clean staging
console.log('[2/6] Preparing staging directory...');
cleanDir(STAGE);

// Step 3: Copy manifest
console.log('[3/6] Staging manifest + config...');
fs.copyFileSync(path.join(ROOT, 'config', 'manifest.json'), path.join(STAGE, 'manifest.json'));
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(STAGE, 'package.json'));
console.log('  ✓ manifest.json');
console.log('  ✓ package.json');

// Icon
const iconPath = path.join(ROOT, 'assets', 'icon.png');
if (fs.existsSync(iconPath)) {
    fs.copyFileSync(iconPath, path.join(STAGE, 'icon.png'));
    console.log('  ✓ icon.png');
} else {
    console.log('  ⚠ icon.png not found (add to assets/)');
}

// Step 4: Copy server (the whole thing — Desktop runs this directly via stdio)
console.log('[4/6] Staging server...');
const serverFiles = ['index.js', 'database.js', 'filesystem.js', 'graph.js', 'inspector.js', 'intelligence.js', 'utils.js'];
fs.mkdirSync(path.join(STAGE, 'server'), { recursive: true });
for (const f of serverFiles) {
    const src = path.join(ROOT, 'server', f);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(STAGE, 'server', f));
        console.log(`  ✓ server/${f}`);
    } else {
        console.error(`  ✗ Missing: server/${f}`);
        process.exit(1);
    }
}

// Copy bundled models
if (modelExists) {
    console.log('  Copying bundled models (this may take a moment)...');
    copyDir(modelsDir, path.join(STAGE, 'models'));
    console.log(`  ✓ models/ (${(dirSize(path.join(STAGE, 'models')) / 1024 / 1024).toFixed(1)}MB)`);
}

// Copy download-model script (fallback for users without bundled models)
fs.mkdirSync(path.join(STAGE, 'scripts'), { recursive: true });
const dlScript = path.join(ROOT, 'scripts', 'download-model.js');
if (fs.existsSync(dlScript)) {
    fs.copyFileSync(dlScript, path.join(STAGE, 'scripts', 'download-model.js'));
    console.log('  ✓ scripts/download-model.js');
}

// Step 5: Install production dependencies
console.log('[5/6] Installing production dependencies...');
execSync('npm install --omit=dev', { cwd: STAGE, stdio: 'inherit' });
console.log('  ✓ node_modules/ (production only)');

// NOTE: We previously pruned `sharp` and `onnxruntime-node` here on the
// assumption transformers.js only used onnxruntime-web (WASM) since
// that's the only backend our code explicitly requests. That assumption
// was wrong — on Node.js, transformers.js's backend loader (backends/onnx.js)
// eagerly imports 'onnxruntime-node' at module load time regardless of
// which execution provider ends up used, because it's the preferred native
// path under real Node (vs. a browser). Pruning it broke `require`
// outright: "Cannot find package 'onnxruntime-node'". Confirmed via a live
// `remember` call after install. Leaving both packages in until we can
// verify a safe trim with an actual test in the loop, not another guess.

// Step 6: Create ZIP
console.log('[6/6] Creating .mcpb bundle...');
if (fs.existsSync(OUTPUT)) fs.unlinkSync(OUTPUT);

try {
    const zipPath = OUTPUT.replace(/\.mcpb$/, '.zip');
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    if (process.platform === 'win32') {
        const psCmd = `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zipPath}' -Force`;
        execSync(`powershell -Command "${psCmd}"`, { stdio: 'inherit' });
    } else {
        execSync(`cd "${STAGE}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
    }

    fs.renameSync(zipPath, OUTPUT);
} catch (e) {
    console.error(`  ✗ ZIP failed: ${e.message}`);
    console.log('');
    console.log('  Manual alternative:');
    console.log(`  1. Open: ${STAGE}`);
    console.log('  2. Select all → right-click → Send to → Compressed folder');
    console.log('  3. Rename to: karp-inspector.mcpb');
    process.exit(1);
}

// Summary
const bundleSize = fileSize(OUTPUT);
const stageSize = (dirSize(STAGE) / 1024 / 1024).toFixed(1);

console.log('');
console.log('  ╔═══════════════════════════════════════════╗');
console.log('  ║  BUILD COMPLETE                            ║');
console.log('  ╠═══════════════════════════════════════════╣');
console.log(`  ║  Output:  karp-inspector.mcpb`);
console.log(`  ║  Size:    ${bundleSize} (${stageSize}MB uncompressed)`);
console.log(`  ║  Tools:   52`);
console.log(`  ║  Models:  ${modelExists ? 'bundled (offline ready)' : 'NOT bundled (needs internet)'}`);
console.log('  ╠═══════════════════════════════════════════╣');
console.log('  ║  ARCHITECTURE:                             ║');
console.log('  ║  server/index.js runs directly via stdio   ║');
console.log('  ║  (no proxy, no detached spawn)              ║');
console.log('  ║  Data at user DATA_PATH (survives toggles) ║');
console.log('  ╠═══════════════════════════════════════════╣');
console.log('  ║  TO INSTALL:                               ║');
console.log('  ║  1. Claude Desktop → Settings → Extensions ║');
console.log('  ║  2. Install Extension → select .mcpb       ║');
console.log('  ║  3. Configure data folder                  ║');
console.log('  ║  4. Start using — server launches auto     ║');
console.log('  ╚═══════════════════════════════════════════╝');

// Cleanup staging
fs.rmSync(STAGE, { recursive: true, force: true });
console.log('\nStaging cleaned. Done!');
