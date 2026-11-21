// ============================================================================
// KARP Inspector — Intelligence Module
// Author: SoulDriver (Adelaide, Australia)
// Advanced code analysis: dependency graph, impact analysis, todo scan,
// security audit, repo map. Leverages Inspector's index + Graph's memory.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { log, assertAllowed } = require('./utils');
const { getDb } = require('./database');

// ── Configuration ──────────────────────────────────────────────

let projectRoot = '';

function configure(root) {
    projectRoot = root;
}

function getProjectRoot() {
    return projectRoot;
}

// ── Tool definitions ───────────────────────────────────────────

const TOOLS = [
    {
        name: 'repo_map',
        description: 'Generate a compressed structural map of a directory — exported function signatures, class names, type definitions — without implementation details. Gives Claude structural awareness of thousands of lines for minimal token cost. Reads from disk — does NOT require index_project.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to directory to map (or relative from project root)' },
                max_depth: { type: 'number', description: 'Max directory depth (default: 3)' },
                ext_filter: { type: 'string', description: 'Only files with this extension (e.g. ".js")' },
            },
            required: ['path'],
        },
    },
    {
        name: 'dependency_graph',
        description: 'Map imports and require() calls across the project. Shows which files depend on which, and finds circular dependencies. Reads from disk — does NOT require index_project.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'Specific file to analyse (relative path), or omit for whole project' },
                direction: { type: 'string', enum: ['imports', 'imported_by', 'both'], description: 'Show what this file imports, what imports it, or both (default: both)' },
            },
        },
    },
    {
        name: 'impact_analysis',
        description: 'If I modify this file or function, what else in the project could break? Shows all files that import from or depend on the target. Reads from disk — does NOT require index_project.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'File to analyse (relative path from project root)' },
                symbol: { type: 'string', description: 'Specific exported symbol to check (optional — if omitted, checks the whole file)' },
            },
            required: ['filepath'],
        },
    },
    {
        name: 'todo_scan',
        description: 'Extract all TODO, FIXME, HACK, XXX, and NOTE comments from the codebase with file paths and line numbers. Reads from disk — does NOT require index_project.',
        inputSchema: {
            type: 'object',
            properties: {
                tags: { type: 'array', items: { type: 'string' }, description: 'Comment tags to scan for (default: TODO, FIXME, HACK, XXX, NOTE)' },
                ext_filter: { type: 'string', description: 'Only scan files with this extension' },
                limit: { type: 'number', description: 'Max results (default: 100)' },
            },
        },
    },
    {
        name: 'security_audit',
        description: 'Scan project files for potential secrets: API keys, private keys, tokens, high-entropy strings, hardcoded credentials, and .env leaks. Reports file and line with the value redacted — it never echoes the secret itself. Reads from disk — does NOT require index_project.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory to scan (default: project root)' },
                ext_filter: { type: 'string', description: 'Only scan files with this extension' },
            },
        },
    },
    {
        name: 'dead_code',
        description: 'Find exported functions, classes, and variables that are never imported by any other file in the project. Reads from disk — does NOT require index_project.',
        inputSchema: {
            type: 'object',
            properties: {
                ext_filter: { type: 'string', description: 'Only check files with this extension (default: .js)' },
            },
        },
    },
];

// ── Dependency Parsing ─────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'venv', '.venv', 'dist', 'build', '.karp-premium', 'data']);
const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.py', '.mjs']);

function discoverCodeFiles(rootDir, extFilter) {
    const files = [];
    function walk(dir) {
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
                const fp = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(fp); continue; }
                const ext = path.extname(entry.name).toLowerCase();
                if (extFilter && ext !== extFilter) continue;
                if (!extFilter && !CODE_EXTS.has(ext)) continue;
                files.push(fp);
            }
        } catch {}
    }
    walk(rootDir);
    return files;
}

function parseImports(filepath, source) {
    const ext = path.extname(filepath).toLowerCase();
    const imports = [];

    if (['.js', '.jsx', '.ts', '.tsx', '.mjs'].includes(ext)) {
        // ES imports: import X from './path'
        const esRegex = /(?:import\s+(?:[\w{},\s*]+\s+from\s+)?|export\s+(?:[\w{},\s*]+\s+from\s+)?)['"]([^'"]+)['"]/g;
        let match;
        while ((match = esRegex.exec(source)) !== null) {
            imports.push(match[1]);
        }
        // CommonJS: require('./path')
        const cjsRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((match = cjsRegex.exec(source)) !== null) {
            imports.push(match[1]);
        }
    } else if (ext === '.py') {
        // Python: import X, from X import Y
        const pyRegex = /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
        let match;
        while ((match = pyRegex.exec(source)) !== null) {
            imports.push(match[1] || match[2]);
        }
    }

    return imports;
}

