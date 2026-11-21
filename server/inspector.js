// ============================================================================
// KARP Inspector — Code Intelligence Module
// Author: SoulDriver (Adelaide, Australia)
// Ported from KARP Inspector Lite with unified SQLite storage.
// Semantic code search, grep, outline, diff, version tracking.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { log, computeHash, isIgnored, matchGlob, assertAllowed, loadGitignore } = require('./utils');

// Hostile or accidental catastrophic-backtracking patterns freeze this
// single-threaded server indefinitely, and none of the spawnSync-style
// timeouts apply. A length cap is a blunt but effective first line.
const MAX_PATTERN_LENGTH = 1000;
const { getDb, embeddingToBlob, blobToEmbedding, cosineSimilarity } = require('./database');
const { generateEmbedding, generateEmbeddings, MODEL_ID, MODEL_DTYPE } = require('./graph');
let intelligence = null;
try { intelligence = require('./intelligence'); } catch {}

// ── Configuration ──────────────────────────────────────────────

let projectRoot = '';

// Multi-root support. projectRoots is the source of truth; projectRoot is kept
// as projectRoots[0] so single-root call sites keep working unchanged. A
// monorepo with frontend/ and api/, or a project plus its shared library, no
// longer needs constant set_project switching.
//
// This only became possible once chunk ids were namespaced by root — before
// that, two roots sharing any relative path (README.md, src/index.js) collided
// on the chunks primary key and the second index failed outright.
let projectRoots = [];

function setRoots(roots) {
    projectRoots = roots;
    projectRoot = roots[0] || '';
}

// Which configured root owns this absolute path? Longest match wins, so a
// nested root inside another resolves to the more specific one.
function rootOwning(absPath) {
    let best = null;
    for (const r of projectRoots) {
        if (absPath === r || absPath.startsWith(r + path.sep)) {
            if (!best || r.length > best.length) best = r;
        }
    }
    return best;
}

// Path relative to whichever root owns it — replaces path.relative(projectRoot, f),
// which produced ../.. garbage for files under a secondary root.
//
// The basename fallback is a last resort and should never fire in practice: it
// collapses src/utils.py and tests/utils.py to the same "utils.py", which then
// collide in the index. Log loudly if it ever happens rather than corrupting
// paths quietly.
function relativeToOwner(absPath) {
    const r = rootOwning(absPath);
    if (r) return path.relative(r, absPath);
    log('WARN', `No configured root owns ${absPath} — falling back to basename, which risks path collisions. Roots: ${projectRoots.join(', ') || '(none)'}`);
    return path.basename(absPath);
}

// Resolve a caller-supplied path against the configured roots.
//
// Returns { root, absPath, relPath } on success, or { error } — never a silent
// guess. Three ways in:
//   • absolute path      → resolved directly, must sit inside a root
//   • relative + rootHint → searched only in that root
//   • relative           → searched in all roots; ambiguity is an ERROR, not
//                          a first-match guess. Monorepos share package.json,
//                          README.md and src/index.js across roots, and
//                          silently picking the wrong one made reindex_file
//                          re-index the wrong file while the edited one stayed
//                          stale in the index.
function resolveInRoots(inputPath, rootHint) {
    if (!inputPath) return { error: 'No filepath given.' };

    if (path.isAbsolute(inputPath)) {
        const abs = path.resolve(inputPath);
        const owner = rootOwning(abs);
        if (!owner) return { error: `"${inputPath}" is not inside any configured project root.` };
        if (!fs.existsSync(abs)) return { error: `File not found: ${inputPath}` };
        return { root: owner, absPath: abs, relPath: path.relative(owner, abs) };
    }

    let searchRoots = projectRoots;
    if (rootHint) {
        const wanted = path.resolve(rootHint);
        searchRoots = projectRoots.filter(r => r === wanted);
        if (searchRoots.length === 0) {
            return { error: `"${rootHint}" is not one of the configured roots: ${projectRoots.join(', ')}` };
        }
    }

    const hits = [];
    for (const r of searchRoots) {
        const abs = path.join(r, inputPath);
        // relPath MUST be re-derived, not echoed back from inputPath. Callers
        // write "server/inspector.js"; index_project stores chunks, hashes and
        // snapshots under relativeToOwner(), which is "server\inspector.js" on
        // Windows. Echoing the caller's string made reindex_file DELETE on a
        // key that matched nothing, then INSERT a chunk id identical to the
        // existing row — UNIQUE constraint failed, and the file could never be
        // re-indexed. path.relative always emits the platform separator, so
        // both paths agree.
        if (fs.existsSync(abs)) hits.push({ root: r, absPath: abs, relPath: path.relative(r, abs) });
    }

    if (hits.length === 0) return { error: `File not found in any configured root: ${inputPath}` };
    if (hits.length > 1) {
        return {
            error: `"${inputPath}" exists in ${hits.length} configured roots — pass "root" to say which one, ` +
                   `or use an absolute path. Candidates: ${hits.map(h => h.root).join(' | ')}`,
        };
    }
    return hits[0];
}

// SQL helper: "project_root IN (?, ?, ...)" plus the params to bind.
function rootsClause() {
    if (projectRoots.length === 0) return { sql: 'project_root = ?', params: [''] };
    return { sql: `project_root IN (${projectRoots.map(() => '?').join(', ')})`, params: [...projectRoots] };
}

const DEFAULTS = {
    // Scope: this indexes CODE. Config and data formats — .json, .yaml, .toml,
    // .ini — are deliberately excluded. Semantic embedding over data is close
    // to worthless, and in practice the files that dominate are generated:
    // measured on a ~60k-line production codebase, adding .json put package-lock.json and a bundled
    // model's tokenizer.json into the index, where they took 7 of the top 10
    // results for a generic query. grep_code reads from disk and needs no
    // index, so literal lookups in those files still work.
    //
    // The original nine covered Python and the JS/web stack and nothing else.
    // A Go, Rust, Java, C#, Ruby, PHP, Vue or Svelte developer pointed Inspector
    // at their project and got zero chunks with no error — the tool looked
    // broken. Anything without a dedicated chunker falls through to
    // chunkFixedSize, which the markdown results showed is acceptable for
    // uniform content and far better than invisibility.
    includeExtensions: new Set([
        // web / scripting
        '.py', '.js', '.ts', '.jsx', '.tsx', '.vue', '.svelte',
        '.html', '.css', '.php', '.rb',
        // compiled / typed
        '.go', '.rs', '.java', '.cs', '.kt', '.swift', '.scala',
        '.c', '.h', '.cpp', '.hpp', '.ex', '.exs',
        // query and shell — the measured gap: that codebase's SQL migrations and
        // build scripts were entirely invisible
        '.sql', '.sh', '.ps1', '.bat',
        // prose
        '.md', '.txt',
    ]),
    skipDirs: new Set([
        '__pycache__', '.git', 'node_modules', 'venv', '.venv',
        'env', 'dist', 'build', '.next', '.nuxt', 'coverage',
        '.tox', '.mypy_cache', '.pytest_cache', 'egg-info',
        '.eggs', '.cache', '.tmp', 'vendor', '.karp-inspector',
        '.karp-premium', 'backups', 'data'
    ]),
    maxFileSize: 1_048_576,   // 1MB
    maxChunkChars: 1500,
    maxWalkDepth: 20,         // symlink-cycle / runaway-recursion cap
};

// Pre-flight caps for index_project. Without these, pointing the indexer at
// something bigger than a project (a whole workspace root, a folder of old
// site revisions) silently walks the tree and embeds for minutes with no
// warning. git_checkpoint already guards its no-git path this way; the
// indexer had the same exposure and none of the protection.
const MAX_INDEX_FILES = 2000;
const MAX_INDEX_BYTES = 50 * 1024 * 1024; // 50MB of indexable source

// ── Tool definitions ───────────────────────────────────────────

