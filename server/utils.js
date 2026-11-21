// ============================================================================
// KARP Inspector — Shared Utilities
// Author: SoulDriver (Adelaide, Australia)
// ============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function log(level, msg) {
    process.stderr.write(`${new Date().toISOString()} [${level}] ${msg}\n`);
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function guessMime(ext) {
    const map = {
        '.js': 'application/javascript', '.mjs': 'application/javascript',
        '.ts': 'application/typescript', '.json': 'application/json',
        '.py': 'text/x-python', '.md': 'text/markdown',
        '.html': 'text/html', '.css': 'text/css',
        '.txt': 'text/plain', '.csv': 'text/csv',
        '.xml': 'text/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
        '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
        '.zip': 'application/zip', '.gz': 'application/gzip',
        '.sql': 'text/x-sql', '.sh': 'text/x-shellscript',
        '.rb': 'text/x-ruby', '.go': 'text/x-go',
        '.rs': 'text/x-rust', '.java': 'text/x-java',
    };
    return map[ext?.toLowerCase()] || 'application/octet-stream';
}

function matchGlob(filename, pattern) {
    const regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regex}$`, 'i').test(filename);
}

function computeHash(filepath) {
    const content = fs.readFileSync(filepath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizePath(p) {
    return path.resolve(p.replace(/\\/g, '/'));
}

function loadGitignore(dirPath) {
    const ignorePath = path.join(dirPath, '.gitignore');
    if (!fs.existsSync(ignorePath)) return [];
    return fs.readFileSync(ignorePath, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function isIgnored(name, ignorePatterns) {
    const defaults = ['node_modules', '.git', '__pycache__', '.DS_Store', 'Thumbs.db', 'venv', '.venv', 'dist', 'build', '.next', '.nuxt', 'coverage', '.tox', '.mypy_cache', '.pytest_cache', 'egg-info', '.eggs', '.cache', '.tmp', 'vendor', '.karp-inspector', '.karp-premium'];
    if (defaults.includes(name)) return true;
    return ignorePatterns.some(p => matchGlob(name, p));
}

function generateId() {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(4).toString('hex');
    return `kp_${ts}_${rand}`;
}

// ── Directory boundary ─────────────────────────────────────────
// This lives in utils (not filesystem.js) deliberately. It used to be
// private to the filesystem module, which meant inspector.js and
// intelligence.js — set_project, index_project, grep_code, repo_map,
// security_audit — had NO boundary check at all. set_project accepted any
// directory that existed, so grep_code could read arbitrary files anywhere
// on disk, in the free tier, while the config screen promised "Claude can't
// touch anything outside these". Shared here so every module enforces the
// same boundary.

let allowedDirs = [];

// Desktop hands the .mcpb `project_dirs` field (multiple: true) to us through
// argv, and at least one of those entries can arrive wrapped in LITERAL
// double-quote characters — `"D:\Projects"` rather than `D:\Projects`.
//
// That one leading `"` is enough to break everything downstream, silently: the
// string is no longer absolute, so path.resolve() rebases it on process.cwd(),
// which for a Desktop-spawned server is C:\WINDOWS\system32. The boundary entry
// becomes `C:\WINDOWS\system32\"D:\Projects"` — a path that cannot match
// anything — so every call against that root is denied, and the "Allowed:" list
// in the error reads like the server is concatenating user input into the
// allowlist. It isn't; it's cwd + a quoted config value.
//
// Two rules here, both deliberate:
//   1. strip surrounding quotes before doing anything else;
//   2. never let a non-absolute entry through to path.resolve(). Silently
//      rebasing on cwd is how a config typo turns into a phantom root instead
//      of a loud error.
function cleanDirEntry(d) {
    let s = String(d).trim();
    while (s.length > 1 &&
           ((s[0] === '"' && s[s.length - 1] === '"') ||
            (s[0] === "'" && s[s.length - 1] === "'"))) {
        s = s.slice(1, -1).trim();
    }
    // Trailing-backslash escaping (`"D:\dir\"`) can leave an unmatched straggler.
    return s.replace(/^["']+|["']+$/g, '').trim();
}

/**
 * Clean → validate → resolve → canonicalise a list of raw directory strings.
 * Idempotent: already-clean absolute paths pass through unchanged, so it is
 * safe for both index.js (display/log) and configureBoundary (enforcement) to
 * call it, and they cannot disagree about what the boundary actually is.
 */
function normaliseAllowedDirs(dirs) {
    return (dirs || []).map(cleanDirEntry).filter(Boolean).map(d => {
        // `D:` is drive-RELATIVE on Windows, not absolute — path.isAbsolute('D:')
        // is false, and path.resolve('D:') resolves against whatever cwd that
        // drive happens to have, which is process state and almost never what
        // was meant. Anyone who picks or types `D:` means the drive root, so
        // make that explicit rather than dropping it or guessing.
        // (This also catches `D:"` — trailing-quote mangling collapses to `D:`.)
        const bare = /^[A-Za-z]:$/.test(d) ? d + '\\' : d;
        const slashed = bare.replace(/\\/g, '/');
        if (!path.isAbsolute(slashed)) {
            log('ERROR',
                `Ignoring project directory ${JSON.stringify(d)} — not an absolute path. ` +
                `Resolving it would silently rebase it on ${process.cwd()}. ` +
                `Re-pick the folder under Settings → Extensions → KARP Inspector ` +
                `(or fix ALLOWED_DIRS in claude_desktop_config.json).`);
            return null;
        }
        const resolved = path.resolve(slashed);
        // Canonicalise the allowed roots too — otherwise a symlinked project
        // root would never match its own realpath'd children.
        try { return fs.realpathSync(resolved); } catch { return resolved; }
    }).filter(Boolean);
}

function configureBoundary(dirs) {
    allowedDirs = normaliseAllowedDirs(dirs);
}

function getAllowedDirs() {
    return allowedDirs;
}

// The server's own storage — knowledge graph DB, auto-snapshots, trash.
// Denied unconditionally, even when it sits inside an allowed dir. Without
// this, configuring a whole drive (or merely a parent of DATA_PATH) puts the
// live database, the snapshots that exist to recover it, and the trash holding
// the only copy of soft-deleted files all inside the blast radius of
// write_file / patch_file / search_replace / delete_file. The recovery
// mechanism must not be reachable by the thing it recovers from.
//
// No carve-out is needed for the server's own writes: delete_file moves into
// TRASH_DIR via fs.renameSync directly, and every assertAllowed() call site
// takes a user-supplied path, never an internal one.
let protectedDirs = [];

function configureProtected(dirs) {
    protectedDirs = normaliseAllowedDirs(dirs);
}

/**
 * Is `resolvedCmp` (already case-normalised) equal to `dir`, or inside it?
 *
 * The separator matters: without it, /home/user would also match
 * /home/user-secrets. But a filesystem root ALREADY ends in a separator —
 * 'D:\' on Windows, '/' on POSIX — so naively appending one yields 'D:\\',
 * a double separator that matches nothing, which is why configuring a whole
 * drive denied every path on it except the bare root. Strip any trailing
 * separator first, then append exactly one.
 */
function isWithin(resolvedCmp, dir, ci) {
    const dirCmp = ci ? dir.toLowerCase() : dir;
    const base = dirCmp.endsWith(path.sep) ? dirCmp.slice(0, -1) : dirCmp;
    return resolvedCmp === dirCmp
        || resolvedCmp === base
        || resolvedCmp.startsWith(base + path.sep);
}

/**
 * Resolve symlinks as far down the path as actually exists, then re-append
 * the not-yet-existing tail.
 *
 * path.resolve() collapses '..' but does NOT follow symlinks, so a symlink
 * or Windows junction sitting inside an allowed project dir used to pass the
 * prefix check while fs happily followed it out to anywhere. realpathSync
 * alone can't be used either — it throws ENOENT for a file being created.
 */
function realpathDeepest(p) {
    let current = path.resolve(p);
    const tail = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...tail.reverse());
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(p); // hit the filesystem root
            tail.push(path.basename(current));
            current = parent;
        }
    }
}

