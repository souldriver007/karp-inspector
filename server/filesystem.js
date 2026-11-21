// ============================================================================
// KARP Inspector — Filesystem Module
// Author: SoulDriver (Adelaide, Australia)
// Full filesystem CRUD with atomic writes, soft delete, power tools.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
// assertAllowed now lives in utils.js so inspector.js and intelligence.js
// enforce the same boundary — see the comment on configureBoundary there.
const {
    log, formatSize, guessMime, matchGlob, normalizePath, loadGitignore, isIgnored,
    configureBoundary, getAllowedDirs, assertAllowed,
} = require('./utils');

// ── Configuration ──────────────────────────────────────────────

let trashDir = '';
let allowedCommands = [];

// Guard rails shared across the walkers and pattern-taking tools.
const MAX_WALK_DEPTH = 20;          // symlink-cycle / runaway-recursion cap
const MAX_PATTERN_LENGTH = 1000;    // catastrophic-backtracking mitigation
const MAX_READ_BYTES = 20 * 1024 * 1024; // 20MB — a bigger read just OOMs the server

function configure(dirs, trash, commands) {
    configureBoundary(dirs);
    trashDir = trash;
    allowedCommands = commands || [];
}

// ── Tool definitions ───────────────────────────────────────────

const TOOLS = [
    {
        name: 'list_allowed_directories',
        description: 'Returns the list of directories this server is allowed to access.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'read_file',
        description: 'Read the contents of a text file. Supports head/tail line limits.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to the file' },
                head: { type: 'number', description: 'Return only first N lines' },
                tail: { type: 'number', description: 'Return only last N lines' },
                encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
            },
            required: ['path'],
        },
    },
    {
        name: 'read_files',
        description: 'Read multiple files in a single call.',
        inputSchema: {
            type: 'object',
            properties: {
                paths: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths' },
                head: { type: 'number', description: 'Return only first N lines per file' },
            },
            required: ['paths'],
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file. Atomic write (temp + rename). Creates parent dirs if needed. Use dry_run to preview the diff before writing.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to write to' },
                content: { type: 'string', description: 'File content' },
                overwrite: { type: 'boolean', description: 'Allow overwriting (default: false)' },
                create_dirs: { type: 'boolean', description: 'Create parent dirs (default: true)' },
                dry_run: { type: 'boolean', description: 'Preview diff without writing (default: false)' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'patch_file',
        description: 'Edit a file by replacing one exact text match. old_str must match exactly once. Use dry_run to preview the change with context.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to the file' },
                old_str: { type: 'string', description: 'Exact text to find (must match once)' },
                new_str: { type: 'string', description: 'Replacement text (empty to delete)' },
                dry_run: { type: 'boolean', description: 'Preview change without writing (default: false)' },
            },
            required: ['path', 'old_str', 'new_str'],
        },
    },
    {
        name: 'list_directory',
        description: 'List files and directories at a path with type, size, and date.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute directory path' },
                recursive: { type: 'boolean', description: 'List recursively (default: false)' },
                max_depth: { type: 'number', description: 'Max recursion depth (default: 3)' },
                show_hidden: { type: 'boolean', description: 'Include hidden files (default: false)' },
                sort_by: { type: 'string', enum: ['name', 'size', 'modified'], description: 'Sort order' },
            },
            required: ['path'],
        },
    },
    {
        name: 'directory_tree',
        description: 'Recursive tree view of a directory. Respects .gitignore.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute directory path' },
                max_depth: { type: 'number', description: 'Max depth (default: 4)' },
                show_sizes: { type: 'boolean', description: 'Show file sizes (default: false)' },
            },
            required: ['path'],
        },
    },
    {
        name: 'file_info',
        description: 'Detailed metadata: size, dates, permissions, MIME type.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Absolute path' } },
            required: ['path'],
        },
    },
    {
        name: 'move_file',
        description: 'Move or rename a file or directory.',
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string' }, destination: { type: 'string' },
                overwrite: { type: 'boolean', description: 'Overwrite if exists (default: false)' },
            },
            required: ['source', 'destination'],
        },
    },
    {
        name: 'copy_file',
        description: 'Copy a file or directory (recursive for directories).',
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string' }, destination: { type: 'string' },
                overwrite: { type: 'boolean', description: 'Overwrite if exists (default: false)' },
            },
            required: ['source', 'destination'],
        },
    },
    {
        name: 'create_directory',
        description: 'Create a directory (and parents if needed).',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
        },
    },
    {
        name: 'delete_file',
        description: 'Delete a file or directory. Soft delete to trash by default.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                permanent: { type: 'boolean', description: 'Skip trash (default: false)' },
            },
            required: ['path'],
        },
    },
    {
        name: 'find_files',
        description: 'Find files matching a glob pattern with date/size filters.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Root directory' },
                pattern: { type: 'string', description: 'Filename pattern — glob or substring' },
                type: { type: 'string', enum: ['file', 'dir', 'all'], description: 'Filter type' },
                max_depth: { type: 'number', description: 'Max depth (default: 10)' },
                modified_after: { type: 'string', description: 'ISO date filter' },
                modified_before: { type: 'string', description: 'ISO date filter' },
                min_size: { type: 'number' }, max_size: { type: 'number' },
                limit: { type: 'number', description: 'Max results (default: 100)' },
            },
            required: ['path', 'pattern'],
        },
    },
    {
        name: 'search_replace',
        description: 'Find and replace text across multiple files. Has dry_run mode.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Root directory' },
                find: { type: 'string' }, replace: { type: 'string' },
                is_regex: { type: 'boolean' },
                ext_filter: { type: 'string', description: 'Only files with this extension' },
                dry_run: { type: 'boolean', description: 'Preview only (default: true)' },
                limit: { type: 'number', description: 'Max files (default: 50)' },
            },
            required: ['path', 'find', 'replace'],
        },
    },
    {
        name: 'disk_usage',
        description: 'Analyse disk usage: biggest files, directory sizes, by extension.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                top_n: { type: 'number', description: 'Largest items to show (default: 20)' },
            },
            required: ['path'],
        },
    },
    {
        name: 'checksum',
        description: 'Calculate SHA256 hash of one or more files.',
        inputSchema: {
            type: 'object',
            properties: {
                paths: { type: 'array', items: { type: 'string' } },
            },
            required: ['paths'],
        },
    },
    {
        name: 'run_check',
        description: 'Run a pre-approved verification command (syntax check, linter, test suite, build). Commands must match patterns configured in ALLOWED_COMMANDS. Safe: no shell expansion, timeout enforced, output capped.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Command to run (must match an allowed pattern)' },
                cwd: { type: 'string', description: 'Working directory (absolute path, must be in allowed dirs)' },
                timeout: { type: 'number', description: 'Max seconds (default: 30, hard cap: 60)' },
            },
            required: ['command', 'cwd'],
        },
    },
    {
        name: 'list_allowed_commands',
        description: 'Show which commands are pre-approved for run_check.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'git_checkpoint',
        description: 'Create a safety checkpoint before a refactor. If .git exists, creates a WIP commit. If no git, saves all tracked files as snapshots in the database (capped at 500 files / 20MB total, respects .gitignore \u2014 rejects with guidance instead of proceeding if a directory is too large for a no-git checkpoint).',
        inputSchema: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: 'Project directory (absolute path)' },
                message: { type: 'string', description: 'Checkpoint description (default: auto-generated)' },
            },
            required: ['cwd'],
        },
    },
    {
        name: 'karp_undo',
        description: 'Revert the last file operation(s) using snapshots saved in the database. Shows what will be reverted before applying.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'Specific file to revert (relative path), or omit to see recent snapshots' },
                snapshot_id: { type: 'integer', description: 'Specific snapshot ID to restore (from file_history)' },
                dry_run: { type: 'boolean', description: 'Preview only (default: true)' },
            },
        },
    },
];