const TOOLS = [
    {
        name: 'search_code',
        description: 'Search your codebase. Hybrid by default: semantic meaning and literal term matching are ranked separately and fused, so it finds code by concept AND by half-remembered identifiers, config keys or error strings. Returns file paths, line numbers and both component scores. Requires index_project first.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural language or code search query' },
                mode: { type: 'string', enum: ['hybrid', 'semantic', 'literal'], description: 'hybrid (default) fuses both rankings; semantic is meaning only; literal is term matching only' },
                limit: { type: 'integer', description: 'Max results (default 8)' },
                file_filter: { type: 'string', description: 'Filter by filename substring' },
                ext_filter: { type: 'string', description: 'Filter by extension (.py, .js, etc.)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'grep_code',
        description: 'Exact string or regex search across the codebase. Returns matching lines with context. Reads files straight from disk — does NOT require index_project. For concepts rather than literals, use search_code.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'String or regex pattern' },
                is_regex: { type: 'boolean', description: 'Treat as regex (default: false)' },
                case_sensitive: { type: 'boolean', description: 'Case-sensitive (default: true)' },
                limit: { type: 'integer', description: 'Max matches (default: 50)' },
                context_lines: { type: 'integer', description: 'Context lines around match (default: 2)' },
                file_filter: { type: 'string', description: 'Filter by filename' },
                ext_filter: { type: 'string', description: 'Filter by extension' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'file_outline',
        description: 'Structural outline of any file — classes, methods, functions with signatures and line numbers — without loading content. Accepts an absolute path, or a path relative to a project root. Reads the file straight from disk — does NOT require index_project.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'Absolute path, or path relative to a project root' },
                root: { type: 'string', description: 'Which project root to resolve against, when the same relative path exists in more than one' },
                include_body: { type: 'boolean', description: 'Include first 5 lines of body (default: false)' },
            },
            required: ['filepath'],
        },
    },
    {
        name: 'index_project',
        description: 'Index or re-index the project for semantic code search across every configured root. Only processes changed files via SHA256. Commits in batches — chunks and their file hashes land in the same transaction, so an interrupted run leaves a smaller correct index rather than a poisoned one. Stops on a wall-clock budget and returns status "partial" with remaining_files; call again until that reaches 0. Large trees are indexed across several calls rather than failing.',
        inputSchema: {
            type: 'object',
            properties: {
                force: { type: 'boolean', description: 'Re-index all files (default: false)' },
                confirm: { type: 'boolean', description: 'Proceed even if the root exceeds the pre-flight size/file thresholds (default: false)' },
                max_seconds: { type: 'number', description: 'Wall-clock budget for this call before returning "partial" (default: 180). Lower it if calls are being cancelled.' },
                max_chunks: { type: 'number', description: 'Optional chunk ceiling for this call, on top of the time budget. Unlimited by default.' },
            },
        },
    },
    {
        name: 'reindex_file',
        description: 'Re-index a single file after editing. Saves a snapshot for version tracking. Accepts an absolute path, or a path relative to a project root.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'Absolute path, or path relative to a project root' },
                root: { type: 'string', description: 'Which project root to resolve against, when the same relative path exists in more than one' },
            },
            required: ['filepath'],
        },
    },
    {
        name: 'file_history',
        description: 'List saved snapshots of a file from the database.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'Relative path from project root' },
            },
            required: ['filepath'],
        },
    },
    {
        name: 'file_diff',
        description: 'Diff between two snapshots of a file, or compare a snapshot against the live file.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'Relative path from project root' },
                root: { type: 'string', description: 'Which project root, when the same relative path exists in more than one' },
                old_index: { type: 'integer', description: 'Older snapshot (0=latest, 1=previous, default: 1)' },
                new_index: { type: 'integer', description: 'Newer snapshot (0=latest, -1=live, default: 0)' },
            },
            required: ['filepath'],
        },
    },
    {
        name: 'project_stats',
        description: 'Index statistics — files, chunks, extensions. Verify the project is indexed before searching.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'set_project',
        description: 'Set the active project — one directory, or several at once for a monorepo or a project plus its shared libraries. All search, grep and index tools then span every configured root. Loads cached indexes from SQLite where they exist.',
        inputSchema: {
            type: 'object',
            properties: {
                project_path: { type: 'string', description: 'Absolute path to a single project directory' },
                project_paths: { type: 'array', items: { type: 'string' }, description: 'Several absolute paths to work across at once' },
                add: { type: 'boolean', description: 'Append to the current roots instead of replacing them (default: false)' },
            },
        },
    },
    {
        name: 'list_projects',
        description: 'List every project root stored in the index — chunk counts, file counts, last indexed date, and whether the path still exists on disk. Use this to see what is actually taking up space before calling forget_project.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'index_status',
        description: 'Compare the index against the current state of disk: which files are new, changed, or deleted since the last index. Tells you whether index_project needs running at all.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'forget_project',
        description: 'Delete the stored index for one project root — chunks, file hashes, and optionally its file snapshots. The only way to reclaim space from a root indexed by mistake. Dry run by default.',
        inputSchema: {
            type: 'object',
            properties: {
                project_root: { type: 'string', description: 'Exact root path as shown by list_projects' },
                include_snapshots: { type: 'boolean', description: 'Also delete saved file snapshots for this root (default: false)' },
                confirm: { type: 'boolean', description: 'Must be true to actually delete (default: false = dry run)' },
            },
            required: ['project_root'],
        },
    },
    {
        name: 'export_index',
        description: 'Export one project root\u2019s index — chunks, embeddings and file hashes — to a portable JSON file. Lets you index once on a fast machine and move the result, instead of re-embedding everywhere.',
        inputSchema: {
            type: 'object',
            properties: {
                output_path: { type: 'string', description: 'Absolute path to write the export file to' },
                project_root: { type: 'string', description: 'Root to export (default: the active project)' },
            },
            required: ['output_path'],
        },
    },
    {
        name: 'import_index',
        description: 'Import an index previously written by export_index. Can remap the project root, so an index built at one path works at another. Refuses to clobber an existing index unless told to.',
        inputSchema: {
            type: 'object',
            properties: {
                input_path: { type: 'string', description: 'Absolute path to the exported JSON file' },
                remap_root: { type: 'string', description: 'Store under this root path instead of the one recorded in the file' },
                overwrite: { type: 'boolean', description: 'Replace an existing index for that root (default: false)' },
            },
            required: ['input_path'],
        },
    },
];

// ── File Discovery ─────────────────────────────────────────────

function discoverFiles(rootDir) {
    const files = [];
    // Respect .gitignore, like every walker in filesystem.js does. This one
    // didn't — isIgnored was imported and never called — so the indexer
    // happily embedded gitignored build output whenever the folder name
    // wasn't in skipDirs.
    const ignorePatterns = loadGitignore(rootDir);
    function walk(dir, depth = 0) {
        if (depth > DEFAULTS.maxWalkDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                if (!DEFAULTS.skipDirs.has(entry.name) && !entry.name.startsWith('.') && !isIgnored(entry.name, ignorePatterns)) {
                    walk(fullPath, depth + 1);
                }
                continue;
            }
            if (!entry.isFile()) continue;
            if (isIgnored(entry.name, ignorePatterns)) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (!DEFAULTS.includeExtensions.has(ext)) continue;
            try { if (fs.statSync(fullPath).size > DEFAULTS.maxFileSize) continue; } catch { continue; }
            files.push(fullPath);
        }
    }
    walk(rootDir);
    return files;
}

// ── Code Chunking ──────────────────────────────────────────────

function chunkPython(filepath, source) {
    const chunks = [];
    const relPath = relativeToOwner(filepath);
    const lines = source.split('\n');
    const funcStartRegex = /^( {0,8})(async\s+)?def\s+(\w+)\s*\(/;
    const classRegex = /^( {0,4})class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/;
    let currentChunk = null;
    let currentIndent = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const classMatch = line.match(classRegex);
        const funcStartMatch = line.match(funcStartRegex);

        if (classMatch || funcStartMatch) {
            if (currentChunk && currentChunk.lines.length > 0) {
                currentChunk.line_end = i;
                currentChunk.text = currentChunk.lines.join('\n');
                delete currentChunk.lines;
                chunks.push(currentChunk);
            }
            const indent = (classMatch || funcStartMatch)[1].length;
            const name = classMatch ? classMatch[2] : funcStartMatch[3];
            const type = classMatch ? 'class' : 'function';
            currentChunk = { name, chunk_type: type, filepath: relPath, line_start: i + 1, line_end: i + 1, lines: [line] };
            currentIndent = indent;

            if (funcStartMatch && !line.includes('):') && !line.match(/\)\s*(->[^:]*)?:\s*$/)) {
                for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
                    currentChunk.lines.push(lines[j]);
                    if (lines[j].includes('):') || lines[j].match(/\)\s*(->[^:]*)?:\s*$/)) { i = j; break; }
                }
            }
        } else if (currentChunk) {
            const lineIndent = line.match(/^(\s*)/)[1].length;
            if (line.trim() === '' || lineIndent > currentIndent) {
                currentChunk.lines.push(line);
            } else {
                currentChunk.line_end = i;
                currentChunk.text = currentChunk.lines.join('\n');
                delete currentChunk.lines;
                chunks.push(currentChunk);
                currentChunk = null;
            }
        }
    }
    if (currentChunk && currentChunk.lines.length > 0) {
        currentChunk.line_end = lines.length;
        currentChunk.text = currentChunk.lines.join('\n');
        delete currentChunk.lines;
        chunks.push(currentChunk);
    }
    if (chunks.length === 0 && source.trim()) {
        chunks.push({ name: `${path.basename(filepath)}:full`, chunk_type: 'file_chunk', filepath: relPath, line_start: 1, line_end: lines.length, text: source.trim() });
    }
    return chunks;
}

