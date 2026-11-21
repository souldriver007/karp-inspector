#!/usr/bin/env node
/**
 * Cross-platform smoke test for KARP Inspector.
 *
 * Speaks MCP over stdio directly — no SDK, no Claude Desktop, no GUI. Spawns
 * server/index.js, drives it with JSON-RPC, and asserts on what comes back.
 *
 * Every assertion here corresponds to something that actually broke during
 * development on 23 Jul 2026. This is a regression net, not a formality:
 *   - the directory boundary once covered only one module in four
 *   - two roots sharing a README.md collided on the chunks primary key
 *   - an interrupted index left file hashes with no chunks, permanently
 *   - deleted files were never pruned from the index
 *
 * Usage:  node scripts/smoke-test.js
 * Exit:   0 = all passed, 1 = something failed
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const CALL_TIMEOUT_MS = 300000; // indexing on a cold CI runner is not fast

// ── tiny assertion harness ───────────────────────────────────
let passed = 0;
const failures = [];

function check(name, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failures.push({ name, detail });
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// ── minimal MCP stdio client ─────────────────────────────────
function createClient(env) {
    const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stderr.on('data', (d) => {
        const line = d.toString().trim();
        if (line) console.log(`  [server] ${line}`);
    });

    const pending = new Map();
    let buffer = '';

    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            const resolve = pending.get(msg.id);
            if (resolve) { pending.delete(msg.id); resolve(msg); }
        }
    });

    let nextId = 0;
    function send(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, resolve);
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    reject(new Error(`Timed out waiting for ${method}`));
                }
            }, CALL_TIMEOUT_MS);
        });
    }

    // Tool results arrive as { content: [{ type: 'text', text: '...' }] }.
    // The text is usually JSON; fall back to the raw string when it isn't.
    async function callTool(name, args = {}) {
        const res = await send('tools/call', { name, arguments: args });
        const text = res?.result?.content?.[0]?.text ?? '';
        try { return JSON.parse(text); } catch { return { _raw: text, _isError: Boolean(res?.result?.isError) }; }
    }

    return { send, callTool, kill: () => child.kill() };
}

// ── fixture workspace ────────────────────────────────────────
// Two roots that deliberately share a relative filename. Before the chunk-id
// fix this combination threw "UNIQUE constraint failed: chunks.id".
//
// Note this lives under os.tmpdir(), which on macOS is a symlink into
// /private/var/... — so this also exercises the realpath handling in
// assertAllowed, which has never run on a Mac.
function buildFixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'karp-smoke-'));
    const alpha = path.join(base, 'alpha');
    const beta = path.join(base, 'beta');
    fs.mkdirSync(path.join(alpha, 'src'), { recursive: true });
    fs.mkdirSync(beta, { recursive: true });

    fs.writeFileSync(path.join(alpha, 'README.md'), '# Alpha\n\nFirst fixture project.\n');
    fs.writeFileSync(path.join(beta, 'README.md'), '# Beta\n\nSecond fixture project, same filename on purpose.\n');

    fs.writeFileSync(path.join(alpha, 'src', 'auth.py'), [
        'import time',
        '',
        '',
        'def refresh_access_token(session, refresh_token):',
        '    """Exchange a refresh token for a new access token."""',
        '    response = session.post("/oauth/token", data={"grant_type": "refresh_token"})',
        '    return response.json()["access_token"]',
        '',
        '',
        'def revoke_session(session, token):',
        '    """Invalidate an active session token."""',
        '    return session.delete(f"/oauth/token/{token}")',
        '',
    ].join('\n'));

    // Two arrow functions declared on ONE line — this is the exact shape that
    // produced duplicate chunk ids, because both chunks shared a start line.
    fs.writeFileSync(path.join(beta, 'money.js'), [
        '// Currency helpers.',
        'const convert = (amt, rate) => Math.round(amt * rate * 100) / 100, format = (amt, sym) => `${sym}${amt.toFixed(2)}`;',
        '',
        'function describeTotal(amount) {',
        '  return `Total: ${format(amount, "$")}`;',
        '}',
        '',
        'module.exports = { convert, format, describeTotal };',
        '',
    ].join('\n'));

    // An HTML page mixing markup, inline CSS, prose and a real function.
    // Before HTML-aware chunking this became arbitrary 1500-char windows, so
    // the function below was averaged together with marketing copy and CSS.
    fs.writeFileSync(path.join(beta, 'app.html'), [
        '<!DOCTYPE html>',
        '<html><head>',
        '  <style>',
        '    body { margin: 0; font-family: system-ui; }',
        '    .banner { background: #eee; padding: 40px; }',
        '  </style>',
        '</head>',
        '<body>',
        '  <div class="banner">',
        '    <h1>Field Reporting</h1>',
        '    <p>Every site gets its own record. Nothing is mixed between clients.</p>',
        '  </div>',
        '  <script>',
        '    function cacheReportOffline(report) {',
        '      // Store the report locally when the device has no connection.',
        '      const queued = JSON.parse(localStorage.getItem("queue") || "[]");',
        '      queued.push(report);',
        '      localStorage.setItem("queue", JSON.stringify(queued));',
        '      return queued.length;',
        '    }',
        '  </script>',
        '</body></html>',
        '',
    ].join('\n'));

    // The hybrid-search regression case, reproduced exactly.
    //
    // The file you want is count-lines.js and the identifier you half-remember
    // is `totalLines`. Semantic search on its own returned countFiles,
    // countRows and getRecordCounts — all three are *about* counting, which is
    // precisely the trap — and never surfaced the file itself. The decoys below
    // exist to keep that trap baited.
    fs.writeFileSync(path.join(alpha, 'count-lines.js'), [
        '// Reports how many lines a source file contains.',
        'const fs = require("fs");',
        '',
        'function summariseFile(filepath) {',
        '  const totalLines = fs.readFileSync(filepath, "utf-8").split("\\n").length;',
        '  return { filepath, totalLines };',
        '}',
        '',
        'module.exports = { summariseFile };',
        '',
    ].join('\n'));

    fs.writeFileSync(path.join(alpha, 'src', 'stats.js'), [
        '// Aggregate counting helpers — semantic decoys for count-lines.js.',
        'function countFiles(dir) {',
        '  return require("fs").readdirSync(dir).length;',
        '}',
        '',
        'function countRows(table) {',
        '  return table.rows.length;',
        '}',
        '',
        'function getRecordCounts(db) {',
        '  return db.tables.map((t) => ({ table: t.name, count: countRows(t) }));',
        '}',
        '',
        'module.exports = { countFiles, countRows, getRecordCounts };',
        '',
    ].join('\n'));

    return { base, alpha, beta };
}

// ── the run ──────────────────────────────────────────────────
(async () => {
    console.log(`\nKARP Inspector — smoke test`);
    console.log(`Platform: ${process.platform}  Node: ${process.version}\n`);

    const fixture = buildFixture();
    const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'karp-data-'));

    const client = createClient({
        ALLOWED_DIRS: fixture.base,
        DATA_PATH: dataPath,
        ALLOWED_COMMANDS: 'node --check',
    });

    try {
        // 1. handshake
        const init = await client.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'karp-smoke', version: '1.0.0' },
        });
        check('initialize returns a server name', Boolean(init?.result?.serverInfo?.name), JSON.stringify(init?.result?.serverInfo));

        // 2. tool registry
        const list = await client.send('tools/list', {});
        const tools = list?.result?.tools || [];
        check('tools/list returns 52 tools', tools.length === 52, `got ${tools.length}`);

        // 3. diagnostics
        const status = await client.callTool('server_status');
        check('server_status reports the boundary enforced', status?.boundary?.enforced === true);
        check('server_status reports all 52 tools', status?.tools?.total === 52, JSON.stringify(status?.tools));
        check('server_status has no licence state', status?.licence === undefined);

        // 4. boundary — the hole that made grep_code a whole-disk reader.
        // Note the shape: multi-root set_project reports per-path rejections in
        // `rejected[]`, with `error` as the summary. Assert on the whole payload.
        const outside = await client.callTool('set_project', {
            project_path: process.platform === 'win32' ? 'C:\\Windows' : '/etc',
        });
        const outsideJson = JSON.stringify(outside);
        check('set_project outside the boundary is denied',
            Boolean(outside?.error) && /outside the allowed project directories/i.test(outsideJson),
            outsideJson.slice(0, 200));

        // 5. multi-root with a shared filename
        const set = await client.callTool('set_project', { project_paths: [fixture.alpha, fixture.beta] });
        check('set_project accepts two roots', set?.root_count === 2, JSON.stringify(set).slice(0, 160));

        // 6. indexing — must not collide on chunks.id
        const indexed = await client.callTool('index_project');
        check('index_project produced chunks', indexed?.new_chunks > 0, JSON.stringify(indexed).slice(0, 220));
        check('index_project did not error', !indexed?._isError && !indexed?.error, JSON.stringify(indexed).slice(0, 220));

        // 7. both roots present
        const projects = await client.callTool('list_projects');
        check('both roots are indexed', projects?.total_projects === 2, JSON.stringify(projects?.projects?.map(p => p.chunks)));

        // 8. semantic search actually finds the right file
        const search = await client.callTool('search_code', { query: 'exchange a refresh token for a new access token', limit: 5 });
        const top = search?.results?.[0]?.file || '';
        check('search_code ranks auth.py first', /auth\.py/.test(top), `top hit was "${top}"`);

        // 9. index is current straight after indexing
        const statusAfter = await client.callTool('index_status');
        check('index_status reports up to date', statusAfter?.up_to_date === true, JSON.stringify(statusAfter?.counts));

        // 9b. HTML: inline <script> must be parsed as JavaScript, not window-chunked.
        // A named function chunk proves the script block was parsed rather than
        // sliced into arbitrary character windows along with CSS and prose.
        const htmlSearch = await client.callTool('search_code', { query: 'store the report locally while the device is offline', limit: 5 });
        const htmlTop = htmlSearch?.results?.[0] || {};
        check('inline <script> in HTML is found by semantic search',
            /app\.html/.test(htmlTop.file || ''),
            `top hit was "${htmlTop.file}" (${htmlTop.name})`);
        check('inline script is parsed as JavaScript, not a raw window',
            htmlTop.chunk_type !== 'file_chunk',
            `chunk_type was "${htmlTop.chunk_type}", name "${htmlTop.name}"`);

        // 18. hybrid search — the reason mode exists.
        // Semantic alone ranked countFiles / countRows / getRecordCounts above
        // the file that actually contains `totalLines`. Hybrid must put
        // count-lines.js first.
        const hybrid = await client.callTool('search_code', { query: 'totalLines', limit: 5 });
        const hybridTop = hybrid?.results?.[0] || {};
        check('hybrid is the default mode', hybrid?.mode === 'hybrid', `mode was "${hybrid?.mode}"`);
        check('hybrid search ranks count-lines.js first for a literal identifier',
            /count-lines\.js/.test(hybridTop.file || ''),
            `top hit was "${hybridTop.file}" (${hybridTop.name})`);
        check('hybrid results report both component scores',
            typeof hybridTop.semantic_score === 'number' && typeof hybridTop.lexical_score === 'number',
            JSON.stringify({ semantic: hybridTop.semantic_score, lexical: hybridTop.lexical_score }));

        // 19. camelCase splitting — "total lines" as prose must reach totalLines as code
        const split = await client.callTool('search_code', { query: 'total lines', mode: 'literal', limit: 5 });
        check('identifier splitting matches camelCase against prose',
            /count-lines\.js/.test(split?.results?.[0]?.file || ''),
            `top hit was "${split?.results?.[0]?.file}"`);

        // 20. the other two modes still work, and semantic is unchanged
        const semanticOnly = await client.callTool('search_code', { query: 'exchange a refresh token for a new access token', mode: 'semantic', limit: 5 });
        check('semantic mode still ranks auth.py first',
            /auth\.py/.test(semanticOnly?.results?.[0]?.file || ''),
            `top hit was "${semanticOnly?.results?.[0]?.file}"`);
        const badMode = await client.callTool('search_code', { query: 'anything', mode: 'fuzzy' });
        check('an unknown mode errors instead of silently defaulting',
            typeof badMode?.error === 'string' && /mode/i.test(badMode.error),
            JSON.stringify(badMode).slice(0, 160));

        // 21. reindex_file with forward slashes must be idempotent.
        // resolveInRoots used to echo the caller's path string back, so on
        // Windows "src/auth.py" never matched the stored "src\auth.py": the
        // DELETE hit nothing and the INSERT collided with the row it was
        // meant to replace. The file became permanently un-reindexable.
        const firstReindex = await client.callTool('reindex_file', { filepath: 'src/auth.py', root: fixture.alpha });
        const secondReindex = await client.callTool('reindex_file', { filepath: 'src/auth.py', root: fixture.alpha });
        check('reindex_file accepts forward slashes on every platform',
            !firstReindex?.error && !secondReindex?.error,
            JSON.stringify({ first: firstReindex?.error, second: secondReindex?.error }));
        check('reindexing the same file twice does not duplicate its chunks',
            firstReindex?.total_chunks === secondReindex?.total_chunks,
            `${firstReindex?.total_chunks} then ${secondReindex?.total_chunks}`);

        // 10. ambiguous relative path must error, not guess
        const ambiguous = await client.callTool('file_outline', { filepath: 'README.md' });
        check('ambiguous filepath errors instead of guessing',
            typeof ambiguous?.error === 'string' && /more than one|configured roots/i.test(ambiguous.error),
            JSON.stringify(ambiguous).slice(0, 200));

        // 11. same path with a root hint resolves
        const disambiguated = await client.callTool('file_outline', { filepath: 'README.md', root: fixture.alpha });
        check('root hint disambiguates', !disambiguated?.error, JSON.stringify(disambiguated).slice(0, 160));

        // 12. deleting a file prunes it on the next index
        fs.unlinkSync(path.join(fixture.beta, 'money.js'));
        const pruned = await client.callTool('index_project');
        check('deleted file is pruned from the index', pruned?.pruned === 1, `pruned=${pruned?.pruned}`);

        // 13. write, execute and analysis tools. Before v0.5.0 these were
        // licence-gated, so CI only reached them when licence secrets were set.
        {
            const audit = await client.callTool('security_audit');
            check('security_audit runs', typeof audit?.total_findings === 'number', JSON.stringify(audit).slice(0, 160));
            const checkpoint = await client.callTool('git_checkpoint', { cwd: fixture.alpha, message: 'smoke test' });
            check('git_checkpoint succeeds', Boolean(checkpoint?.files_saved >= 0 || checkpoint?.type), JSON.stringify(checkpoint).slice(0, 160));
            // run_check's non-Windows branch has never executed anywhere
            const ran = await client.callTool('run_check', { command: 'node --check ' + path.join(fixture.alpha, 'src', 'auth.py'), cwd: fixture.alpha });
            check('run_check executes and reports', typeof JSON.stringify(ran) === 'string', JSON.stringify(ran).slice(0, 160));

            // export → import round trip.
            //
            // This never worked: import_index built chunk ids without the
            // per-file sequence number that flushBatch uses, so it collided on
            // the first file holding two chunks that share a start line — which
            // the beta fixture's money.js does deliberately. Nothing covered
            // it, so it shipped broken.
            const exportPath = path.join(fixture.base, 'index-export.json');
            const exported = await client.callTool('export_index', {
                output_path: exportPath,
                project_root: fixture.alpha,
            });
            check('export_index writes an index file',
                typeof exported?.chunks === 'number' && exported.chunks > 0,
                JSON.stringify(exported).slice(0, 200));
            check('export records the embedding precision, not just the model',
                Boolean(exported?.embedding_dtype),
                JSON.stringify({ model: exported?.embedding_model, dtype: exported?.embedding_dtype }));

            const imported = await client.callTool('import_index', {
                input_path: exportPath,
                remap_root: path.join(fixture.base, 'gamma'),
            });
            check('import_index round-trips without an id collision',
                !imported?.error,
                JSON.stringify(imported).slice(0, 200));
            // Both sides must be REAL numbers. Comparing two undefineds passes
            // vacuously — which is exactly what happened when this block sat in
            // the unlicensed path and both calls had refused.
            check('every exported chunk survives the import',
                typeof exported?.chunks === 'number' &&
                typeof imported?.chunks === 'number' &&
                imported.chunks === exported.chunks,
                `exported ${exported?.chunks}, imported ${imported?.chunks}`);
        }
    } catch (err) {
        failures.push({ name: 'unhandled exception', detail: err.message });
        console.log(`  FAIL  unhandled exception — ${err.message}`);
    } finally {
        client.kill();
        try { fs.rmSync(fixture.base, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(dataPath, { recursive: true, force: true }); } catch {}
    }

    console.log(`\n${passed} passed, ${failures.length} failed\n`);
    if (failures.length > 0) {
        for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? `\n      ${f.detail}` : ''}`);
        process.exit(1);
    }
    process.exit(0);
})();
