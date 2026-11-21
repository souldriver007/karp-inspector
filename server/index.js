// ============================================================================
// KARP Inspector — MCP Server (Node.js, stdio)
// Version: 0.5.0
// Author: SoulDriver (Adelaide, Australia)
// Licence: MIT (see LICENSE)
//
// Unified MCP server: Knowledge Graph + Code Intelligence + Filesystem + Terminal
// Hand-rolled MCP protocol — no SDK dependency. Single SQLite database (sql.js).
//
// Transport: stdio only. The old PREMIUM_PORT HTTP mode was removed for
// security — see the note above the readline setup at the bottom of this file.
// ============================================================================

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { log, normaliseAllowedDirs, configureProtected } = require('./utils');

const database = require('./database');
const graph = require('./graph');
const filesystem = require('./filesystem');
const inspector = require('./inspector');
const intelligence = require('./intelligence');

const VERSION = '0.5.0';
const SERVER_NAME = 'karp-inspector';

// ALLOWED_DIRS comes from two possible sources:
//   1. ALLOWED_DIRS env var, semicolon-separated — manual claude_desktop_config.json setups
//   2. process.argv — the .mcpb manifest's "project_dirs" user_config field uses
//      "multiple": true, and per the MCPB spec, multi-select directory/file
//      fields expand into separate CLI args (not a single env string), so
//      Desktop passes them as extra argv entries after the entry point.
// Both are combined and deduped so either config style works.
//
// Normalisation (quote-stripping, absolute-path validation, resolve, realpath)
// lives in utils.normaliseAllowedDirs so this list and the enforced boundary in
// configureBoundary are produced by the same code and cannot drift. Dedupe runs
// AFTER normalisation — `D:\Proj` and `"D:\Proj"` are the same root and used to
// survive as two distinct entries.
const argvDirs = process.argv.slice(2).filter(Boolean);
const envDirs = (process.env.ALLOWED_DIRS || '').split(';').map(d => d.trim()).filter(Boolean);
const ALLOWED_DIRS = [...new Set(normaliseAllowedDirs([...envDirs, ...argvDirs]))];

const DATA_PATH = process.env.DATA_PATH || path.join(
    process.env.USERPROFILE || process.env.HOME || '.', '.karp-premium'
);
const TRASH_DIR = process.env.TRASH_DIR || path.join(DATA_PATH, 'trash');
const ALLOWED_COMMANDS = (process.env.ALLOWED_COMMANDS || '')
    .split(';').map(c => c.trim()).filter(Boolean);

function getAllTools() {
    return [...SERVER_TOOLS, ...filesystem.TOOLS, ...graph.TOOLS, ...inspector.TOOLS, ...intelligence.TOOLS];
}

// Server-level tools handled here rather than in a module, because they report
// on state that only index.js holds (version, boundary, uptime).
const SERVER_TOOLS = [
    {
        name: 'server_status',
        description: 'Diagnostics: server version, uptime, configured directories and allowed commands, database path and size, snapshot health, and index totals. Check this first when something is slow, missing, or behaving unexpectedly.',
        inputSchema: { type: 'object', properties: {} },
    },
];

function handleServerStatus() {
    const db = database.getDb();
    const dbFile = database.getDbPath();
    const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

    let dbSize = 0;
    try { dbSize = fs.statSync(dbFile).size; } catch {}

    let autoSnaps = 0, manualSnaps = 0, lastSnap = null, snapBytes = 0;
    try {
        const snapDir = path.join(path.dirname(dbFile), 'snapshots');
        if (fs.existsSync(snapDir)) {
            const files = fs.readdirSync(snapDir).filter(f => f.endsWith('.db'));
            const autos = files.filter(f => f.startsWith('auto-'));
            autoSnaps = autos.length;
            manualSnaps = files.length - autos.length;
            const stamps = [];
            for (const f of files) {
                const st = fs.statSync(path.join(snapDir, f));
                snapBytes += st.size;
                stamps.push(st.mtime.toISOString());
            }
            lastSnap = stamps.sort().at(-1) || null;
        }
    } catch {}

    let nodes = 0, chunks = 0, roots = 0, fileSnaps = 0;
    try {
        nodes = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
        chunks = db.prepare('SELECT COUNT(*) as c FROM chunks').get().c;
        roots = db.prepare('SELECT COUNT(DISTINCT project_root) as c FROM chunks').get().c;
        fileSnaps = db.prepare('SELECT COUNT(*) as c FROM snapshots').get().c;
    } catch {}

    const allTools = getAllTools();
    return {
        server: SERVER_NAME,
        version: VERSION,
        uptime_seconds: Math.round(process.uptime()),
        node: process.version,
        platform: process.platform,
        tools: { total: allTools.length },
        boundary: {
            enforced: ALLOWED_DIRS.length > 0,
            allowed_dirs: ALLOWED_DIRS,
            note: ALLOWED_DIRS.length === 0 ? 'No project directories configured — all tools will refuse.' : undefined,
        },
        commands: { count: ALLOWED_COMMANDS.length, allowed: ALLOWED_COMMANDS },
        database: {
            path: dbFile,
            size: mb(dbSize),
            nodes,
            chunks,
            indexed_roots: roots,
            file_snapshots: fileSnaps,
            note: roots > 1 ? 'More than one project root is indexed — run list_projects to see what is stored.' : undefined,
        },
        backups: { auto: autoSnaps, manual: manualSnaps, total_size: mb(snapBytes), last: lastSnap },
    };
}