function chunkJavaScript(filepath, source) {
    const chunks = [];
    const relPath = relativeToOwner(filepath);
    const lines = source.split('\n');

    try {
        const acorn = require('acorn');
        const walk = require('acorn-walk');
        const ast = acorn.parse(source, {
            ecmaVersion: 'latest', sourceType: 'module', locations: true,
            allowImportExportEverywhere: true, allowReturnOutsideFunction: true
        });
        walk.simple(ast, {
            FunctionDeclaration(node) {
                chunks.push({ name: node.id ? node.id.name : '(anonymous)', chunk_type: 'function', filepath: relPath, line_start: node.loc.start.line, line_end: node.loc.end.line, text: lines.slice(node.loc.start.line - 1, node.loc.end.line).join('\n') });
            },
            ClassDeclaration(node) {
                chunks.push({ name: node.id ? node.id.name : '(anonymous)', chunk_type: 'class', filepath: relPath, line_start: node.loc.start.line, line_end: node.loc.end.line, text: lines.slice(node.loc.start.line - 1, node.loc.end.line).join('\n') });
            },
            VariableDeclaration(node) {
                for (const decl of node.declarations) {
                    if (decl.init && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')) {
                        chunks.push({ name: decl.id ? decl.id.name : '(anonymous)', chunk_type: 'function', filepath: relPath, line_start: node.loc.start.line, line_end: node.loc.end.line, text: lines.slice(node.loc.start.line - 1, node.loc.end.line).join('\n') });
                    }
                }
            }
        });
    } catch (e) {
        log('WARN', `Acorn parse failed for ${filepath}: ${e.message}`);
        return chunkFixedSize(filepath, source);
    }
    if (chunks.length === 0 && source.trim()) return chunkFixedSize(filepath, source);
    return chunks;
}

function chunkFixedSize(filepath, source) {
    const chunks = [];
    const relPath = relativeToOwner(filepath);
    const lines = source.split('\n');
    if (!source.trim()) return chunks;
    let currentText = '';
    let chunkStart = 1;
    for (let i = 0; i < lines.length; i++) {
        currentText += lines[i] + '\n';
        if (currentText.length >= DEFAULTS.maxChunkChars || i === lines.length - 1) {
            chunks.push({ name: `${path.basename(filepath)}:L${chunkStart}-${i + 1}`, chunk_type: 'file_chunk', filepath: relPath, line_start: chunkStart, line_end: i + 1, text: currentText.trim() });
            chunkStart = i + 2;
            currentText = '';
        }
    }
    return chunks;
}

/**
 * HTML-aware chunking.
 *
 * Previously .html fell through to chunkFixedSize, which cuts arbitrary
 * 1500-character windows. In a real project that is disastrous for search
 * quality: a single window can contain closing divs, inline CSS, marketing
 * prose and a fragment of JavaScript, all averaged into one embedding. On a
 * 75-file field-app repo, 700 of 917 chunks were HTML, so three quarters of
 * the index was soup — a query about offline storage ranked the service
 * worker fourth, behind a landing page's marketing copy, with every score
 * inside a 0.005 band.
 *
 * Three passes instead:
 *   1. inline <script> bodies are parsed as real JavaScript, so functions
 *      become named chunks with correct absolute line numbers
 *   2. inline <style> is skipped — in single-file pages it is bulky and
 *      contributes nothing to a code search
 *   3. what remains has tags stripped and is chunked as prose, keeping real
 *      line numbers so file_outline and diffs still line up
 */
function chunkHtml(filepath, source) {
    const chunks = [];
    const relPath = relativeToOwner(filepath);
    const basename = path.basename(filepath);
    const lines = source.split('\n');
    const skipLine = new Array(lines.length).fill(false);

    const lineAt = (index) => source.slice(0, index).split('\n').length;
    const blockRe = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

    let match;
    while ((match = blockRe.exec(source)) !== null) {
        const tag = match[1].toLowerCase();
        const attrs = match[2] || '';
        const body = match[3] || '';

        // Mark the whole block so pass 3 doesn't re-index it as prose.
        const blockStart = lineAt(match.index);
        const blockEnd = lineAt(match.index + match[0].length);
        for (let i = blockStart - 1; i < blockEnd && i < skipLine.length; i++) skipLine[i] = true;

        if (tag === 'style') continue;                       // CSS: noise for code search
        if (/\bsrc\s*=/i.test(attrs)) continue;              // external script, no body here
        if (!body.trim()) continue;

        // Skip non-JS payloads: JSON-LD, x-template, text/html partials.
        const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
        if (typeMatch && !/javascript|module|ecmascript/i.test(typeMatch[1])) continue;

        const bodyStartLine = lineAt(match.index + match[0].indexOf(body));

        // Parse the body as standalone JavaScript, then shift the line numbers
        // back into the coordinates of the HTML file.
        let inner = [];
        try { inner = chunkJavaScript(filepath, body); } catch { inner = []; }

        for (const c of inner) {
            const start = c.line_start + bodyStartLine - 1;
            const end = c.line_end + bodyStartLine - 1;
            const isWindow = c.chunk_type === 'file_chunk';
            chunks.push({
                ...c,
                filepath: relPath,
                // Regenerate window names — the originals carry line numbers
                // relative to the script body, which are wrong once shifted.
                name: isWindow ? `${basename}:script:L${start}-${end}` : `${basename}:${c.name}`,
                chunk_type: isWindow ? 'inline_script' : c.chunk_type,
                line_start: start,
                line_end: end,
            });
        }
    }

    // Pass 3: visible text with tags stripped, real line numbers preserved.
    let buffer = '';
    let bufferStart = 0;
    let lastLine = 0;

    /**
     * Does this look like prose, or like a navigation menu?
     *
     * Separating markup text from code was necessary but not sufficient: a
     * sidebar of "Home / Dashboard / Fuel Log / Time Sheets" used to be diluted
     * inside a mixed window, and isolating it made it a clean, coherent chunk —
     * which embeds *confidently* and outranks real code. Cleaner noise is worse
     * noise. Require something sentence-shaped before indexing.
     */
    const looksLikeProse = (text) => {
        const fragments = text.split('\n').map(s => s.trim()).filter(Boolean);
        if (fragments.length === 0) return false;
        // At least one fragment long enough to be a sentence rather than a label.
        const hasSentence = fragments.some(f => f.length >= 50 && /[a-z]{3}\s+[a-z]{3}/i.test(f));
        // And label lists are overwhelmingly short fragments.
        const longEnough = fragments.filter(f => f.length >= 30).length;
        return hasSentence && longEnough / fragments.length >= 0.25;
    };

    const flush = () => {
        const text = buffer.trim();
        if (text.length >= 60 && looksLikeProse(text)) {
            chunks.push({
                name: `${basename}:text:L${bufferStart}-${lastLine}`,
                chunk_type: 'markup_text',
                filepath: relPath,
                line_start: bufferStart,
                line_end: lastLine,
                text,
            });
        }
        buffer = '';
        bufferStart = 0;
    };

    // Decode entities so emoji codepoints and escapes don't get embedded as
    // literal "&#129514;" text, which is pure noise in a vector.
    const decodeEntities = (s) => s
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ' '; }
        })
        .replace(/&#(\d+);/g, (_, dec) => {
            try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ' '; }
        })
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        // Emoji and symbol codepoints carry no useful meaning for code search.
        .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/gu, ' ');

    for (let i = 0; i < lines.length; i++) {
        if (skipLine[i]) { flush(); continue; }

        const text = decodeEntities(
            lines[i]
                .replace(/<!--[\s\S]*?-->/g, ' ')
                .replace(/<[^>]*>/g, ' ')
        ).replace(/\s+/g, ' ').trim();

        if (!text) continue;
        if (!bufferStart) bufferStart = i + 1;
        buffer += text + '\n';
        lastLine = i + 1;
        if (buffer.length >= DEFAULTS.maxChunkChars) flush();
    }
    flush();

    // A page that is pure markup with no script and no readable text still
    // needs one chunk, or the file vanishes from the index entirely.
    if (chunks.length === 0 && source.trim()) {
        return chunkFixedSize(filepath, source);
    }

    return chunks;
}

function chunkFile(filepath, source) {
    const ext = path.extname(filepath).toLowerCase();
    if (ext === '.py') return chunkPython(filepath, source);
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) return chunkJavaScript(filepath, source);
    if (['.html', '.htm'].includes(ext)) return chunkHtml(filepath, source);
    return chunkFixedSize(filepath, source);
}

// ── File Outline ───────────────────────────────────────────────