function parseExports(filepath, source) {
    const ext = path.extname(filepath).toLowerCase();
    const exports = [];

    if (['.js', '.jsx', '.ts', '.tsx', '.mjs'].includes(ext)) {
        // module.exports = { a, b, c }
        const moduleExportsMatch = source.match(/module\.exports\s*=\s*\{([^}]+)\}/);
        if (moduleExportsMatch) {
            const names = moduleExportsMatch[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
            exports.push(...names);
        }
        // export function/class/const
        const namedExportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
        let match;
        while ((match = namedExportRegex.exec(source)) !== null) {
            exports.push(match[1]);
        }
    } else if (ext === '.py') {
        // Python: functions and classes at module level (indent 0)
        const pyRegex = /^(?:def|class)\s+(\w+)/gm;
        let match;
        while ((match = pyRegex.exec(source)) !== null) {
            if (!match[0].startsWith(' ') && !match[0].startsWith('\t')) {
                exports.push(match[1]);
            }
        }
    }

    return exports;
}

function resolveImportPath(importStr, fromFile, root) {
    // Skip node_modules / built-in imports
    if (!importStr.startsWith('.') && !importStr.startsWith('/')) return null;

    const dir = path.dirname(fromFile);
    let resolved = path.resolve(root, dir, importStr);

    // Try with extensions
    const tryExts = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '/index.js', '/index.ts'];
    if (fs.existsSync(resolved)) return path.relative(root, resolved);
    for (const ext of tryExts) {
        if (fs.existsSync(resolved + ext)) return path.relative(root, resolved + ext);
    }
    return path.relative(root, resolved); // Return best guess
}

// Cached dependency maps. dependency_graph, impact_analysis and dead_code all
// need this, and each used to re-walk the tree and re-read every source file
// from scratch on every call — so asking two questions in a row paid the full
// cost twice.
//
// Honest limitation: the index stores *chunks*, not whole-file source, so
// these tools can't be served from it directly without an imports table. This
// memoisation is the cheap 80% — a short TTL plus an explicit invalidation
// hook that inspector.js calls after indexing. Long enough to cover a burst of
// related questions, short enough that edits show up without a restart.
const _depCache = new Map();
const DEP_CACHE_TTL_MS = 60 * 1000;

function invalidateDependencyCache(root) {
    if (!root) { _depCache.clear(); return; }
    for (const key of [..._depCache.keys()]) {
        if (key.startsWith(`${root}::`)) _depCache.delete(key);
    }
}

function getDependencyMap(root, extFilter) {
    const key = `${root}::${extFilter || '*'}`;
    const hit = _depCache.get(key);
    if (hit && Date.now() - hit.at < DEP_CACHE_TTL_MS) return hit.value;
    const value = buildDependencyMap(root, extFilter);
    _depCache.set(key, { at: Date.now(), value });
    return value;
}

function buildDependencyMap(root, extFilter) {
    const files = discoverCodeFiles(root, extFilter);
    const deps = {}; // file -> [imports]
    const reverseDeps = {}; // file -> [imported_by]

    for (const filepath of files) {
        const relPath = path.relative(root, filepath);
        try {
            const source = fs.readFileSync(filepath, 'utf-8');
            const imports = parseImports(filepath, source);
            deps[relPath] = [];

            for (const imp of imports) {
                const resolved = resolveImportPath(imp, relPath, root);
                if (resolved) {
                    deps[relPath].push(resolved);
                    if (!reverseDeps[resolved]) reverseDeps[resolved] = [];
                    reverseDeps[resolved].push(relPath);
                }
            }
        } catch {}
    }

    return { deps, reverseDeps };
}

// ── Outline for repo_map ───────────────────────────────────────

function quickOutline(filepath, source) {
    const ext = path.extname(filepath).toLowerCase();
    const sigs = [];

    if (['.js', '.jsx', '.ts', '.tsx', '.mjs'].includes(ext)) {
        try {
            const acorn = require('acorn');
            const walk = require('acorn-walk');
            const lines = source.split('\n');
            const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowImportExportEverywhere: true, allowReturnOutsideFunction: true });
            walk.simple(ast, {
                FunctionDeclaration(node) { sigs.push(`  fn ${node.id ? node.id.name : '(anon)'}() :${node.loc.start.line}`); },
                ClassDeclaration(node) { sigs.push(`  class ${node.id ? node.id.name : '(anon)'} :${node.loc.start.line}`); },
                VariableDeclaration(node) {
                    for (const d of node.declarations) {
                        if (d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')) {
                            sigs.push(`  fn ${d.id ? d.id.name : '(anon)'}() :${node.loc.start.line}`);
                        }
                    }
                }
            });
        } catch { /* fallback: no outline for unparseable files */ }
    } else if (ext === '.py') {
        const classRegex = /^class\s+(\w+)/gm;
        const funcRegex = /^def\s+(\w+)/gm;
        let m;
        while ((m = classRegex.exec(source)) !== null) sigs.push(`  class ${m[1]}`);
        while ((m = funcRegex.exec(source)) !== null) sigs.push(`  fn ${m[1]}()`);
    }

    return sigs;
}

