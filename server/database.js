// ============================================================================
// KARP Inspector — Unified Database (sql.js — pure WASM SQLite)
// Author: SoulDriver (Adelaide, Australia)
// 
// Cross-platform: no native binaries, works identically on Windows + macOS.
// Compatibility wrapper makes sql.js look like better-sqlite3.
// Auto-saves to disk with debounce (100ms after last write).
// ============================================================================

const path = require('path');
const fs = require('fs');
const { log } = require('./utils');

let SQL = null;        // sql.js module
let db = null;         // active database instance
let dbPath = null;     // file path
let saveTimer = null;  // debounce timer
const SAVE_DELAY = 100; // ms after last write before flushing to disk

// ── Schema ─────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'memory',
    summary TEXT NOT NULL,
    detail TEXT,
    context TEXT,
    importance REAL DEFAULT 0.5,
    tags TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    embedding BLOB,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related_to',
    created_at REAL NOT NULL,
    UNIQUE(source_id, target_id, relation)
);
CREATE TABLE IF NOT EXISTS type_definitions (
    name TEXT PRIMARY KEY,
    display_name TEXT,
    icon TEXT DEFAULT '📌',
    description TEXT,
    is_base INTEGER DEFAULT 0,
    fields TEXT DEFAULT '[]',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    project_root TEXT NOT NULL,
    filepath TEXT NOT NULL,
    name TEXT,
    chunk_type TEXT DEFAULT 'file_chunk',
    line_start INTEGER,
    line_end INTEGER,
    text TEXT,
    embedding BLOB,
    file_hash TEXT
);
CREATE TABLE IF NOT EXISTS file_hashes (
    filepath TEXT NOT NULL,
    project_root TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    last_indexed REAL NOT NULL,
    PRIMARY KEY (filepath, project_root)
);
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT NOT NULL,
    project_root TEXT NOT NULL,
    diff_text TEXT,
    full_content TEXT,
    session_node_id TEXT,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_root);