// ── Walk / Tree helpers ────────────────────────────────────────

function walkDir(dirPath, opts = {}) {
    const { maxDepth = 10, currentDepth = 0, showHidden = false, ignorePatterns = [] } = opts;
    if (currentDepth > maxDepth) return [];
    let entries = [];
    try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const item of items) {
            if (!showHidden && item.name.startsWith('.')) continue;
            if (isIgnored(item.name, ignorePatterns)) continue;
            const fullPath = path.join(dirPath, item.name);
            const stat = fs.statSync(fullPath);
            entries.push({ name: item.name, path: fullPath, type: item.isDirectory() ? 'dir' : 'file', size: stat.size, modified: stat.mtime.toISOString() });
            if (item.isDirectory() && currentDepth < maxDepth) {
                entries = entries.concat(walkDir(fullPath, { ...opts, currentDepth: currentDepth + 1 }));
            }
        }
    } catch {}
    return entries;
}

function buildTree(dirPath, prefix = '', depth = 0, maxDepth = 4, showSizes = false, ignorePatterns = []) {
    if (depth > maxDepth) return '';
    let result = '';
    try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(i => !i.name.startsWith('.') && !isIgnored(i.name, ignorePatterns))
            .sort((a, b) => { if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1; return a.name.localeCompare(b.name); });
        items.forEach((item, idx) => {
            const isLast = idx === items.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const fullPath = path.join(dirPath, item.name);
            let sizeSuffix = '';
            if (showSizes && !item.isDirectory()) { try { sizeSuffix = ` (${formatSize(fs.statSync(fullPath).size)})`; } catch {} }
            result += `${prefix}${connector}${item.name}${item.isDirectory() ? '/' : ''}${sizeSuffix}\n`;
            if (item.isDirectory() && depth < maxDepth) {
                result += buildTree(fullPath, prefix + (isLast ? '    ' : '│   '), depth + 1, maxDepth, showSizes, ignorePatterns);
            }
        });
    } catch {}
    return result;
}