function buildOutline(filepath, source, includeBody) {
    const lines = source.split('\n');
    const ext = path.extname(filepath).toLowerCase();
    const outline = [];

    if (ext === '.py') {
        const classRegex = /^(\s*)class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/;
        const funcStartRegex = /^(\s*)(async\s+)?def\s+(\w+)\s*\(/;
        for (let i = 0; i < lines.length; i++) {
            const classMatch = lines[i].match(classRegex);
            const funcStartMatch = lines[i].match(funcStartRegex);
            if (classMatch) {
                const entry = { type: 'class', name: classMatch[2], line_start: i + 1, bases: classMatch[3] || '' };
                if (includeBody) entry.body_preview = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
                outline.push(entry);
            }
            if (funcStartMatch) {
                const indent = funcStartMatch[1].length;
                const funcName = funcStartMatch[3];
                let sigLines = [lines[i]];
                let sigEnd = i;
                if (!lines[i].includes('):') && !lines[i].match(/\)\s*(->[^:]*)?:\s*$/)) {
                    for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
                        sigLines.push(lines[j]); sigEnd = j;
                        if (lines[j].includes('):') || lines[j].match(/\)\s*(->[^:]*)?:\s*$/)) break;
                    }
                }
                const fullSig = sigLines.map(l => l.trim()).join(' ').replace(/\s+/g, ' ').replace(/:\s*$/, '');
                const entry = { type: indent > 0 ? 'method' : 'function', name: funcName, line_start: i + 1, signature: fullSig };
                if (includeBody) entry.body_preview = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
                outline.push(entry);
            }
        }
    } else if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        try {
            const acorn = require('acorn');
            const walk = require('acorn-walk');
            const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowImportExportEverywhere: true, allowReturnOutsideFunction: true });
            walk.simple(ast, {
                FunctionDeclaration(node) {
                    const entry = { type: 'function', name: node.id ? node.id.name : '(anonymous)', line_start: node.loc.start.line, line_end: node.loc.end.line };
                    if (includeBody) entry.body_preview = lines.slice(node.loc.start.line - 1, node.loc.start.line + 4).join('\n');
                    outline.push(entry);
                },
                ClassDeclaration(node) { outline.push({ type: 'class', name: node.id ? node.id.name : '(anonymous)', line_start: node.loc.start.line, line_end: node.loc.end.line }); },
                VariableDeclaration(node) {
                    for (const decl of node.declarations) {
                        if (decl.init && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')) {
                            outline.push({ type: 'function', name: decl.id ? decl.id.name : '(anonymous)', line_start: node.loc.start.line, line_end: node.loc.end.line });
                        }
                    }
                }
            });
        } catch (e) { outline.push({ type: 'error', message: `Parse failed: ${e.message}` }); }
    } else {
        outline.push({ type: 'file_info', name: path.basename(filepath), total_lines: lines.length, extension: ext });
    }
    return outline;
}

// ── Simple Diff ────────────────────────────────────────────────

function simpleDiff(oldLines, newLines, oldLabel, newLabel) {
    const result = [`--- ${oldLabel}`, `+++ ${newLabel}`];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
        const oldLine = i < oldLines.length ? oldLines[i] : undefined;
        const newLine = i < newLines.length ? newLines[i] : undefined;
        if (oldLine === newLine) continue;
        if (oldLine !== undefined && newLine !== undefined) { result.push(`-${oldLine}`); result.push(`+${newLine}`); }
        else if (oldLine === undefined) result.push(`+${newLine}`);
        else result.push(`-${oldLine}`);
    }
    return result;
}

// ── Lexical scoring (hybrid search) ────────────────────────────
//
// Semantic search misses the most common query there is: you half-remember an
// identifier, a config key or an error string. Measured case — searching for
// count-lines.js, whose distinguishing identifier is `totalLines`, returned
// countFiles, countRows and getRecordCounts and never the file itself, while
// grep_code nailed it in the top two.
//
// The chunk text is already sitting in SQLite, so score it in-process. No
// shelling out to grep, no second index, no new tool.

const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were',
    'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with',
    'from', 'as', 'that', 'this', 'these', 'those', 'it', 'its', 'do', 'does',
    'how', 'what', 'where', 'when', 'which', 'who', 'why', 'can', 'will',
    'would', 'should', 'get', 'set', 'my', 'our', 'we', 'you',
]);

// "totalLines" → total, lines, totallines
// "MAX_INDEX_BYTES" → max, index, bytes
// Splitting identifiers is the whole point: without it, a query written as
// prose can never match a name written as code.
function splitCamel(word) {
    return word
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')      // totalLines → total Lines
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // HTTPServer → HTTP Server
        .split(/\s+/)
        .filter(Boolean);
}

function tokenize(text) {
    const out = [];
    for (const raw of String(text || '').split(/[^A-Za-z0-9_$]+/)) {
        if (!raw) continue;
        out.push(raw.toLowerCase());
        for (const part of raw.split(/[_$]+/).filter(Boolean)) {
            for (const piece of splitCamel(part)) {
                const lower = piece.toLowerCase();
                if (lower && lower !== raw.toLowerCase()) out.push(lower);
            }
        }
    }
    return out;
}

// Distinctive query terms only. Stopwords match everything and rank nothing.
// Single characters are noise. If stripping leaves nothing at all, keep the
// original tokens rather than returning an empty query.
function queryTokens(query) {
    const all = [...new Set(tokenize(query))];
    const kept = all.filter(t => t.length > 1 && !STOPWORDS.has(t));
    return kept.length ? kept : all;
}

function termFrequency(tokens) {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
}

// Log-damped term frequency so a long chunk that repeats a term twenty times
// can't bury a short one that names it. `name` is weighted heavily — a chunk
// CALLED totalLines is a better answer than one that mentions it in passing.
// Coverage multiplier rewards matching more of the query, so a chunk hitting
// three distinct terms beats one hitting the same term three times.
//
// IDF rarity weighting was tried here and reverted. It was written to fix a
// ranking defect that turned out not to exist: the test query was an
// identifier appearing in 50+ places, every top hit legitimately contained it,
// and the ordering was already correct. Rarity weighting may still be worth
// having — but it needs a query where the target is genuinely rare, and a
// measurement, before it goes back in.
const NAME_WEIGHT = 3;

function lexicalScore(qTokens, nameTf, textTf) {
    let score = 0, matched = 0;
    for (const t of qTokens) {
        const inName = nameTf.get(t) || 0;
        const inText = textTf.get(t) || 0;
        if (!inName && !inText) continue;
        matched++;
        score += NAME_WEIGHT * Math.log(1 + inName) + Math.log(1 + inText);
    }
    if (!matched) return 0;
    return score * (matched / qTokens.length);
}

// Reciprocal Rank Fusion. Works on ranks, not scores, which sidesteps cosine
// similarity and term frequency living on completely incomparable scales —
// no normalisation constant to tune and no weight to argue about. k=60 is the
// standard damping value from the original paper.
const RRF_K = 60;

function rrfContribution(rank) {
    return rank === null ? 0 : 1 / (RRF_K + rank);
}

// ── Tool handlers ──────────────────────────────────────────────