CREATE INDEX IF NOT EXISTS idx_chunks_filepath ON chunks(filepath);
CREATE INDEX IF NOT EXISTS idx_snapshots_filepath ON snapshots(filepath, project_root);
`;

const BASE_TYPES = [
    { name: 'memory', display_name: 'Memory', icon: '💭', description: 'General memories and observations', is_base: 1 },
    { name: 'todo', display_name: 'Todo', icon: '✅', description: 'Tasks and action items', is_base: 1 },
    { name: 'decision', display_name: 'Decision', icon: '⚖️', description: 'Decisions made and their reasoning', is_base: 1 },
    { name: 'insight', display_name: 'Insight', icon: '💡', description: 'Discoveries and realisations', is_base: 1 },
    { name: 'dev_session', display_name: 'Dev Session', icon: '🔧', description: 'Development session summaries', is_base: 1 },
    { name: 'changelog', display_name: 'Changelog', icon: '📋', description: 'Code and system changes', is_base: 1 },
];

// ── Compatibility wrapper (makes sql.js look like better-sqlite3) ──

class PreparedStatement {
    constructor(database, sql) {
        this._db = database;
        this._sql = sql;
    }

    run(...params) {
        this._db.run(this._sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
        scheduleSave();
        return { changes: this._db.getRowsModified() };
    }

    get(...params) {
        let stmt;
        try {
            stmt = this._db.prepare(this._sql);
            const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
            if (flat.length > 0) stmt.bind(flat);
            if (stmt.step()) {
                const result = stmtToObject(stmt);
                stmt.free();
                return result;
            }
            stmt.free();
            return undefined;
        } catch (e) {
            if (stmt) try { stmt.free(); } catch {}
            throw e;
        }
    }

    all(...params) {
        let stmt;
        try {
            stmt = this._db.prepare(this._sql);
            const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
            if (flat.length > 0) stmt.bind(flat);
            const results = [];
            while (stmt.step()) {
                results.push(stmtToObject(stmt));
            }
            stmt.free();
            return results;
        } catch (e) {
            if (stmt) try { stmt.free(); } catch {}
            throw e;
        }
    }
}

function stmtToObject(stmt) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const obj = {};
    for (let i = 0; i < cols.length; i++) {
        // sql.js returns Uint8Array for BLOBs — convert to Buffer for compatibility
        if (vals[i] instanceof Uint8Array) {
            obj[cols[i]] = Buffer.from(vals[i]);
        } else {
            obj[cols[i]] = vals[i];
        }
    }
    return obj;
}

// Database wrapper with better-sqlite3 compatible API
const dbWrapper = {
    prepare(sql) {
        return new PreparedStatement(db, sql);
    },
    exec(sql) {
        db.run(sql);
        scheduleSave();
    },
    pragma(str) {
        // sql.js supports PRAGMA via exec
        try { db.run(`PRAGMA ${str}`); } catch {}
    },
    transaction(fn) {
        return (...args) => {
            db.run('BEGIN');
            try {
                const result = fn(...args);
                db.run('COMMIT');
                scheduleSave();
                return result;
            } catch (e) {
                db.run('ROLLBACK');
                throw e;
            }
        };
    },
};

// ── Persistence ────────────────────────────────────────────────

function scheduleSave() {
    dirtySinceSnapshot = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToDisk, SAVE_DELAY);
}

function saveToDisk() {
    if (!db || !dbPath) return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        // Atomic write
        const tmpPath = dbPath + '.tmp';
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, dbPath);
    } catch (e) {
        log('WARN', `Failed to save database: ${e.message}`);
    }
}

// ── Auto-snapshot ──────────────────────────────────────────────
// Protects against the exact failure mode that lost ~4 months of a
// related project's knowledge graph: an extension toggle, uninstall,
// or Desktop/OS update touching the live database with no backup to
// fall back to. Snapshots go in <DATA_PATH>/snapshots/, prefixed
// "auto-" so rotation never touches manual graph_snapshot backups
// (those are prefixed "premium-" and kept forever, user's call).

let dirtySinceSnapshot = false;
let autoSnapshotTimer = null;

const AUTO_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;       // check every 30 min while running
const AUTO_SNAPSHOT_STARTUP_MIN_GAP_MS = 60 * 60 * 1000; // skip startup snapshot if one exists within the last hour
const AUTO_SNAPSHOT_MAX_KEEP = 10;                        // rotate — keep the 10 most recent auto snapshots

function autoSnapshot(reason) {
    if (!db || !dbPath) return null;
    try {
        saveToDisk(); // make sure the on-disk file reflects the in-memory DB before copying it
        const snapshotDir = path.join(path.dirname(dbPath), 'snapshots');
        fs.mkdirSync(snapshotDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotPath = path.join(snapshotDir, `auto-${ts}.db`);
        fs.copyFileSync(dbPath, snapshotPath);
        dirtySinceSnapshot = false;

        // Rotate: only ever touches "auto-" files, never manual graph_snapshot backups
        const autoFiles = fs.readdirSync(snapshotDir)
            .filter(f => f.startsWith('auto-') && f.endsWith('.db'))
            .map(f => ({ name: f, mtime: fs.statSync(path.join(snapshotDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        for (const old of autoFiles.slice(AUTO_SNAPSHOT_MAX_KEEP)) {
            try { fs.unlinkSync(path.join(snapshotDir, old.name)); } catch {}
        }

        log('INFO', `Auto-snapshot created (${reason}): ${snapshotPath}`);
        return snapshotPath;
    } catch (e) {
        log('WARN', `Auto-snapshot failed: ${e.message}`);
        return null;
    }
}

function maybeStartupSnapshot() {
    try {
        const snapshotDir = path.join(path.dirname(dbPath), 'snapshots');
        let mostRecent = 0;
        if (fs.existsSync(snapshotDir)) {
            for (const f of fs.readdirSync(snapshotDir)) {
                if (!f.endsWith('.db')) continue;
                const mtime = fs.statSync(path.join(snapshotDir, f)).mtimeMs;
                if (mtime > mostRecent) mostRecent = mtime;
            }
        }
        if (Date.now() - mostRecent > AUTO_SNAPSHOT_STARTUP_MIN_GAP_MS) {
            autoSnapshot('startup');
        }
    } catch (e) {
        log('WARN', `Startup snapshot check failed: ${e.message}`);
    }
}

function startAutoSnapshotTimer() {
    if (autoSnapshotTimer) return;
    autoSnapshotTimer = setInterval(() => {
        if (dirtySinceSnapshot) autoSnapshot('interval');
    }, AUTO_SNAPSHOT_INTERVAL_MS);
    // Don't let this timer keep the process alive on its own
    if (autoSnapshotTimer.unref) autoSnapshotTimer.unref();
}

// Save (and snapshot) on exit — this is the moment most likely to
// coincide with an extension toggle, uninstall, or Desktop update.
process.on('exit', () => { if (db && dbPath) saveToDisk(); });
process.on('SIGINT', () => { autoSnapshot('shutdown'); process.exit(0); });
process.on('SIGTERM', () => { autoSnapshot('shutdown'); process.exit(0); });

// ── Initialisation ─────────────────────────────────────────────

async function initDatabase(dataPath) {
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs();

    dbPath = path.join(dataPath, 'premium.db');
    fs.mkdirSync(dataPath, { recursive: true });

    // Load existing DB or create new
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
        log('INFO', `Loaded existing database: ${dbPath}`);
    } else {
        db = new SQL.Database();
        log('INFO', `Created new database: ${dbPath}`);
    }

    // Create schema (IF NOT EXISTS makes this safe to run always)
    db.run(SCHEMA);

    // Seed base types
    const now = Date.now() / 1000;
    for (const t of BASE_TYPES) {
        try {
            db.run(
                `INSERT OR IGNORE INTO type_definitions (name, display_name, icon, description, is_base, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [t.name, t.display_name, t.icon, t.description, t.is_base, now]
            );
        } catch {}
    }

    saveToDisk();

    // Count existing data
    let nodeCount = 0, chunkCount = 0;
    try {
        const stmt1 = db.prepare('SELECT COUNT(*) as c FROM nodes');
        if (stmt1.step()) nodeCount = stmt1.get()[0];
        stmt1.free();
        const stmt2 = db.prepare('SELECT COUNT(*) as c FROM chunks');
        if (stmt2.step()) chunkCount = stmt2.get()[0];
        stmt2.free();
    } catch {}

    log('INFO', `Database ready: ${dbPath} (${nodeCount} nodes, ${chunkCount} chunks)`);

    // Auto-snapshot: one on startup (if it's been a while), then check
    // every 30 min for the rest of this process's life. Both are cheap —
    // a file copy plus rotation — but they're the difference between
    // "extension update wiped my graph" and "restored from this morning".
    maybeStartupSnapshot();
    startAutoSnapshotTimer();

    return dbWrapper;
}

// ── Query helpers ──────────────────────────────────────────────

function getDb() {
    if (!db) throw new Error('Database not initialised — call initDatabase first');
    return dbWrapper;
}

function getDbPath() {
    return dbPath;
}

function cosineSimilarity(a, b) {
    if (!a || !b) return 0;
    const vecA = (a instanceof Float32Array) ? a : new Float32Array(a.buffer || a);
    const vecB = (b instanceof Float32Array) ? b : new Float32Array(b.buffer || b);
    if (vecA.length === 0 || vecB.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

function embeddingToBlob(embedding) {
    if (!embedding) return null;
    const arr = Array.isArray(embedding) ? new Float32Array(embedding) : embedding;
    return Buffer.from(arr.buffer);
}

function blobToEmbedding(blob) {
    if (!blob) return null;
    if (blob instanceof Uint8Array && !(blob instanceof Buffer)) {
        blob = Buffer.from(blob);
    }
    // Copy the buffer to avoid Node's pool alignment issues with Float32Array
    const copy = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
    return new Float32Array(copy);
}

module.exports = {
    initDatabase, getDb, getDbPath,
    cosineSimilarity, embeddingToBlob, blobToEmbedding,
    autoSnapshot
};