// ── Tool handlers ──────────────────────────────────────────────

async function handleTool(name, args) {
    switch (name) {
        case 'list_allowed_directories': {
            const dirs = getAllowedDirs();
            return dirs.length > 0
                ? `Allowed directories:\n${dirs.map(d => `  • ${d}`).join('\n')}`
                : 'No project directories configured — all filesystem, search and analysis tools are disabled until at least one is set on the config screen.';
        }

        case 'read_file': {
            assertAllowed(args.path);
            const rfTarget = normalizePath(args.path);
            const rfSize = fs.statSync(rfTarget).size;
            if (rfSize > MAX_READ_BYTES) {
                throw new Error(`File is ${formatSize(rfSize)}, over the ${formatSize(MAX_READ_BYTES)} read cap. Use head/tail, or grep_code to find the part you need.`);
            }
            let content = fs.readFileSync(rfTarget, args.encoding || 'utf-8');
            if (args.head || args.tail) {
                const lines = content.split('\n');
                content = args.head ? lines.slice(0, args.head).join('\n') : lines.slice(-args.tail).join('\n');
            }
            return content;
        }

        case 'read_files': {
            const results = [];
            for (const p of args.paths) {
                try {
                    assertAllowed(p);
                    const rp = normalizePath(p);
                    if (fs.statSync(rp).size > MAX_READ_BYTES) {
                        throw new Error(`over the ${formatSize(MAX_READ_BYTES)} read cap — use read_file with head/tail`);
                    }
                    let content = fs.readFileSync(rp, 'utf-8');
                    if (args.head) content = content.split('\n').slice(0, args.head).join('\n');
                    results.push(`── ${p} ──\n${content}`);
                } catch (e) { results.push(`── ${p} ──\n[ERROR] ${e.message}`); }
            }
            return results.join('\n\n');
        }

        case 'write_file': {
            const target = normalizePath(args.path);
            assertAllowed(target);

            // Dry run: show diff without writing
            if (args.dry_run) {
                if (fs.existsSync(target)) {
                    const existing = fs.readFileSync(target, 'utf-8');
                    const diff = generateDiff(existing, args.content, `${target} (current)`, `${target} (new)`);
                    return `[DRY RUN] Would overwrite ${target}\n\n${diff}`;
                }
                return `[DRY RUN] Would create new file: ${target} (${formatSize(Buffer.byteLength(args.content, 'utf-8'))})`;
            }

            // Auto-snapshot before overwriting (makes karp_undo work)
            if (fs.existsSync(target)) {
                if (!args.overwrite) throw new Error(`File exists: ${target}. Set overwrite: true.`);
                try { autoSnapshot(target, fs.readFileSync(target, 'utf-8')); } catch {}
            }
            if (args.create_dirs !== false) fs.mkdirSync(path.dirname(target), { recursive: true });
            const tmpPath = target + `.tmp.${Date.now()}`;
            fs.writeFileSync(tmpPath, args.content, 'utf-8');
            fs.renameSync(tmpPath, target);
            return `Written: ${target} (${formatSize(fs.statSync(target).size)})`;
        }

        case 'patch_file': {
            const target = normalizePath(args.path);
            assertAllowed(target);
            let content = fs.readFileSync(target, 'utf-8');
            const count = content.split(args.old_str).length - 1;
            if (count === 0) throw new Error(`old_str not found in ${target}`);
            if (count > 1) throw new Error(`old_str found ${count} times — must be unique.`);

            // Dry run: show the change with context
            if (args.dry_run) {
                const lines = content.split('\n');
                const matchStart = content.indexOf(args.old_str);
                const lineNum = content.substring(0, matchStart).split('\n').length;
                const oldLines = args.old_str.split('\n').length;
                const contextStart = Math.max(0, lineNum - 4);
                const contextEnd = Math.min(lines.length, lineNum + oldLines + 3);
                const preview = [];
                preview.push(`[DRY RUN] ${target} — line ${lineNum}`);
                preview.push('');
                for (let i = contextStart; i < contextEnd; i++) {
                    const inMatch = i >= lineNum - 1 && i < lineNum - 1 + oldLines;
                    preview.push(`${inMatch ? '-' : ' '} ${(i + 1).toString().padStart(4)} | ${lines[i]}`);
                }
                preview.push('');
                preview.push('Would replace with:');
                for (const line of args.new_str.split('\n')) {
                    preview.push(`+      | ${line}`);
                }
                preview.push('');
                preview.push('Set dry_run: false (or omit) to apply.');
                return preview.join('\n');
            }

            // Auto-snapshot before modifying (makes karp_undo work)
            autoSnapshot(target, content);
            // Use split+join to avoid $& $1 $` pattern interpretation in replacement
            content = content.split(args.old_str).join(args.new_str);
            const tmpPath = target + `.tmp.${Date.now()}`;
            fs.writeFileSync(tmpPath, content, 'utf-8');
            fs.renameSync(tmpPath, target);
            return `Patched: ${target}`;
        }

        case 'list_directory': {
            const target = normalizePath(args.path);
            assertAllowed(target);
            const ignorePatterns = loadGitignore(target);
            if (args.recursive) {
                const entries = walkDir(target, { maxDepth: args.max_depth || 3, showHidden: args.show_hidden, ignorePatterns });
                const sorted = entries.sort((a, b) => args.sort_by === 'size' ? b.size - a.size : args.sort_by === 'modified' ? new Date(b.modified) - new Date(a.modified) : a.name.localeCompare(b.name));
                return sorted.map(e => `[${e.type === 'dir' ? 'DIR ' : 'FILE'}] ${e.path} (${formatSize(e.size)}, ${e.modified.slice(0, 10)})`).join('\n');
            }
            const items = fs.readdirSync(target, { withFileTypes: true }).filter(i => (args.show_hidden || !i.name.startsWith('.')) && !isIgnored(i.name, ignorePatterns));
            const entries = items.map(item => { const fp = path.join(target, item.name); try { const s = fs.statSync(fp); return { name: item.name, type: item.isDirectory() ? 'dir' : 'file', size: s.size, modified: s.mtime.toISOString() }; } catch { return null; } }).filter(Boolean);
            const sorted = entries.sort((a, b) => { if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; return a.name.localeCompare(b.name); });
            return sorted.map(e => `[${e.type === 'dir' ? 'DIR ' : 'FILE'}] ${e.name} (${formatSize(e.size)}, ${e.modified.slice(0, 10)})`).join('\n');
        }

        case 'directory_tree': {
            const target = normalizePath(args.path);
            assertAllowed(target);
            return `${path.basename(target)}/\n${buildTree(target, '', 0, args.max_depth || 4, args.show_sizes, loadGitignore(target))}`;
        }

        case 'file_info': {
            const target = normalizePath(args.path);
            assertAllowed(target);
            const stat = fs.statSync(target);
            const ext = path.extname(target);
            return [`Path: ${target}`, `Type: ${stat.isDirectory() ? 'directory' : 'file'}`, `Size: ${formatSize(stat.size)} (${stat.size} bytes)`, `MIME: ${guessMime(ext)}`, `Created: ${stat.birthtime.toISOString()}`, `Modified: ${stat.mtime.toISOString()}`, `Permissions: ${(stat.mode & 0o777).toString(8)}`].join('\n');
        }

        case 'move_file': {
            const src = normalizePath(args.source), dst = normalizePath(args.destination);
            assertAllowed(src); assertAllowed(dst);
            if (fs.existsSync(dst) && !args.overwrite) throw new Error(`Destination exists: ${dst}`);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.renameSync(src, dst);
            return `Moved: ${src} → ${dst}`;
        }

        case 'copy_file': {
            const src = normalizePath(args.source), dst = normalizePath(args.destination);
            assertAllowed(src); assertAllowed(dst);
            if (fs.existsSync(dst) && !args.overwrite) throw new Error(`Destination exists: ${dst}`);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.cpSync(src, dst, { recursive: true });
            return `Copied: ${src} → ${dst} (${formatSize(fs.statSync(dst).size)})`;
        }

        case 'create_directory': {
            const target = normalizePath(args.path);
            assertAllowed(target);
            fs.mkdirSync(target, { recursive: true });
            return `Created: ${target}`;
        }

        case 'delete_file': {
            const target = normalizePath(args.path);
            assertAllowed(target);
            // Auto-snapshot before deleting (makes karp_undo work for file recovery)
            if (fs.existsSync(target) && fs.statSync(target).isFile()) {
                try { autoSnapshot(target, fs.readFileSync(target, 'utf-8')); } catch {}
            }
            if (args.permanent) { fs.rmSync(target, { recursive: true }); return `Permanently deleted: ${target}`; }
            fs.mkdirSync(trashDir, { recursive: true });
            const trashPath = path.join(trashDir, `${path.basename(target)}.${Date.now()}`);
            fs.renameSync(target, trashPath);
            return `Moved to trash: ${target}`;
        }

        case 'find_files': {
            const root = normalizePath(args.path);
            assertAllowed(root);
            const results = [];
            const ign = loadGitignore(root);
            function search(dir, depth) {
                if (depth > (args.max_depth || 10) || results.length >= (args.limit || 100)) return;
                try {
                    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (results.length >= (args.limit || 100)) break;
                        if (item.name.startsWith('.') || isIgnored(item.name, ign)) continue;
                        const fp = path.join(dir, item.name);
                        const isDir = item.isDirectory();
                        if ((args.type || 'file') === 'file' && isDir) { search(fp, depth + 1); continue; }
                        if (args.type === 'dir' && !isDir) continue;
                        if (matchGlob(item.name, args.pattern) || item.name.includes(args.pattern)) {
                            try {
                                const s = fs.statSync(fp);
                                if (args.modified_after && s.mtime < new Date(args.modified_after)) continue;
                                if (args.modified_before && s.mtime > new Date(args.modified_before)) continue;
                                if (args.min_size && s.size < args.min_size) continue;
                                if (args.max_size && s.size > args.max_size) continue;
                                results.push({ path: fp, type: isDir ? 'dir' : 'file', size: s.size, modified: s.mtime.toISOString() });
                            } catch {}
                        }
                        if (isDir) search(fp, depth + 1);
                    }
                } catch {}
            }
            search(root, 0);
            if (!results.length) return `No matches for "${args.pattern}" in ${root}`;
            return results.map(r => `[${r.type === 'dir' ? 'DIR ' : 'FILE'}] ${r.path} (${formatSize(r.size)}, ${r.modified.slice(0, 10)})`).join('\n');
        }

        case 'search_replace': {
            const root = normalizePath(args.path);
            assertAllowed(root);
            if (typeof args.find !== 'string' || args.find.length > MAX_PATTERN_LENGTH) {
                throw new Error(`"find" must be a string of at most ${MAX_PATTERN_LENGTH} characters.`);
            }
            const results = [];
            let totalMatches = 0;
            // Depth cap: this walker had none and no visited-set, so a symlink
            // cycle recursed until the stack blew and took the server with it.
            function searchDir(dir, depth = 0) {
                if (depth > MAX_WALK_DEPTH) return;
                if (results.length >= (args.limit || 50)) return;
                try {
                    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (item.name.startsWith('.') || isIgnored(item.name, [])) continue;
                        const fp = path.join(dir, item.name);
                        if (item.isSymbolicLink()) continue;
                        if (item.isDirectory()) { searchDir(fp, depth + 1); continue; }
                        if (args.ext_filter && !item.name.endsWith(args.ext_filter)) continue;
                        try {
                            const content = fs.readFileSync(fp, 'utf-8');
                            const matches = args.is_regex ? [...content.matchAll(new RegExp(args.find, 'g'))].length : content.split(args.find).length - 1;
                            if (matches > 0) {
                                totalMatches += matches;
                                if (args.dry_run === false) {
                                    // Auto-snapshot before modifying
                                    autoSnapshot(fp, content);
                                    const nc = args.is_regex ? content.replace(new RegExp(args.find, 'g'), args.replace) : content.replaceAll(args.find, args.replace);
                                    // Atomic write (temp + rename)
                                    const tmpFp = fp + `.tmp.${Date.now()}`;
                                    fs.writeFileSync(tmpFp, nc, 'utf-8');
                                    fs.renameSync(tmpFp, fp);
                                }
                                results.push({ path: fp, matches });
                            }
                        } catch {}
                    }
                } catch {}
            }
            searchDir(root);
            const mode = args.dry_run === false ? 'APPLIED' : 'DRY RUN';
            if (!results.length) return `No matches for "${args.find}"`;
            return `[${mode}] ${totalMatches} matches across ${results.length} files:\n${results.map(r => `  ${r.path} (${r.matches})`).join('\n')}${args.dry_run !== false ? '\n\nSet dry_run: false to apply.' : ''}`;
        }

        case 'disk_usage': {
            const root = normalizePath(args.path);
            assertAllowed(root);
            const files = []; const extSizes = {}; let totalSize = 0;
            function scan(dir, depth = 0) {
                if (depth > MAX_WALK_DEPTH) return;
                try {
                    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (item.name.startsWith('.') || isIgnored(item.name, [])) continue;
                        const fp = path.join(dir, item.name);
                        if (item.isSymbolicLink()) continue;
                        if (item.isDirectory()) { scan(fp, depth + 1); continue; }
                        try { const s = fs.statSync(fp); totalSize += s.size; files.push({ path: fp, size: s.size }); const ext = path.extname(item.name).toLowerCase() || '(no ext)'; extSizes[ext] = (extSizes[ext] || 0) + s.size; } catch {}
                    }
                } catch {}
            }
            scan(root);
            files.sort((a, b) => b.size - a.size);
            const topN = args.top_n || 20;
            return [`Total: ${formatSize(totalSize)} across ${files.length} files`, '', `── Top ${topN} largest ──`, ...files.slice(0, topN).map(f => `  ${formatSize(f.size).padStart(10)}  ${f.path}`), '', '── By extension ──', ...Object.entries(extSizes).sort((a, b) => b[1] - a[1]).map(([ext, size]) => `  ${formatSize(size).padStart(10)}  ${ext}`)].join('\n');
        }

        case 'checksum': {
            return args.paths.map(p => {
                try { assertAllowed(p); const hash = crypto.createHash('sha256').update(fs.readFileSync(normalizePath(p))).digest('hex'); return `${hash}  ${p}`; }
                catch (e) { return `[ERROR]  ${p}: ${e.message}`; }
            }).join('\n');
        }

        case 'run_check': {
            // Validate working directory
            const cwd = normalizePath(args.cwd);
            assertAllowed(cwd);
            if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
                throw new Error(`Working directory not found: ${cwd}`);
            }

            // Validate command against allowed patterns
            const cmd = args.command.trim();
            if (allowedCommands.length === 0) {
                throw new Error(
                    'No commands configured. Set ALLOWED_COMMANDS in your env config.\n' +
                    'Example: "ALLOWED_COMMANDS": "node --check;npm test;npm run lint;npm run build;npx tsc --noEmit;pytest"'
                );
            }

            const isAllowedCmd = allowedCommands.some(pattern => {
                // Match if the command starts with the allowed pattern
                return cmd === pattern || cmd.startsWith(pattern + ' ');
            });

            if (!isAllowedCmd) {
                throw new Error(
                    `Command not allowed: "${cmd}"\n` +
                    `Approved commands: ${allowedCommands.join(', ')}\n` +
                    'Configure via ALLOWED_COMMANDS in your env.'
                );
            }

            // Parse command into executable + args (no shell)
            const parts = cmd.split(/\s+/);
            let executable = parts[0];
            const execArgs = parts.slice(1);

            // On Windows, npm/npx/pytest are .cmd shims — spawnSync without shell can't find them
            // Resolve to .cmd explicitly to keep shell:false (injection-safe)
            if (process.platform === 'win32' && !executable.includes('.')) {
                // spawnSync, not execSync with an interpolated string. The
                // allowlist check above currently pins `executable` to a known
                // first token, so this was not exploitable — but it was one
                // refactor away from being a shell injection point.
                try {
                    const lookup = spawnSync('where', [executable], { encoding: 'utf-8', timeout: 3000, windowsHide: true });
                    const where = (lookup.stdout || '').trim().split('\n')[0].trim();
                    if (where.toLowerCase().endsWith('.cmd')) executable = where;
                } catch {}
            }

            // Enforce timeout (default 30s, floor 1s, hard cap 60s).
            // Math.min alone let a negative timeout through.
            const requested = Number(args.timeout) > 0 ? Number(args.timeout) : 30;
            const timeoutMs = Math.min(Math.max(requested, 1), 60) * 1000;

            log('INFO', `run_check: ${cmd} (cwd: ${cwd}, timeout: ${timeoutMs / 1000}s)`);

            try {
                // Use spawnSync — no shell expansion, direct exec
                const result = spawnSync(executable, execArgs, {
                    cwd,
                    timeout: timeoutMs,
                    encoding: 'utf-8',
                    // No shell: true — prevents injection
                    windowsHide: true,
                    maxBuffer: 1024 * 1024, // 1MB max output
                    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, // clean output
                });

                // Cap output to avoid flooding context
                const MAX_OUTPUT = 10240; // 10KB
                let stdout = (result.stdout || '').trim();
                let stderr = (result.stderr || '').trim();

                if (stdout.length > MAX_OUTPUT) {
                    stdout = stdout.slice(0, MAX_OUTPUT) + '\n... (output truncated at 10KB)';
                }
                if (stderr.length > MAX_OUTPUT) {
                    stderr = stderr.slice(0, MAX_OUTPUT) + '\n... (output truncated at 10KB)';
                }

                const exitCode = result.status;
                const timedOut = result.signal === 'SIGTERM';

                const output = [];
                output.push(`Command: ${cmd}`);
                output.push(`Exit code: ${timedOut ? 'TIMEOUT' : exitCode}`);

                if (timedOut) {
                    output.push(`\n⚠ Command timed out after ${timeoutMs / 1000}s`);
                }

                if (exitCode === 0) {
                    output.push('Status: ✓ PASSED');
                } else {
                    output.push('Status: ✗ FAILED');
                }

                if (stdout) {
                    output.push(`\n── stdout ──\n${stdout}`);
                }
                if (stderr) {
                    output.push(`\n── stderr ──\n${stderr}`);
                }
                if (!stdout && !stderr) {
                    output.push('\n(no output)');
                }

                return output.join('\n');
            } catch (e) {
                if (e.code === 'ENOENT') {
                    throw new Error(`Command not found: "${executable}". Is it installed and in PATH?`);
                }
                throw new Error(`Execution failed: ${e.message}`);
            }
        }

        case 'list_allowed_commands': {
            if (allowedCommands.length === 0) {
                return 'No commands configured.\nSet ALLOWED_COMMANDS in your env, e.g.:\n"ALLOWED_COMMANDS": "node --check;npm test;npm run lint;npm run build;pytest"';
            }
            return `Pre-approved command patterns (${allowedCommands.length}):\n${allowedCommands.map(c => `  ✓ ${c}`).join('\n')}\n\nAny command starting with these patterns will be allowed by run_check.`;
        }

        case 'git_checkpoint': {
            const cwd = normalizePath(args.cwd);
            assertAllowed(cwd);
            const gitDir = path.join(cwd, '.git');
            const msg = args.message || `karp-checkpoint: ${new Date().toISOString().slice(0, 19)}`;

            if (fs.existsSync(gitDir)) {
                // A .git folder existing doesn't guarantee the git executable
                // is actually installed/on PATH \u2014 e.g. a cloned or copied
                // repo on a machine without git. spawnSync does NOT throw
                // when the executable can't be found; it sets result.error
                // instead. That has to be checked explicitly, or a missing
                // git silently falls through to a false "success" with no
                // real commit (empty hash). Falls back to the same SQLite
                // snapshot path used when there's no .git at all.
                const addResult = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf-8', timeout: 10000, windowsHide: true });

                if (addResult.error) {
                    log('WARN', `git_checkpoint: git executable not usable (${addResult.error.message}) \u2014 falling back to SQLite snapshot`);
                    return sqliteCheckpoint(cwd, msg);
                }

                try {
                    const commitResult = spawnSync('git', ['commit', '-m', msg, '--allow-empty'], { cwd, encoding: 'utf-8', timeout: 10000, windowsHide: true });
                    const hashResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 5000, windowsHide: true });
                    const hash = (hashResult.stdout || '').trim();
                    if (!hash) {
                        return { error: `Git checkpoint failed \u2014 no commit hash returned. stderr: ${(commitResult.stderr || hashResult.stderr || '').trim() || 'none'}` };
                    }
                    return { type: 'git', commit: hash, message: msg, cwd, status: 'Checkpoint created. Revert with: git reset --soft HEAD~1' };
                } catch (e) {
                    return { error: `Git checkpoint failed: ${e.message}` };
                }
            }

            return sqliteCheckpoint(cwd, msg);
        }

        case 'karp_undo': {
            try {
                const { getDb } = require('./database');
                const db = getDb();

                if (args.snapshot_id) {
                    // Restore specific snapshot
                    const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(args.snapshot_id);
                    if (!snap) return { error: `Snapshot ${args.snapshot_id} not found` };

                    if (args.dry_run !== false) {
                        return { dry_run: true, snapshot_id: snap.id, file: snap.filepath, project: snap.project_root, timestamp: new Date(snap.created_at * 1000).toISOString(), size: snap.full_content.length, message: 'Set dry_run: false to restore this snapshot.' };
                    }

                    const targetPath = path.join(snap.project_root, snap.filepath);
                    assertAllowed(targetPath);
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    fs.writeFileSync(targetPath, snap.full_content, 'utf-8');
                    return { restored: snap.filepath, snapshot_id: snap.id, timestamp: new Date(snap.created_at * 1000).toISOString() };
                }

                if (args.filepath) {
                    // Show snapshots for specific file
                    const snaps = db.prepare('SELECT id, filepath, project_root, created_at, length(full_content) as size FROM snapshots WHERE filepath = ? ORDER BY created_at DESC LIMIT 10').all(args.filepath);
                    return { file: args.filepath, snapshots: snaps.map(s => ({ id: s.id, timestamp: new Date(s.created_at * 1000).toISOString(), size: s.size })), message: 'Use snapshot_id with dry_run: false to restore.' };
                }

                // Show recent snapshots across all files
                const recent = db.prepare('SELECT id, filepath, project_root, created_at, length(full_content) as size FROM snapshots ORDER BY created_at DESC LIMIT 20').all();
                return { recent_snapshots: recent.map(s => ({ id: s.id, file: s.filepath, timestamp: new Date(s.created_at * 1000).toISOString(), size: s.size })), message: 'Use snapshot_id with dry_run: false to restore.' };
            } catch (e) {
                return { error: `Undo failed: ${e.message}` };
            }
        }

        default:
            throw new Error(`Unknown filesystem tool: ${name}`);
    }
}