// ── Security Patterns ──────────────────────────────────────────

const SECRET_PATTERNS = [
    { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'AWS Secret Key', regex: /(?:aws)?_?(?:secret)?_?(?:access)?_?key.*?[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi },
    { name: 'Private Key', regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
    { name: 'Generic API Key', regex: /(?:api[_-]?key|apikey|api_secret|secret_key)\s*[=:]\s*['"]([^'"]{8,})['"]?/gi },
    { name: 'Generic Token', regex: /(?:token|auth_token|access_token|bearer)\s*[=:]\s*['"]([^'"]{8,})['"]?/gi },
    { name: 'Generic Password', regex: /(?:password|passwd|pwd)\s*[=:]\s*['"]([^'"]{4,})['"]?/gi },
    { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
    { name: 'Slack Token', regex: /xox[baprs]-[A-Za-z0-9-]+/g },
    { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { name: 'Connection String', regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]+/gi },
];

/**
 * Mask a source line before it goes into a finding.
 *
 * security_audit used to return the matched line verbatim as `preview`, which
 * meant every discovered AWS key, password and token was copied straight into
 * the model's context and the conversation transcript. The point of the tool is
 * to tell you WHERE a secret is, not to reproduce it. Keep enough shape to
 * locate the line, redact the value itself.
 */
function maskLine(line) {
    const trimmed = String(line).trim();
    // Redact anything that looks like an assigned value: key = "....."
    let masked = trimmed.replace(
        /([=:]\s*['"]?)([^'"\s,;)}]{4,})(['"]?)/g,
        (_m, lead, value, tail) => `${lead}${'*'.repeat(Math.min(value.length, 12))}${tail}`
    );
    // Redact bare high-entropy-looking runs that had no assignment operator
    masked = masked.replace(/\b[A-Za-z0-9+/=_-]{20,}\b/g, m => `${m.slice(0, 4)}${'*'.repeat(8)}`);
    return masked.length > 80 ? masked.slice(0, 80) + '…' : masked;
}

function shannonEntropy(str) {
    const freq = {};
    for (const c of str) freq[c] = (freq[c] || 0) + 1;
    const len = str.length;
    let entropy = 0;
    for (const c in freq) {
        const p = freq[c] / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

// ── Tool handlers ──────────────────────────────────────────────

async function handleTool(name, args) {
    // Use inspector's project root if intelligence doesn't have one set
    const root = projectRoot || args.path || '';

    switch (name) {
        case 'repo_map': {
            const targetPath = path.isAbsolute(args.path) ? args.path : path.join(root, args.path);
            // repo_map takes its own absolute path and is in the free tier —
            // without this it mapped any directory on the machine.
            try { assertAllowed(targetPath); } catch (e) { return { error: e.message }; }
            if (!fs.existsSync(targetPath)) return { error: `Path not found: ${targetPath}` };

            const maxDepth = args.max_depth || 3;
            const lines = [];
            let totalFiles = 0;
            let totalSymbols = 0;

            function mapDir(dir, depth, prefix) {
                if (depth > maxDepth) return;
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true })
                        .filter(e => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
                        .sort((a, b) => { if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1; return a.name.localeCompare(b.name); });

                    for (const entry of entries) {
                        const fp = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            lines.push(`${prefix}${entry.name}/`);
                            mapDir(fp, depth + 1, prefix + '  ');
                            continue;
                        }
                        const ext = path.extname(entry.name).toLowerCase();
                        if (args.ext_filter && ext !== args.ext_filter) continue;
                        if (!CODE_EXTS.has(ext) && !args.ext_filter) continue;

                        try {
                            const source = fs.readFileSync(fp, 'utf-8');
                            const sigs = quickOutline(fp, source);
                            const lineCount = source.split('\n').length;
                            lines.push(`${prefix}${entry.name} (${lineCount}L)`);
                            for (const sig of sigs) { lines.push(`${prefix}${sig}`); totalSymbols++; }
                            totalFiles++;
                        } catch {}
                    }
                } catch {}
            }

            mapDir(targetPath, 0, '');
            return {
                path: targetPath,
                total_files: totalFiles,
                total_symbols: totalSymbols,
                map: lines.join('\n'),
            };
        }

        case 'dependency_graph': {
            if (!root) return { error: 'No project set.' };
            const { deps, reverseDeps } = getDependencyMap(root, args.ext_filter);

            if (args.filepath) {
                const direction = args.direction || 'both';
                const result = { file: args.filepath };
                if (direction === 'imports' || direction === 'both') {
                    result.imports = deps[args.filepath] || [];
                }
                if (direction === 'imported_by' || direction === 'both') {
                    result.imported_by = reverseDeps[args.filepath] || [];
                }
                return result;
            }

            // Full project graph — find circular deps
            const circulars = [];
            function findCycles(file, visited, stack) {
                visited.add(file);
                stack.add(file);
                for (const dep of (deps[file] || [])) {
                    if (stack.has(dep)) {
                        circulars.push({ from: file, to: dep });
                    } else if (!visited.has(dep) && deps[dep]) {
                        findCycles(dep, visited, stack);
                    }
                }
                stack.delete(file);
            }
            const visited = new Set();
            for (const file of Object.keys(deps)) {
                if (!visited.has(file)) findCycles(file, visited, new Set());
            }

            return {
                total_files: Object.keys(deps).length,
                dependencies: deps,
                circular_dependencies: circulars,
                most_imported: Object.entries(reverseDeps)
                    .map(([f, importers]) => ({ file: f, imported_by_count: importers.length }))
                    .sort((a, b) => b.imported_by_count - a.imported_by_count)
                    .slice(0, 10),
            };
        }

        case 'impact_analysis': {
            if (!root) return { error: 'No project set.' };
            const { deps, reverseDeps } = getDependencyMap(root);

            const directImporters = reverseDeps[args.filepath] || [];

            // Second-level impact
            const secondLevel = [];
            for (const importer of directImporters) {
                const itsImporters = reverseDeps[importer] || [];
                for (const imp of itsImporters) {
                    if (imp !== args.filepath && !directImporters.includes(imp)) {
                        secondLevel.push({ file: imp, via: importer });
                    }
                }
            }

            // Check if symbol is used specifically
            let symbolUsage = [];
            if (args.symbol) {
                const files = discoverCodeFiles(root);
                for (const fp of files) {
                    const relPath = path.relative(root, fp);
                    if (relPath === args.filepath) continue;
                    try {
                        const source = fs.readFileSync(fp, 'utf-8');
                        if (source.includes(args.symbol)) {
                            const lines = source.split('\n');
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].includes(args.symbol)) {
                                    symbolUsage.push({ file: relPath, line: i + 1, text: lines[i].trim() });
                                }
                            }
                        }
                    } catch {}
                }
            }

            return {
                file: args.filepath,
                symbol: args.symbol || '(entire file)',
                direct_dependents: directImporters,
                indirect_dependents: secondLevel,
                symbol_references: symbolUsage.length > 0 ? symbolUsage.slice(0, 20) : undefined,
                blast_radius: directImporters.length + secondLevel.length,
            };
        }

        case 'todo_scan': {
            if (!root) return { error: 'No project set.' };
            // Tags are interpolated into a regex, so they have to be escaped —
            // otherwise a caller-supplied tag is arbitrary regex injected into
            // a pattern run over every line of every file.
            const rawTags = Array.isArray(args.tags) && args.tags.length
                ? args.tags.slice(0, 20).map(String)
                : ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE'];
            const tags = rawTags.map(t => t.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            const pattern = new RegExp(`\\b(${tags.join('|')})\\b[:\\s]?(.*)`, 'i');
            const results = [];
            const files = discoverCodeFiles(root, args.ext_filter);
            const limit = args.limit || 100;

            for (const fp of files) {
                try {
                    const lines = fs.readFileSync(fp, 'utf-8').split('\n');
                    const relPath = path.relative(root, fp);
                    for (let i = 0; i < lines.length; i++) {
                        const match = lines[i].match(pattern);
                        if (match) {
                            results.push({
                                file: relPath,
                                line: i + 1,
                                tag: match[1].toUpperCase(),
                                text: match[2].trim() || lines[i].trim(),
                            });
                            if (results.length >= limit) break;
                        }
                    }
                } catch {}
                if (results.length >= limit) break;
            }

            // Summary by tag
            const byTag = {};
            for (const r of results) { byTag[r.tag] = (byTag[r.tag] || 0) + 1; }

            return { total: results.length, by_tag: byTag, items: results };
        }

        case 'security_audit': {
            const scanRoot = args.path ? (path.isAbsolute(args.path) ? args.path : path.join(root, args.path)) : root;
            if (!scanRoot) return { error: 'No project set.' };
            // Same gap as repo_map, but worse: an unbounded scanRoot let this
            // hunt for credentials anywhere on disk and report them back.
            try { assertAllowed(scanRoot); } catch (e) { return { error: e.message }; }

            const findings = [];
            const files = discoverCodeFiles(scanRoot, args.ext_filter);
            // Also check .env files specifically
            try {
                const envFiles = fs.readdirSync(scanRoot).filter(f => f.startsWith('.env') || f === 'env');
                for (const ef of envFiles) {
                    const fp = path.join(scanRoot, ef);
                    if (fs.statSync(fp).isFile()) files.push(fp);
                }
            } catch {}

            for (const fp of files) {
                try {
                    const source = fs.readFileSync(fp, 'utf-8');
                    const relPath = path.relative(scanRoot, fp);
                    const lines = source.split('\n');

                    // Pattern-based detection
                    for (const { name: patName, regex } of SECRET_PATTERNS) {
                        // Reset regex lastIndex
                        regex.lastIndex = 0;
                        let match;
                        while ((match = regex.exec(source)) !== null) {
                            // Find line number
                            const upToMatch = source.substring(0, match.index);
                            const lineNum = upToMatch.split('\n').length;
                            findings.push({
                                file: relPath,
                                line: lineNum,
                                type: patName,
                                severity: 'HIGH',
                                preview: maskLine(lines[lineNum - 1] || ''),
                                note: 'Value redacted — open the file at this line to inspect it.',
                            });
                        }
                    }

                    // High-entropy string detection (potential secrets)
                    for (let i = 0; i < lines.length; i++) {
                        const strMatches = lines[i].match(/['"]([A-Za-z0-9+/=_-]{20,})['"]/g);
                        if (strMatches) {
                            for (const sm of strMatches) {
                                const inner = sm.slice(1, -1);
                                if (shannonEntropy(inner) > 4.5 && inner.length >= 20) {
                                    findings.push({
                                        file: relPath,
                                        line: i + 1,
                                        type: 'High-entropy string',
                                        severity: 'MEDIUM',
                                        preview: maskLine(lines[i] || ''),
                                        note: 'Value redacted — open the file at this line to inspect it.',
                                    });
                                }
                            }
                        }
                    }
                } catch {}
            }

            // Deduplicate by file+line
            const seen = new Set();
            const unique = findings.filter(f => {
                const key = `${f.file}:${f.line}:${f.type}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            return {
                total_findings: unique.length,
                by_severity: {
                    HIGH: unique.filter(f => f.severity === 'HIGH').length,
                    MEDIUM: unique.filter(f => f.severity === 'MEDIUM').length,
                },
                findings: unique,
            };
        }

        case 'dead_code': {
            if (!root) return { error: 'No project set.' };
            const extFilter = args.ext_filter || '.js';
            const files = discoverCodeFiles(root, extFilter);

            // Build export map: file -> [exported names]
            const exportMap = {};
            for (const fp of files) {
                try {
                    const source = fs.readFileSync(fp, 'utf-8');
                    const relPath = path.relative(root, fp);
                    const exports = parseExports(fp, source);
                    if (exports.length > 0) exportMap[relPath] = exports;
                } catch {}
            }

            // Build usage map: scan all files for each exported name
            const allSource = {};
            for (const fp of files) {
                try {
                    allSource[path.relative(root, fp)] = fs.readFileSync(fp, 'utf-8');
                } catch {}
            }

            const deadExports = [];
            for (const [file, exports] of Object.entries(exportMap)) {
                for (const exp of exports) {
                    let usedElsewhere = false;
                    for (const [otherFile, source] of Object.entries(allSource)) {
                        if (otherFile === file) continue;
                        if (source.includes(exp)) { usedElsewhere = true; break; }
                    }
                    if (!usedElsewhere) {
                        deadExports.push({ file, symbol: exp });
                    }
                }
            }

            return {
                total_dead_exports: deadExports.length,
                total_files_checked: Object.keys(exportMap).length,
                dead_exports: deadExports,
            };
        }

        default:
            throw new Error(`Unknown intelligence tool: ${name}`);
    }
}

module.exports = { TOOLS, handleTool, configure, getProjectRoot, buildDependencyMap, getDependencyMap, invalidateDependencyCache, parseImports, parseExports };