async function handleTool(name, args) {
    const db = getDb();

    switch (name) {
        case 'set_project': {
            const requested = args.project_paths && args.project_paths.length
                ? args.project_paths
                : (args.project_path ? [args.project_path] : []);
            if (requested.length === 0) {
                return { error: 'Give either project_path (one directory) or project_paths (several).' };
            }

            const accepted = [], rejected = [];
            for (const p of requested) {
                if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
                    rejected.push({ path: p, reason: 'not a directory' });
                    continue;
                }
                // The boundary check MUST happen here. These roots feed
                // discoverFiles(), which drives grep_code, search_code and
                // index_project — all free-tier tools.
                try { assertAllowed(p); } catch (e) { rejected.push({ path: p, reason: e.message }); continue; }
                accepted.push(path.resolve(p));
            }

            if (accepted.length === 0) {
                return { error: 'No usable project directories.', rejected };
            }

            const merged = args.add
                ? [...new Set([...projectRoots, ...accepted])]
                : [...new Set(accepted)];
            setRoots(merged);

            // Intelligence tools analyse one tree at a time — imports rarely
            // cross project boundaries — so they follow the primary root.
            if (intelligence && intelligence.configure) intelligence.configure(projectRoot);

            const { sql, params } = rootsClause();
            const chunkCount = db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE ${sql}`).get(...params).c;
            const fileCount = db.prepare(`SELECT COUNT(*) as c FROM file_hashes WHERE ${sql}`).get(...params).c;

            return {
                status: 'switched',
                project_roots: projectRoots,
                primary_root: projectRoot,
                root_count: projectRoots.length,
                cached_chunks: chunkCount,
                cached_files: fileCount,
                rejected: rejected.length ? rejected : undefined,
                message: chunkCount > 0
                    ? `Active across ${projectRoots.length} root(s) — ${chunkCount} chunks from ${fileCount} files in cache. Ready to search.`
                    : `Active across ${projectRoots.length} root(s) — no cached index. Run index_project to build it.`,
            };
        }

        case 'index_project': {
            if (projectRoots.length === 0) return { error: 'No project set. Run set_project first.' };
            const startTime = Date.now();

            // Discover across every configured root, remembering which root owns
            // each file so its chunks are stored against the right project_root.
            const discovered = [];
            for (const root of projectRoots) {
                for (const fp of discoverFiles(root)) discovered.push({ fp, root });
            }
            const files = discovered.map(d => d.fp);

            // Zero-files guard. Reporting a successful index of nothing is
            // exactly the silent-failure pattern this audit was about: the
            // caller gets "indexed" with no chunks and no reason, and only
            // finds out when every later search comes back empty. Say what
            // happened, and say what we do index so the cause is obvious.
            if (files.length === 0) {
                const exts = [...DEFAULTS.includeExtensions].sort();
                const sizeMB = (DEFAULTS.maxFileSize / 1048576).toFixed(0);
                return {
                    status: 'no_indexable_files',
                    project_roots: projectRoots,
                    total_files: 0,
                    new_chunks: 0,
                    indexed_extensions: exts,
                    skipped_directories: [...DEFAULTS.skipDirs].sort(),
                    max_file_size: `${sizeMB} MB`,
                    message: `Nothing was indexed — no indexable files found under ${projectRoots.join(' | ')}. ` +
                             `Indexable extensions are: ${exts.join(' ')}. ` +
                             `Files larger than ${sizeMB}MB are skipped, as are build and dependency directories ` +
                             `(${[...DEFAULTS.skipDirs].sort().join(', ')}) and anything matched by .gitignore. ` +
                             `Check the path given to set_project first; if your source uses an extension that is not ` +
                             `on the list above, that is the reason.`,
                    powered_by: 'KARP Inspector by SoulDriver — souldriver.com.au',
                };
            }

            // Pre-flight: size the job before embedding a single chunk, and
            // report it rather than silently grinding for minutes.
            let indexBytes = 0;
            for (const fp of files) {
                try { indexBytes += fs.statSync(fp).size; } catch {}
            }
            if (!args.confirm && (files.length > MAX_INDEX_FILES || indexBytes > MAX_INDEX_BYTES)) {
                return {
                    status: 'confirmation_required',
                    project_roots: projectRoots,
                    indexable_files: files.length,
                    indexable_size: `${(indexBytes / 1048576).toFixed(1)} MB`,
                    limits: { max_files: MAX_INDEX_FILES, max_size: `${MAX_INDEX_BYTES / 1048576} MB` },
                    message: `This root has ${files.length} indexable files (${(indexBytes / 1048576).toFixed(1)} MB) — above the pre-flight threshold. ` +
                             'That usually means the path points at something larger than a single project (a workspace root, or a folder holding several old revisions of a site). ' +
                             'Scope set_project to the actual project folder, or call index_project again with confirm: true to index this anyway.',
                };
            }

            if (args.force) {
                for (const root of projectRoots) {
                    db.prepare('DELETE FROM chunks WHERE project_root = ?').run(root);
                    db.prepare('DELETE FROM file_hashes WHERE project_root = ?').run(root);
                }
            }

            // ── Incremental, atomic indexing ─────────────────────────────
            //
            // This used to write every file_hashes row up front, then embed
            // everything, then insert all chunks in one transaction at the end.
            // If anything interrupted the middle step — and Claude Desktop
            // cancels a tool call at 4 minutes — the hashes were already
            // committed and the chunks were not. The index then claimed N files
            // were indexed while holding zero chunks, and every later run
            // skipped those files as unchanged. Poisoned, and self-perpetuating:
            // escaping needed a full embed to finish inside the same 4 minutes
            // that had just failed. Observed for real: 117 files tracked, 0
            // chunks, unrecoverable even with force.
            //
            // Now work in batches. Each batch embeds, then writes its chunks AND
            // its file hashes in ONE transaction — a hash can only exist if its
            // chunks do. When the per-call chunk budget is reached we stop and
            // report `partial`; call again to continue. An interrupted run
            // leaves a smaller correct index, never a lying one.

            const CHUNK_BATCH = 200;

            // Budget by TIME, not chunk count.
            //
            // A chunk count can't know what it costs: 1,200 chunks is ~40s on
            // the quantized model and over two minutes on full precision, on
            // slower hardware, or with large files. Wall-clock adapts to all of
            // it automatically. The constraint being defended is Claude
            // Desktop's 4-minute tool timeout, so stop at 3 and leave headroom
            // for the final flush and the response.
            //
            // This is what makes a genuinely large tree indexable at all: a
            // 200MB directory will never finish in one call, so the only thing
            // that matters is that each call commits durable progress and says
            // how much is left. Call until remaining_files reaches 0.
            const TIME_BUDGET_MS = (Number(args.max_seconds) > 0 ? Number(args.max_seconds) : 180) * 1000;
            const CHUNK_BUDGET = Number(args.max_chunks) > 0 ? Number(args.max_chunks) : Infinity;

            const byExtension = {};
            let skipped = 0, embedded = 0, filesIndexed = 0;
            let pending = [];       // chunks awaiting embedding
            let pendingFiles = [];  // { relPath, root, hash } awaiting their hash write
            let budgetHit = false;
            let stopReason = null;

            const insert = db.prepare(
                `INSERT INTO chunks (id, project_root, filepath, name, chunk_type, line_start, line_end, text, embedding, file_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const putHash = db.prepare(
                'INSERT OR REPLACE INTO file_hashes (filepath, project_root, sha256, last_indexed) VALUES (?, ?, ?, ?)'
            );
            const dropChunks = db.prepare('DELETE FROM chunks WHERE filepath = ? AND project_root = ?');

            async function flushBatch() {
                if (pending.length === 0) return;

                const texts = pending.map(c => `${c.name}\n${c.text}`);
                const vectors = await generateEmbeddings(texts);

                const batchChunks = pending;
                const batchFiles = pendingFiles;
                pending = [];
                pendingFiles = [];

                const tx = db.transaction(() => {
                    for (const f of batchFiles) dropChunks.run(f.relPath, f.root);

                    // Chunk ids need a per-file sequence number, not just the
                    // start line. line_start is NOT unique within a file:
                    // chunkJavaScript emits one chunk per declarator in a
                    // VariableDeclaration, all sharing node.loc.start.line, so
                    // `const a = () => {}, b = () => {}` produced two identical
                    // ids. relativeToOwner's basename fallback can also collapse
                    // src/utils.py and tests/utils.py to the same filepath.
                    // Either way the insert threw UNIQUE constraint failed and
                    // took the whole batch with it.
                    const seqByFile = new Map();
                    for (let i = 0; i < batchChunks.length; i++) {
                        const c = batchChunks[i];
                        const fileKey = `${c._root}\u0000${c.filepath}`;
                        const seq = seqByFile.get(fileKey) || 0;
                        seqByFile.set(fileKey, seq + 1);
                        insert.run(
                            `${c._root}::${c.filepath}:${c.line_start}#${seq}`, c._root, c.filepath,
                            c.name, c.chunk_type, c.line_start, c.line_end, c.text,
                            embeddingToBlob(vectors[i]), ''
                        );
                    }
                    // Same transaction as the chunks above — this is the fix.
                    for (const f of batchFiles) putHash.run(f.relPath, f.root, f.hash, Date.now() / 1000);
                });
                tx();

                embedded += batchChunks.length;
                filesIndexed += batchFiles.length;
                log('INFO', `Committed ${embedded} chunks from ${filesIndexed} file(s)`);
            }

            let cursor = 0;
            for (; cursor < discovered.length; cursor++) {
                if (budgetHit) break;
                const { fp: filepath, root } = discovered[cursor];

                let hash, relPath;
                try {
                    // computeHash used to sit outside the try, so one unreadable
                    // file aborted the whole run instead of skipping itself.
                    hash = computeHash(filepath);
                    relPath = path.relative(root, filepath);
                } catch (e) {
                    log('WARN', `Cannot hash ${filepath}: ${e.message}`);
                    skipped++;
                    continue;
                }

                const existing = db.prepare('SELECT sha256 FROM file_hashes WHERE filepath = ? AND project_root = ?').get(relPath, root);
                if (!args.force && existing && existing.sha256 === hash) { skipped++; continue; }

                let chunks;
                try {
                    const source = fs.readFileSync(filepath, 'utf-8');
                    chunks = chunkFile(filepath, source).map(c => ({ ...c, _root: root }));
                } catch (e) {
                    log('WARN', `Failed to process ${filepath}: ${e.message}`);
                    skipped++;
                    continue;
                }

                pending.push(...chunks);
                pendingFiles.push({ relPath, root, hash });
                const ext = path.extname(filepath).toLowerCase();
                byExtension[ext] = (byExtension[ext] || 0) + chunks.length;

                if (pending.length >= CHUNK_BATCH) {
                    await flushBatch();
                    const elapsed = Date.now() - startTime;
                    if (elapsed >= TIME_BUDGET_MS) { budgetHit = true; stopReason = 'time'; }
                    else if (embedded >= CHUNK_BUDGET) { budgetHit = true; stopReason = 'chunks'; }
                }
            }

            if (!budgetHit) await flushBatch();
            const remaining = discovered.length - cursor;

            // Prune per root — entries whose files no longer exist on disk.
            let pruned = 0;
            for (const root of projectRoots) {
                const live = new Set(
                    discovered.filter(d => d.root === root).map(d => path.relative(root, d.fp))
                );
                const tracked = db.prepare('SELECT filepath FROM file_hashes WHERE project_root = ?').all(root);
                for (const row of tracked) {
                    if (live.has(row.filepath)) continue;
                    db.prepare('DELETE FROM chunks WHERE filepath = ? AND project_root = ?').run(row.filepath, root);
                    db.prepare('DELETE FROM file_hashes WHERE filepath = ? AND project_root = ?').run(row.filepath, root);
                    pruned++;
                }
            }
            if (pruned > 0) log('INFO', `Pruned ${pruned} deleted file(s) from the index`);

            // Counted AFTER pruning, across every configured root.
            const rootsQ = rootsClause();
            const totalChunks = db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE ${rootsQ.sql}`).get(...rootsQ.params).c;

            // Source changed underneath the analysis tools — drop their cache.
            if (intelligence && intelligence.invalidateDependencyCache) {
                intelligence.invalidateDependencyCache(projectRoot);
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            log('INFO', `Indexed ${filesIndexed} file(s), ${embedded} new chunks in ${duration}s${budgetHit ? ` — ${remaining} file(s) remaining` : ''}`);

            return {
                status: budgetHit ? 'partial' : (embedded === 0 && totalChunks > 0 ? 'up_to_date' : 'indexed'),
                total_files: files.length,
                files_indexed: filesIndexed,
                new_chunks: embedded,
                total_chunks: totalChunks,
                skipped,
                pruned,
                remaining_files: remaining,
                stopped_because: budgetHit ? stopReason : undefined,
                indexable_size: `${(indexBytes / 1048576).toFixed(1)} MB`,
                by_extension: byExtension,
                duration_seconds: parseFloat(duration),
                message: budgetHit
                    ? `Committed ${embedded} chunks from ${filesIndexed} file(s) in ${duration}s — everything written so far is durable. ` +
                      `Stopped on the ${stopReason === 'time' ? `${TIME_BUDGET_MS / 1000}s time budget` : `${CHUNK_BUDGET}-chunk budget`} ` +
                      `with ${remaining} file(s) left. Call index_project again to continue — repeat until remaining_files is 0.`
                    : (embedded === 0 && totalChunks > 0 ? 'Index up to date. No files changed.' : undefined),
                powered_by: 'KARP Inspector by SoulDriver — souldriver.com.au',
            };
        }

        case 'search_code': {
            if (projectRoots.length === 0) return { error: 'No project set. Run set_project first.' };
            const sc = rootsClause();
            const chunkCount = db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE ${sc.sql}`).get(...sc.params).c;
            if (chunkCount === 0) return { error: 'Project not indexed. Run index_project first.' };

            const mode = args.mode || 'hybrid';
            if (!['hybrid', 'semantic', 'literal'].includes(mode)) {
                return { error: `Unknown mode "${args.mode}". Use hybrid (default), semantic, or literal.` };
            }

            let rows = db.prepare(`SELECT * FROM chunks WHERE ${sc.sql}`).all(...sc.params);

            // Apply filters
            if (args.file_filter) rows = rows.filter(r => r.filepath.includes(args.file_filter));
            if (args.ext_filter) rows = rows.filter(r => r.filepath.endsWith(args.ext_filter));
            if (rows.length === 0) return { query: args.query, mode, results: [], total: 0 };

            // ── Semantic ranking ─────────────────────────────────────────
            // Skipped entirely in literal mode — no reason to pay for an
            // embedding the caller has said they don't want.
            const semanticScore = new Map();
            if (mode !== 'literal') {
                const queryEmbedding = await generateEmbedding(args.query);
                const qVec = new Float32Array(queryEmbedding);
                for (const row of rows) {
                    semanticScore.set(row.id, cosineSimilarity(qVec, blobToEmbedding(row.embedding)));
                }
            }

            // ── Lexical ranking ──────────────────────────────────────────
            const lexScore = new Map();
            const qTokens = mode === 'semantic' ? [] : queryTokens(args.query);
            if (qTokens.length) {
                for (const row of rows) {
                    const s = lexicalScore(qTokens, termFrequency(tokenize(row.name)), termFrequency(tokenize(row.text)));
                    if (s > 0) lexScore.set(row.id, s);
                }
            }

            // Rank maps: id → 1-based rank within each list.
            const rankOf = (scores) => {
                const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
                const ranks = new Map();
                ordered.forEach(([id], i) => ranks.set(id, i + 1));
                return ranks;
            };
            const semanticRank = rankOf(semanticScore);
            const lexicalRank = rankOf(lexScore);

            let ordered;
            const rrfScore = new Map();
            if (mode === 'semantic') {
                ordered = rows.filter(r => semanticScore.has(r.id));
                ordered.sort((a, b) => semanticScore.get(b.id) - semanticScore.get(a.id));
            } else if (mode === 'literal') {
                ordered = rows.filter(r => lexScore.has(r.id));
                ordered.sort((a, b) => lexScore.get(b.id) - lexScore.get(a.id));
            } else {
                // Fuse. A chunk ranked 1st lexically contributes 1/61 while one
                // buried at semantic rank 900 contributes 1/960 — which is
                // exactly the correction hybrid exists to make.
                const fused = new Map();
                for (const row of rows) {
                    fused.set(row.id,
                        rrfContribution(semanticRank.get(row.id) ?? null) +
                        rrfContribution(lexicalRank.get(row.id) ?? null));
                }
                for (const [id, v] of fused) rrfScore.set(id, v);
                ordered = [...rows].sort((a, b) => fused.get(b.id) - fused.get(a.id));
            }

            const round = (n) => (typeof n === 'number' ? Math.round(n * 10000) / 10000 : undefined);

            const results = ordered.slice(0, args.limit || 8).map(row => ({
                file: row.filepath,
                root: row.project_root,
                name: row.name,
                chunk_type: row.chunk_type,
                line_start: row.line_start,
                line_end: row.line_end,
                // Marked truncation. An unmarked cut is indistinguishable from
                // the real end of a chunk, and feeding that back to patch_file
                // as old_str silently corrupts the file — patch_file matches on
                // substrings, so it happily replaces the truncated span and
                // orphans the tail. Hit this for real while editing README.md.
                text: row.text
                    ? (row.text.length > 500
                        ? row.text.substring(0, 500) + '\n\u2026 [TRUNCATED PREVIEW \u2014 not the full chunk. Use read_file or grep_code before editing this text.]'
                        : row.text)
                    : '',
                // Both components are reported, always, so a result can explain
                // why it is where it is instead of asking to be trusted.
                semantic_score: round(semanticScore.get(row.id)),
                lexical_score: round(lexScore.get(row.id)),
                semantic_rank: semanticRank.get(row.id),
                lexical_rank: lexicalRank.get(row.id),
                score: round(
                    mode === 'hybrid' ? rrfScore.get(row.id)
                    : mode === 'semantic' ? semanticScore.get(row.id)
                    : lexScore.get(row.id)
                ),
            }));

            return {
                query: args.query,
                mode,
                matched_terms: qTokens.length ? qTokens : undefined,
                lexical_matches: mode === 'semantic' ? undefined : lexScore.size,
                results,
                total: results.length,
                note: (mode === 'literal' && results.length === 0)
                    ? `No chunk contains any of: ${qTokens.join(', ')}. Try mode "hybrid", or grep_code for an exact string.`
                    : undefined,
            };
        }

        case 'grep_code': {
            if (projectRoots.length === 0) return { error: 'No project set. Run set_project first.' };
            if (typeof args.pattern !== 'string' || args.pattern.length > MAX_PATTERN_LENGTH) {
                return { error: `Pattern must be a string of at most ${MAX_PATTERN_LENGTH} characters.` };
            }
            let regex;
            try {
                const flags = (args.case_sensitive === false) ? 'i' : '';
                regex = args.is_regex ? new RegExp(args.pattern, flags) : new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
            } catch (e) { return { error: `Invalid regex: ${e.message}` }; }

            const matches = [];
            const files = projectRoots.flatMap(r => discoverFiles(r));
            const limit = args.limit || 50;
            const contextLines = args.context_lines ?? 2;

            for (const filepath of files) {
                const filename = path.basename(filepath);
                const ext = path.extname(filepath).toLowerCase();
                const relPath = relativeToOwner(filepath);
                if (args.file_filter && !filename.includes(args.file_filter)) continue;
                if (args.ext_filter && ext !== args.ext_filter) continue;

                let lines;
                try { lines = fs.readFileSync(filepath, 'utf-8').split('\n'); } catch { continue; }
                for (let i = 0; i < lines.length; i++) {
                    if (regex.test(lines[i])) {
                        const start = Math.max(0, i - contextLines);
                        const end = Math.min(lines.length, i + contextLines + 1);
                        matches.push({ file: relPath, root: rootOwning(filepath), line_number: i + 1, match: lines[i].trim(), context: lines.slice(start, end).join('\n') });
                        if (matches.length >= limit) return { pattern: args.pattern, matches, total: matches.length, truncated: true };
                    }
                }
            }
            return { pattern: args.pattern, matches, total: matches.length, truncated: false };
        }

        case 'file_outline': {
            if (projectRoots.length === 0) return { error: 'No project set. Run set_project first.' };
            const found = resolveInRoots(args.filepath, args.root);
            if (found.error) return { error: found.error };
            const fullPath = found.absPath;
            // Boundary check on the resolved result, not the root — a filepath
            // of ../../x would otherwise escape.
            try { assertAllowed(fullPath); } catch (e) { return { error: e.message }; }
            let source;
            try { source = fs.readFileSync(fullPath, 'utf-8'); } catch (e) { return { error: `Cannot read: ${e.message}` }; }
            const outline = buildOutline(args.filepath, source, args.include_body || false);
            return { file: args.filepath, total_lines: source.split('\n').length, outline };
        }

        case 'reindex_file': {
            if (projectRoots.length === 0) return { error: 'No project set. Run set_project first.' };
            const hit = resolveInRoots(args.filepath, args.root);
            if (hit.error) return { error: hit.error };
            const fullPath = hit.absPath;
            const owningRoot = hit.root;
            const relForIndex = hit.relPath;
            try { assertAllowed(fullPath); } catch (e) { return { error: e.message }; }

            // Save snapshot to SQLite
            const content = fs.readFileSync(fullPath, 'utf-8');
            db.prepare('INSERT INTO snapshots (filepath, project_root, full_content, created_at) VALUES (?, ?, ?, ?)').run(relForIndex, owningRoot, content, Date.now() / 1000);

            // Remove old chunks for this file
            db.prepare('DELETE FROM chunks WHERE filepath = ? AND project_root = ?').run(relForIndex, owningRoot);

            // Re-chunk and embed
            const chunks = chunkFile(fullPath, content);
            const texts = chunks.map(c => `${c.name}\n${c.text}`);
            const embeddings = await generateEmbeddings(texts);

            const insert = db.prepare(
                `INSERT INTO chunks (id, project_root, filepath, name, chunk_type, line_start, line_end, text, embedding, file_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const hash = computeHash(fullPath);
            const tx = db.transaction(() => {
                for (let i = 0; i < chunks.length; i++) {
                    insert.run(`${owningRoot}::${chunks[i].filepath}:${chunks[i].line_start}#${i}`, owningRoot, chunks[i].filepath, chunks[i].name, chunks[i].chunk_type, chunks[i].line_start, chunks[i].line_end, chunks[i].text, embeddingToBlob(embeddings[i]), hash);
                }
            });
            tx();

            db.prepare('INSERT OR REPLACE INTO file_hashes (filepath, project_root, sha256, last_indexed) VALUES (?, ?, ?, ?)').run(relForIndex, owningRoot, hash, Date.now() / 1000);

            const rq = rootsClause();
            return { file: relForIndex, root: owningRoot, chunks: chunks.length, total_chunks: db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE ${rq.sql}`).get(...rq.params).c };
        }

        case 'file_history': {
            if (projectRoots.length === 0) return { error: 'No project set. Run set_project first.' };
            const hq = rootsClause();
            const snapshots = db.prepare(
                `SELECT id, filepath, project_root, created_at, length(full_content) as size_bytes
                 FROM snapshots WHERE filepath = ? AND ${hq.sql} ORDER BY created_at DESC`
            ).all(args.filepath, ...hq.params);
            return {
                file: args.filepath,
                snapshots: snapshots.map(s => ({
                    id: s.id,
                    root: s.project_root,
                    timestamp: new Date(s.created_at * 1000).toISOString(),
                    size_bytes: s.size_bytes,
                })),
                total: snapshots.length,
            };
        }

        case 'file_diff': {
            if (projectRoots.length === 0) return { error: 'No project set. Run set_project first.' };
            const dq = args.root
                ? { sql: 'project_root = ?', params: [path.resolve(args.root)] }
                : rootsClause();
            const snapshots = db.prepare(
                `SELECT id, full_content, created_at, project_root
                 FROM snapshots WHERE filepath = ? AND ${dq.sql} ORDER BY created_at DESC`
            ).all(args.filepath, ...dq.params);
            if (snapshots.length === 0) return { error: `No snapshots for ${args.filepath}` };

            // Snapshots from two roots with the same relative path would
            // interleave by timestamp and diff unrelated files against each
            // other. Refuse rather than produce a nonsense diff.
            const snapRoots = [...new Set(snapshots.map(s => s.project_root))];
            if (snapRoots.length > 1) {
                return { error: `"${args.filepath}" has snapshots under ${snapRoots.length} roots — pass "root" to pick one. Candidates: ${snapRoots.join(' | ')}` };
            }

            const oldIndex = args.old_index ?? 1;
            const newIndex = args.new_index ?? 0;

            if (oldIndex >= snapshots.length) return { error: `Snapshot ${oldIndex} out of range (${snapshots.length} available)` };
            const oldContent = snapshots[oldIndex].full_content.split('\n');
            const oldLabel = new Date(snapshots[oldIndex].created_at * 1000).toISOString();

            let newContent, newLabel;
            if (newIndex === -1) {
                const live = resolveInRoots(args.filepath, args.root);
                if (live.error) return { error: live.error };
                try { assertAllowed(live.absPath); } catch (e) { return { error: e.message }; }
                newContent = fs.readFileSync(live.absPath, 'utf-8').split('\n');
                newLabel = `${args.filepath} (live)`;
            } else {
                if (newIndex >= snapshots.length) return { error: `Snapshot ${newIndex} out of range` };
                newContent = snapshots[newIndex].full_content.split('\n');
                newLabel = new Date(snapshots[newIndex].created_at * 1000).toISOString();
            }

            const diffLines = simpleDiff(oldContent, newContent, oldLabel, newLabel);
            return {
                file: args.filepath,
                additions: diffLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
                deletions: diffLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
                diff_text: diffLines.join('\n') || '(no changes)',
            };
        }

        case 'project_stats': {
            if (projectRoots.length === 0) {
                return { project_roots: [], total_chunks: 0, files_tracked: 0, message: 'No project set. Run set_project first.' };
            }
            const pq = rootsClause();
            const byType = {}, byExt = {}, byRoot = {};
            const chunks = db.prepare(`SELECT chunk_type, filepath, project_root FROM chunks WHERE ${pq.sql}`).all(...pq.params);
            for (const c of chunks) {
                byType[c.chunk_type] = (byType[c.chunk_type] || 0) + 1;
                const ext = path.extname(c.filepath).toLowerCase() || 'unknown';
                byExt[ext] = (byExt[ext] || 0) + 1;
                byRoot[c.project_root] = (byRoot[c.project_root] || 0) + 1;
            }
            const fileCount = db.prepare(`SELECT COUNT(*) as c FROM file_hashes WHERE ${pq.sql}`).get(...pq.params).c;
            return {
                project_roots: projectRoots,
                primary_root: projectRoot,
                root_count: projectRoots.length,
                total_chunks: chunks.length,
                files_tracked: fileCount,
                chunks_by_root: byRoot,
                by_chunk_type: byType,
                by_extension: byExt,
                powered_by: 'KARP Inspector by SoulDriver — souldriver.com.au',
            };
        }

        case 'list_projects': {
            const chunkRows = db.prepare('SELECT project_root, COUNT(*) as chunks FROM chunks GROUP BY project_root').all();
            const fileRows = db.prepare('SELECT project_root, COUNT(*) as files, MAX(last_indexed) as last_indexed FROM file_hashes GROUP BY project_root').all();

            const byRoot = new Map();
            for (const r of chunkRows) {
                byRoot.set(r.project_root, { project_root: r.project_root, chunks: r.chunks, files: 0, last_indexed: null });
            }
            for (const f of fileRows) {
                const entry = byRoot.get(f.project_root) || { project_root: f.project_root, chunks: 0, files: 0, last_indexed: null };
                entry.files = f.files;
                entry.last_indexed = f.last_indexed ? new Date(f.last_indexed * 1000).toISOString() : null;
                byRoot.set(f.project_root, entry);
            }

            const projects = [...byRoot.values()]
                .map(p => ({ ...p, exists_on_disk: fs.existsSync(p.project_root), active: projectRoots.includes(p.project_root) }))
                .sort((a, b) => b.chunks - a.chunks);

            return {
                total_projects: projects.length,
                total_chunks: projects.reduce((sum, p) => sum + p.chunks, 0),
                active_roots: projectRoots.length ? projectRoots : '(none set)',
                projects,
            };
        }

        case 'index_status': {
            if (projectRoots.length === 0) return { error: 'No project set. Run set_project first.' };

            const byRoot = [];
            let tAdded = 0, tChanged = 0, tDeleted = 0, tIndexed = 0, tOnDisk = 0;

            for (const root of projectRoots) {
                const files = discoverFiles(root);
                const tracked = new Map(
                    db.prepare('SELECT filepath, sha256 FROM file_hashes WHERE project_root = ?').all(root)
                      .map(r => [r.filepath, r.sha256])
                );

                const added = [], changed = [], seen = new Set();
                for (const fp of files) {
                    const rel = path.relative(root, fp);
                    seen.add(rel);
                    const known = tracked.get(rel);
                    if (!known) { added.push(rel); continue; }
                    try { if (computeHash(fp) !== known) changed.push(rel); } catch {}
                }
                const deleted = [...tracked.keys()].filter(rel => !seen.has(rel));

                tAdded += added.length; tChanged += changed.length; tDeleted += deleted.length;
                tIndexed += tracked.size; tOnDisk += files.length;

                byRoot.push({
                    project_root: root,
                    indexed_files: tracked.size,
                    files_on_disk: files.length,
                    counts: { added: added.length, changed: changed.length, deleted: deleted.length },
                    added: added.slice(0, 25),
                    changed: changed.slice(0, 25),
                    deleted: deleted.slice(0, 25),
                });
            }

            const stale = tAdded + tChanged + tDeleted;
            return {
                project_roots: projectRoots,
                indexed_files: tIndexed,
                files_on_disk: tOnDisk,
                counts: { added: tAdded, changed: tChanged, deleted: tDeleted },
                by_root: byRoot,
                up_to_date: stale === 0,
                message: stale === 0
                    ? 'Index is current — no need to run index_project.'
                    : `${stale} file(s) out of date across ${projectRoots.length} root(s). Run index_project to bring the index in line.`,
            };
        }

        case 'forget_project': {
            const root = args.project_root;
            const chunks = db.prepare('SELECT COUNT(*) as c FROM chunks WHERE project_root = ?').get(root).c;
            const hashes = db.prepare('SELECT COUNT(*) as c FROM file_hashes WHERE project_root = ?').get(root).c;
            const snaps = db.prepare('SELECT COUNT(*) as c FROM snapshots WHERE project_root = ?').get(root).c;

            if (chunks === 0 && hashes === 0 && snaps === 0) {
                return { error: `No index found for "${root}". Run list_projects to see the exact stored paths — they must match character for character.` };
            }

            if (!args.confirm) {
                return {
                    dry_run: true,
                    project_root: root,
                    would_delete: { chunks, file_hashes: hashes, snapshots: args.include_snapshots ? snaps : 0 },
                    snapshots_retained: args.include_snapshots ? 0 : snaps,
                    message: 'Nothing deleted. Set confirm: true to apply — this cannot be undone by karp_undo.',
                };
            }

            db.prepare('DELETE FROM chunks WHERE project_root = ?').run(root);
            db.prepare('DELETE FROM file_hashes WHERE project_root = ?').run(root);
            let deletedSnaps = 0;
            if (args.include_snapshots) {
                db.prepare('DELETE FROM snapshots WHERE project_root = ?').run(root);
                deletedSnaps = snaps;
            }

            // If we just deleted an active root's index, drop it from the active
            // set so later calls fail loudly rather than searching a ghost index.
            if (projectRoots.includes(root)) {
                setRoots(projectRoots.filter(r => r !== root));
                if (intelligence && intelligence.configure) intelligence.configure(projectRoot);
            }

            log('INFO', `forget_project: removed ${chunks} chunks / ${hashes} file hashes for ${root}`);
            return {
                deleted: { chunks, file_hashes: hashes, snapshots: deletedSnaps },
                project_root: root,
                snapshots_retained: args.include_snapshots ? 0 : snaps,
                note: 'The database file reclaims the space on its next write.',
            };
        }

        case 'export_index': {
            const root = args.project_root || projectRoot;
            if (!root) return { error: 'No project set and no project_root given.' };
            try { assertAllowed(args.output_path); } catch (e) { return { error: e.message }; }

            const chunks = db.prepare('SELECT * FROM chunks WHERE project_root = ?').all(root);
            if (chunks.length === 0) {
                return { error: `No index found for "${root}". Run list_projects to see stored roots.` };
            }
            const hashes = db.prepare('SELECT * FROM file_hashes WHERE project_root = ?').all(root);

            const payload = {
                format: 'karp-inspector-index',
                format_version: 2,
                exported_at: new Date().toISOString(),
                project_root: root,
                // Embeddings are only comparable against vectors from the same
                // model AND the same precision, so record both — import refuses
                // on a mismatch. Recording the model alone was the bug: a
                // full-precision export imported silently into a quantized
                // server and produced plausible nonsense, which is worse than
                // a refusal because nothing announces it.
                embedding_model: MODEL_ID,
                embedding_dtype: MODEL_DTYPE,
                chunks: chunks.map(c => ({
                    ...c,
                    embedding: c.embedding ? Buffer.from(c.embedding).toString('base64') : null,
                })),
                file_hashes: hashes,
            };

            const outPath = path.resolve(args.output_path);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            const tmp = outPath + `.tmp.${Date.now()}`;
            fs.writeFileSync(tmp, JSON.stringify(payload));
            fs.renameSync(tmp, outPath);

            return {
                exported: outPath,
                project_root: root,
                chunks: chunks.length,
                files: hashes.length,
                size: `${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB`,
                embedding_model: payload.embedding_model,
                embedding_dtype: payload.embedding_dtype,
            };
        }

        case 'import_index': {
            try { assertAllowed(args.input_path); } catch (e) { return { error: e.message }; }

            let payload;
            try {
                payload = JSON.parse(fs.readFileSync(path.resolve(args.input_path), 'utf-8'));
            } catch (e) {
                return { error: `Cannot read index file: ${e.message}` };
            }
            if (payload.format !== 'karp-inspector-index') {
                return { error: 'Not a KARP index export — wrong or missing format marker.' };
            }
            if (payload.embedding_model && payload.embedding_model !== MODEL_ID) {
                return { error: `Index was built with "${payload.embedding_model}", this server uses ${MODEL_ID}. Vectors from different models are not comparable — re-index instead.` };
            }
            // Precision mismatch is the silent case. q8 and fp32 vectors have
            // the same dimensions and import without complaint, so nothing
            // fails — the rankings are just quietly wrong. Refuse.
            //
            // A missing embedding_dtype means format_version 1, written before
            // precision was recorded. That index predates the q8 switch, so it
            // cannot be assumed to match: refuse it too, and say why.
            if (!payload.embedding_dtype) {
                return {
                    error: `This index does not record the embedding precision it was built with — it predates that field. ` +
                           `Vectors built at a different precision are not comparable to this server's ${MODEL_DTYPE} vectors, ` +
                           `and the mismatch produces plausible-looking but wrong results rather than an error. Re-export it from an ` +
                           `up-to-date server, or re-index the source directly.`,
                };
            }
            if (payload.embedding_dtype !== MODEL_DTYPE) {
                return { error: `Index was built at "${payload.embedding_dtype}" precision, this server uses "${MODEL_DTYPE}". Vectors at different precisions are not comparable — re-index instead.` };
            }

            const targetRoot = args.remap_root || payload.project_root;
            const existing = db.prepare('SELECT COUNT(*) as c FROM chunks WHERE project_root = ?').get(targetRoot).c;
            if (existing > 0 && !args.overwrite) {
                return { error: `"${targetRoot}" already has ${existing} chunks indexed. Pass overwrite: true to replace it.` };
            }
            if (existing > 0) {
                db.prepare('DELETE FROM chunks WHERE project_root = ?').run(targetRoot);
                db.prepare('DELETE FROM file_hashes WHERE project_root = ?').run(targetRoot);
            }

            const insertChunk = db.prepare(
                `INSERT INTO chunks (id, project_root, filepath, name, chunk_type, line_start, line_end, text, embedding, file_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            const insertHash = db.prepare(
                'INSERT OR REPLACE INTO file_hashes (filepath, project_root, sha256, last_indexed) VALUES (?, ?, ?, ?)'
            );

            const tx = db.transaction(() => {
                // Chunk ids need a per-file sequence number, exactly as
                // flushBatch builds them. line_start is NOT unique within a
                // file — chunkJavaScript emits one chunk per declarator in a
                // VariableDeclaration, all sharing node.loc.start.line — so an
                // id of root::filepath:line_start collides on the very first
                // `const a = () => {}, b = () => {}` it meets. index_project
                // was fixed for this; import_index was written afterwards
                // against the older id format and never was, which meant it
                // failed on any real codebase. Keep the two in step.
                const seqByFile = new Map();
                for (const c of payload.chunks || []) {
                    // Regenerate the id against the target root rather than
                    // reusing the exported one — otherwise importing under a
                    // remapped root collides with the original's primary keys.
                    const fileKey = `${targetRoot}\u0000${c.filepath}`;
                    const seq = seqByFile.get(fileKey) || 0;
                    seqByFile.set(fileKey, seq + 1);
                    insertChunk.run(
                        `${targetRoot}::${c.filepath}:${c.line_start}#${seq}`, targetRoot, c.filepath, c.name, c.chunk_type,
                        c.line_start, c.line_end, c.text,
                        c.embedding ? Buffer.from(c.embedding, 'base64') : null,
                        c.file_hash || ''
                    );
                }
                for (const h of payload.file_hashes || []) {
                    insertHash.run(h.filepath, targetRoot, h.sha256, h.last_indexed);
                }
            });
            tx();

            if (intelligence && intelligence.invalidateDependencyCache) {
                intelligence.invalidateDependencyCache(targetRoot);
            }

            return {
                imported_from: args.input_path,
                project_root: targetRoot,
                remapped: Boolean(args.remap_root),
                original_root: payload.project_root,
                chunks: (payload.chunks || []).length,
                files: (payload.file_hashes || []).length,
                exported_at: payload.exported_at,
                note: targetRoot !== payload.project_root
                    ? 'Paths were remapped. Run index_status to confirm the index matches what is on disk here.'
                    : 'Run index_status to confirm the index matches what is on disk.',
            };
        }

        default:
            throw new Error(`Unknown inspector tool: ${name}`);
    }
}

module.exports = { TOOLS, handleTool };