// Helper for git_checkpoint — discover text files for snapshot.
// Now respects .gitignore (previously didn't, unlike every other walker
// in this file) and takes ignorePatterns so the caller can enforce it.
function discoverTrackedFiles(dir, ignorePatterns = [], depth = 0) {
    if (depth > 5) return [];
    const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css', '.md', '.json', '.txt', '.yaml', '.yml']);
    const SKIP = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.karp-premium', 'data']);
    let files = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || SKIP.has(entry.name) || isIgnored(entry.name, ignorePatterns)) continue;
            const fp = path.join(dir, entry.name);
            if (entry.isDirectory()) { files = files.concat(discoverTrackedFiles(fp, ignorePatterns, depth + 1)); continue; }
            if (CODE_EXTS.has(path.extname(entry.name).toLowerCase())) files.push(fp);
        }
    } catch {}
    return files;
}

// Shared by git_checkpoint for both cases that need it: no .git present,
// or .git present but the git executable itself isn't usable. Capped
// BEFORE any DB write \u2014 this exact unbounded walk (no file-count or
// size limit) once swept up 4700+ files from a directory much bigger
// than intended and bloated a database from ~1MB to 850MB in a single
// call. See the product checkpoint for the full incident.
function sqliteCheckpoint(cwd, msg) {
    const MAX_CHECKPOINT_FILES = 500;
    const MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024; // 20MB

    try {
        const ignorePatterns = loadGitignore(cwd);
        const files = discoverTrackedFiles(cwd, ignorePatterns);

        if (files.length > MAX_CHECKPOINT_FILES) {
            return {
                error: `This directory has ${files.length} trackable files \u2014 over the ${MAX_CHECKPOINT_FILES}-file safety cap for a no-git checkpoint. ` +
                       `This usually means cwd points at something bigger than a single project (e.g. a whole workspace root, not the project itself). ` +
                       `Either scope cwd to the actual project subfolder, or run "git init" in that directory so git_checkpoint can use real git commits instead of database snapshots.`,
            };
        }

        // Size all files before reading any of them, so an over-cap
        // checkpoint is rejected with zero DB writes, not a partial one.
        let totalBytes = 0;
        const sized = [];
        for (const fp of files) {
            try {
                const size = fs.statSync(fp).size;
                totalBytes += size;
                sized.push(fp);
            } catch {}
        }

        if (totalBytes > MAX_CHECKPOINT_BYTES) {
            return {
                error: `This directory's trackable files total ${formatSize(totalBytes)} \u2014 over the ${formatSize(MAX_CHECKPOINT_BYTES)} safety cap for a no-git checkpoint. ` +
                       `Same guidance: scope cwd to a smaller subfolder, or run "git init" here to use real git commits instead.`,
            };
        }

        const { getDb } = require('./database');
        const db = getDb();
        let count = 0;
        for (const fp of sized) {
            try {
                const content = fs.readFileSync(fp, 'utf-8');
                const relPath = path.relative(cwd, fp);
                db.prepare('INSERT INTO snapshots (filepath, project_root, full_content, created_at) VALUES (?, ?, ?, ?)').run(relPath, cwd, content, Date.now() / 1000);
                count++;
            } catch {}
        }
        return { type: 'sqlite', files_saved: count, total_size: formatSize(totalBytes), message: msg, cwd, status: `Saved ${count} file snapshots (${formatSize(totalBytes)}) to database. Revert with karp_undo.` };
    } catch (e) {
        return { error: `Snapshot checkpoint failed: ${e.message}` };
    }
}