const FILESYSTEM_TOOLS = new Set(filesystem.TOOLS.map(t => t.name));
const GRAPH_TOOLS = new Set(graph.TOOLS.map(t => t.name));
const INSPECTOR_TOOLS = new Set(inspector.TOOLS.map(t => t.name));
const INTELLIGENCE_TOOLS = new Set(intelligence.TOOLS.map(t => t.name));

async function handleToolCall(name, args) {
    if (name === 'server_status') return handleServerStatus();
    if (FILESYSTEM_TOOLS.has(name)) return await filesystem.handleTool(name, args);
    if (GRAPH_TOOLS.has(name)) return await graph.handleTool(name, args);
    if (INSPECTOR_TOOLS.has(name)) return await inspector.handleTool(name, args);
    if (INTELLIGENCE_TOOLS.has(name)) return await intelligence.handleTool(name, args);
    return { error: `Unknown tool: ${name}` };
}

async function handleMessage(message) {
    const { method, id, params = {} } = message;

    if (method === 'initialize') {
        log('INFO', `Initialising ${SERVER_NAME} v${VERSION}`);
        log('INFO', `Data: ${DATA_PATH} | Dirs: ${ALLOWED_DIRS.length > 0 ? ALLOWED_DIRS.join(', ') : '(unrestricted)'} | Commands: ${ALLOWED_COMMANDS.length}`);
        await database.initDatabase(DATA_PATH);
        filesystem.configure(ALLOWED_DIRS, TRASH_DIR, ALLOWED_COMMANDS);
        // TRASH_DIR is normally inside DATA_PATH, but TRASH_DIR env can move it
        // elsewhere — so protect both explicitly rather than assuming nesting.
        configureProtected([DATA_PATH, TRASH_DIR]);
        return {
            jsonrpc: '2.0', id,
            result: {
                protocolVersion: params.protocolVersion || '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: SERVER_NAME, version: VERSION }
            }
        };
    }

    if (method === 'notifications/initialized') { log('INFO', 'Client connected'); return null; }

    if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: getAllTools() } };
    }

    if (method === 'tools/call') {
        const toolName = params.name || '';
        const toolArgs = params.arguments || {};
        try {
            const result = await handleToolCall(toolName, toolArgs);
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
            };
        } catch (err) {
            log('ERROR', `Tool error [${toolName}]: ${err.message}`);
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true }
            };
        }
    }

    if (method === 'ping') { return { jsonrpc: '2.0', id, result: {} }; }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Transport: stdio only ────────────────────────────────────
//
// The HTTP mode that used to live here (PREMIUM_PORT → an http.createServer
// on 127.0.0.1 serving POST /mcp) has been removed. It was dead weight after
// the proxy architecture was retired on 23 July 2026, but it was still
// reachable and it had no authentication of any kind: no token, no Origin
// check, no Content-Type check, no body size limit. Anything that could
// reach the port could call any tool, including write_file, delete_file and
// run_check. A web page could even drive it cross-origin with a simple
// text/plain POST — unable to read the response, but the side effects landed
// regardless.
//
// stdio is the only transport Claude Desktop uses, and it inherits the
// process boundary for free. If HTTP is ever needed again, it needs a shared
// secret, an Origin allowlist and a body cap before the listener opens.

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
        const message = JSON.parse(trimmed);
        const response = await handleMessage(message);
        if (response !== null) process.stdout.write(JSON.stringify(response) + '\n');
    } catch (err) { log('ERROR', `Parse error: ${err.message}`); }
});
log('INFO', `${SERVER_NAME} v${VERSION} starting (stdio mode)`);