/**
 * Throw unless targetPath resolves inside a configured project directory.
 * Returns the canonical resolved path.
 *
 * Fails CLOSED on an empty config. The old behaviour returned early when no
 * dirs were set, which silently granted whole-disk access to any manual or
 * misconfigured install.
 */
function assertAllowed(targetPath) {
    if (allowedDirs.length === 0) {
        throw new Error(
            'No project directories are configured, so every path is out of bounds. ' +
            'Set "Project Folders" on the extension config screen (Claude Desktop → ' +
            'Settings → Extensions → KARP Inspector), or set ALLOWED_DIRS in a ' +
            'manual claude_desktop_config.json entry.'
        );
    }

    const resolved = realpathDeepest(normalizePath(targetPath));
    // Case-insensitive on Windows/macOS (case-insensitive filesystems)
    const ci = process.platform !== 'linux';
    const resolvedCmp = ci ? resolved.toLowerCase() : resolved;

    // Checked BEFORE the allowlist: being inside an allowed dir must never
    // grant access to the server's own storage.
    const hit = protectedDirs.find(dir => isWithin(resolvedCmp, dir, ci));
    if (hit) {
        throw new Error(
            `Access denied: ${targetPath} is inside KARP Inspector's own data directory ` +
            `(${hit}). The knowledge graph, its automatic snapshots and the trash live ` +
            `there and are never reachable through the filesystem tools — use kg_status, ` +
            `graph_snapshot and karp_undo instead.`
        );
    }

    const inside = allowedDirs.some(dir => isWithin(resolvedCmp, dir, ci));

    if (!inside) {
        throw new Error(
            `Access denied: ${targetPath} is outside the allowed project directories.\n` +
            `Allowed: ${allowedDirs.join(', ')}`
        );
    }
    return resolved;
}

module.exports = {
    log, formatSize, guessMime, matchGlob, computeHash, normalizePath,
    loadGitignore, isIgnored, generateId,
    configureBoundary, getAllowedDirs, assertAllowed, realpathDeepest,
    cleanDirEntry, normaliseAllowedDirs, configureProtected, isWithin,
};