// Generate a unified diff between two strings for dry_run previews
function generateDiff(oldText, newText, oldLabel, newLabel) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const result = [`--- ${oldLabel}`, `+++ ${newLabel}`];
    let changes = 0;
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
        const oldLine = i < oldLines.length ? oldLines[i] : undefined;
        const newLine = i < newLines.length ? newLines[i] : undefined;
        if (oldLine === newLine) continue;
        if (oldLine !== undefined && newLine !== undefined) {
            result.push(`- ${(i + 1).toString().padStart(4)} | ${oldLine}`);
            result.push(`+ ${(i + 1).toString().padStart(4)} | ${newLine}`);
            changes++;
        } else if (oldLine === undefined) {
            result.push(`+ ${(i + 1).toString().padStart(4)} | ${newLine}`);
            changes++;
        } else {
            result.push(`- ${(i + 1).toString().padStart(4)} | ${oldLine}`);
            changes++;
        }
    }
    if (changes === 0) return '(no changes)';
    result.push('');
    result.push(`${changes} line(s) changed`);
    return result.join('\n');
}

// Auto-snapshot: saves file content to SQLite before destructive operations
// Prunes to keep last 20 snapshots per file to prevent unbounded growth
const MAX_SNAPSHOTS_PER_FILE = 20;

function autoSnapshot(filepath, content) {
    try {
        const { getDb } = require('./database');
        const db = getDb();
        const now = Date.now() / 1000;
        // Use relative path if we can determine project root, otherwise absolute
        const relPath = filepath;
        db.prepare('INSERT INTO snapshots (filepath, project_root, full_content, created_at) VALUES (?, ?, ?, ?)')
            .run(relPath, '', content, now);
        // Prune old snapshots for this file
        const count = db.prepare('SELECT COUNT(*) as c FROM snapshots WHERE filepath = ?').get(relPath);
        if (count && count.c > MAX_SNAPSHOTS_PER_FILE) {
            db.prepare(
                `DELETE FROM snapshots WHERE filepath = ? AND id NOT IN (
                    SELECT id FROM snapshots WHERE filepath = ? ORDER BY created_at DESC LIMIT ?
                )`
            ).run(relPath, relPath, MAX_SNAPSHOTS_PER_FILE);
        }
    } catch (e) {
        log('WARN', `Auto-snapshot failed for ${filepath}: ${e.message}`);
    }
}

module.exports = { TOOLS, handleTool, configure };
