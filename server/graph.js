// ============================================================================
// KARP Inspector — Knowledge Graph Module
// Author: SoulDriver (Adelaide, Australia)
// Ported from KARP Graph Lite with unified SQLite storage.
// ============================================================================

const { log, generateId, formatSize } = require('./utils');
const { getDb, getDbPath, cosineSimilarity, embeddingToBlob, blobToEmbedding } = require('./database');
const fs = require('fs');
const path = require('path');

// Embedding model (lazy-loaded, shared with inspector)
let embedder = null;

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const BUNDLED_MODEL_DIR = path.join(__dirname, '..', 'models');

// Quantized, deliberately — and this is a correction, not a downgrade.
//
// Inspector originally requested quantized: false on the basis that the
// quantized build had been "rejected for insufficient quality during Lite
// development". That turned out to be false: Karp_Inspector_Lite's
// indexer.js calls createPipeline() with no options at all, and
// transformers.js defaults quantized to true — so Lite has been running
// quantized the whole time, including in daily production use.
//
// Full precision cost 3-4x the embedding time for a quality advantage that
// was never actually measured. On a 117-file project that pushed a first
// index past Claude Desktop's 4-minute tool timeout, which combined with a
// non-atomic write to leave the index permanently poisoned. Matching Lite
// removes the timeout pressure and puts us on the build that is already
// proven in use.
//
// NOTE: quantized and full-precision vectors are NOT comparable. Any index
// built before this change must be rebuilt (index_project with force: true).
//
// API note: transformers.js v3 (@huggingface/transformers) replaced the v2
// boolean `quantized: true` with `dtype`, which names the precision directly.
// 'q8' is the 8-bit quantized build — the same model_quantized.onnx file v2's
// `quantized: true` resolved to, so the bundled model layout is unchanged.
const MODEL_DTYPE = 'q8';

async function getEmbedder() {
    if (embedder) return embedder;

    const { pipeline } = await import('@huggingface/transformers');

    // Check for bundled model first (no network needed)
    // Filter dotfiles (.DS_Store etc) when checking for bundled model
    const hasBundled = fs.existsSync(BUNDLED_MODEL_DIR) &&
        fs.readdirSync(BUNDLED_MODEL_DIR).filter(f => !f.startsWith('.')).length > 0;

    if (hasBundled) {
        log('INFO', 'Loading bundled embedding model (bge-small-en-v1.5, quantized)...');
        embedder = await pipeline('feature-extraction', MODEL_ID, {
            cache_dir: BUNDLED_MODEL_DIR,
            local_files_only: true,
            dtype: MODEL_DTYPE,
        });
    } else {
        log('INFO', 'Downloading embedding model (bge-small-en-v1.5, ~33MB quantized, one-time)...');
        const cacheDir = process.env.DATA_PATH
            ? path.join(process.env.DATA_PATH, 'models')
            : BUNDLED_MODEL_DIR;
        embedder = await pipeline('feature-extraction', MODEL_ID, {
            cache_dir: cacheDir,
            dtype: MODEL_DTYPE,
        });
    }

    log('INFO', 'Embedding model loaded');
    return embedder;
}

async function generateEmbedding(text) {
    const model = await getEmbedder();
    const output = await model(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

async function generateEmbeddings(texts) {
    if (!texts || texts.length === 0) return [];
    const model = await getEmbedder();
    const results = [];
    const started = Date.now();
    let expectedDims = 0;

    // One text per model call, deliberately.
    //
    // A batched version (passing arrays of 16) was tried on 23 Jul 2026 and
    // reverted. It gave ~9 chunks/sec against ~8 — inside the noise — because
    // CPU inference is compute-bound: a batch of 16 is 16x the matrix
    // multiplies, and batching only wins where there is idle parallel hardware
    // to fill. It also converted a steady CPU load into sharp spikes, which is
    // worse for a desktop app, and it required tensor-slicing code that has to
    // be exactly right or every vector in the index is silently meaningless.
    // Not worth the risk for no measurable gain.
    for (let i = 0; i < texts.length; i++) {
        const output = await model(texts[i], { pooling: 'mean', normalize: true });
        const vec = Array.from(output.data);

        // Every vector must be the same width or cosine similarity compares
        // garbage. Fail loudly rather than write a poisoned index.
        if (!expectedDims) expectedDims = vec.length;
        if (vec.length === 0 || vec.length !== expectedDims) {
            throw new Error(
                `Embedding dimension mismatch at chunk ${i}: got ${vec.length}, expected ${expectedDims}. ` +
                'Refusing to write this index.'
            );
        }
        results.push(vec);

        const done = i + 1;
        if (done % 16 === 0 && done < texts.length) {
            const rate = done / Math.max((Date.now() - started) / 1000, 0.001);
            log('INFO', `Embedded ${done}/${texts.length} chunks (${rate.toFixed(1)}/s)...`);
        }
    }

    if (results.length !== texts.length) {
        throw new Error(`Embedding count mismatch: expected ${texts.length}, produced ${results.length}.`);
    }
    return results;
}

// ── Tool definitions ───────────────────────────────────────────

const TOOLS = [
    {
        name: 'remember',
        description: 'Store a memory, note, decision, todo, insight, dev_session, changelog, or any custom type in the knowledge graph. Returns the created node with its ID.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'Brief summary (required)' },
                type: { type: 'string', description: 'Node type: memory, todo, decision, insight, dev_session, changelog, or any custom type' },
                detail: { type: 'string', description: 'Detailed content' },
                context: { type: 'string', description: 'Context or category' },
                importance: { type: 'number', description: 'Importance 0-1 (default 0.5)' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorisation' },
                metadata: { type: 'object', description: 'Additional structured fields' },
                connect_to: { type: 'string', description: 'ID of existing node to connect to' },
                relationship: { type: 'string', description: 'Relationship name if connect_to is set' },
            },
            required: ['summary', 'type'],
        },
    },
    {
        name: 'recall',
        description: 'Semantic search across the knowledge graph. Finds nodes by meaning, not just keywords.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural language search query' },
                limit: { type: 'integer', description: 'Max results (default 10)' },
                type: { type: 'string', description: 'Filter by node type' },
            },
            required: ['query'],
        },
    },
    {
        name: 'forget',
        description: 'Delete a node from the knowledge graph by ID. Permanent.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Node ID to delete' },
            },
            required: ['id'],
        },
    },
    {
        name: 'connect',
        description: 'Create a named relationship between two nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                source_id: { type: 'string', description: 'Source node ID' },
                target_id: { type: 'string', description: 'Target node ID' },
                relation: { type: 'string', description: 'Relationship name (e.g. led_to, part_of, related_to)' },
            },
            required: ['source_id', 'target_id', 'relation'],
        },
    },
    {
        name: 'graph_search',
        description: 'Keyword/exact match search across node summaries and details.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Keyword search query' },
                limit: { type: 'integer', description: 'Max results (default 20)' },
                type: { type: 'string', description: 'Filter by type' },
            },
            required: ['query'],
        },
    },
    {
        name: 'graph_list',
        description: 'Browse nodes by type, tags, or date.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Filter by node type' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
                sort: { type: 'string', enum: ['created', 'updated', 'importance'], description: 'Sort field' },
                order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' },
                limit: { type: 'integer', description: 'Max results (default 20)' },
                offset: { type: 'integer', description: 'Skip first N results' },
            },
        },
    },
    {
        name: 'propose_node_type',
        description: 'Propose a new custom node type for the knowledge graph.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Type name (lowercase, no spaces)' },
                display_name: { type: 'string', description: 'Human-readable name' },
                icon: { type: 'string', description: 'Emoji icon' },
                description: { type: 'string', description: 'What this type is for' },
            },
            required: ['name', 'display_name', 'icon', 'description'],
        },
    },
    {
        name: 'kg_status',
        description: 'Knowledge graph health: node counts by type, database size, embedding coverage, and backup status (auto + manual snapshot counts).',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'graph_snapshot',
        description: 'Create a permanent, manual backup snapshot of the knowledge graph database (in addition to the automatic snapshots the server takes on startup and every 30 minutes of activity).',
        inputSchema: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'Reason for snapshot' },
            },
        },
    },
    {
        name: 'update',
        description: 'Edit a knowledge graph node in place — summary, detail, context, type, importance, or tags. Preserves the node id, created_at and every edge attached to it, and re-embeds only if the text actually changed. Use this instead of forget + remember, which discards the id and silently deletes the node\u2019s relationships.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Node ID to update' },
                summary: { type: 'string', description: 'New summary' },
                detail: { type: 'string', description: 'New detailed content' },
                context: { type: 'string', description: 'New context or category' },
                type: { type: 'string', description: 'New node type' },
                importance: { type: 'number', description: 'New importance 0-1' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list' },
            },
            required: ['id'],
        },
    },
    {
        name: 're_embed',
        description: 'Rebuild all vector embeddings for knowledge graph nodes.',
        inputSchema: { type: 'object', properties: {} },
    },
];

// ── Tool handlers ──────────────────────────────────────────────

async function handleTool(name, args) {
    const db = getDb();

    switch (name) {
        case 'remember': {
            const id = generateId();
            const now = Date.now() / 1000;
            const embText = `${args.summary}\n${args.detail || ''}`;
            const embedding = await generateEmbedding(embText);

            db.prepare(
                `INSERT INTO nodes (id, type, summary, detail, context, importance, tags, metadata, embedding, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                id,
                args.type || 'memory',
                args.summary,
                args.detail || null,
                args.context || null,
                args.importance ?? 0.5,
                JSON.stringify(args.tags || []),
                JSON.stringify(args.metadata || {}),
                embeddingToBlob(embedding),
                now, now
            );

            // Auto-connect if requested
            if (args.connect_to) {
                const target = db.prepare('SELECT id FROM nodes WHERE id = ?').get(args.connect_to);
                if (target) {
                    db.prepare(
                        `INSERT OR IGNORE INTO edges (source_id, target_id, relation, created_at)
                         VALUES (?, ?, ?, ?)`
                    ).run(id, args.connect_to, args.relationship || 'related_to', now);
                }
            }

            return {
                id, type: args.type, summary: args.summary,
                message: `Stored ${args.type} node: ${id}`,
                powered_by: 'KARP Inspector by SoulDriver — souldriver.com.au'
            };
        }

        case 'recall': {
            const queryEmbedding = await generateEmbedding(args.query);
            let rows = db.prepare(
                args.type
                    ? 'SELECT * FROM nodes WHERE type = ? AND embedding IS NOT NULL'
                    : 'SELECT * FROM nodes WHERE embedding IS NOT NULL'
            );
            rows = args.type ? rows.all(args.type) : rows.all();

            const scored = rows.map(row => ({
                ...row,
                tags: JSON.parse(row.tags || '[]'),
                metadata: JSON.parse(row.metadata || '{}'),
                connections: getConnections(db, row.id),
                similarity: cosineSimilarity(
                    new Float32Array(queryEmbedding),
                    blobToEmbedding(row.embedding)
                ),
            }));

            scored.sort((a, b) => b.similarity - a.similarity);
            const results = scored.slice(0, args.limit || 10).map(r => {
                const { embedding, ...rest } = r;
                return rest;
            });

            return { results, query: args.query, total_embeddings: rows.length };
        }

        case 'forget': {
            const node = db.prepare('SELECT id, summary FROM nodes WHERE id = ?').get(args.id);
            if (!node) return { error: `Node not found: ${args.id}` };

            db.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?').run(args.id, args.id);
            db.prepare('DELETE FROM nodes WHERE id = ?').run(args.id);
            return { deleted: args.id, summary: node.summary };
        }

        case 'connect': {
            const src = db.prepare('SELECT id FROM nodes WHERE id = ?').get(args.source_id);
            const tgt = db.prepare('SELECT id FROM nodes WHERE id = ?').get(args.target_id);
            if (!src) return { error: `Source not found: ${args.source_id}` };
            if (!tgt) return { error: `Target not found: ${args.target_id}` };

            db.prepare(
                `INSERT OR IGNORE INTO edges (source_id, target_id, relation, created_at)
                 VALUES (?, ?, ?, ?)`
            ).run(args.source_id, args.target_id, args.relation, Date.now() / 1000);

            return { connected: `${args.source_id} —${args.relation}→ ${args.target_id}` };
        }

        case 'graph_search': {
            const pattern = `%${args.query}%`;
            let sql = 'SELECT * FROM nodes WHERE (summary LIKE ? OR detail LIKE ?)';
            const params = [pattern, pattern];
            if (args.type) { sql += ' AND type = ?'; params.push(args.type); }
            sql += ` ORDER BY updated_at DESC LIMIT ?`;
            params.push(args.limit || 20);

            const rows = db.prepare(sql).all(...params);
            return {
                results: rows.map(r => ({
                    ...r,
                    tags: JSON.parse(r.tags || '[]'),
                    metadata: JSON.parse(r.metadata || '{}'),
                    embedding: undefined,
                })),
                total: rows.length,
            };
        }

        case 'graph_list': {
            let sql = 'SELECT * FROM nodes WHERE 1=1';
            const params = [];
            if (args.type) { sql += ' AND type = ?'; params.push(args.type); }
            if (args.tags?.length) {
                for (const tag of args.tags) {
                    sql += ' AND tags LIKE ?';
                    params.push(`%"${tag}"%`);
                }
            }
            const sortField = args.sort || 'created';
            const sortCol = sortField === 'importance' ? 'importance' : sortField === 'updated' ? 'updated_at' : 'created_at';
            sql += ` ORDER BY ${sortCol} ${args.order === 'asc' ? 'ASC' : 'DESC'}`;
            sql += ` LIMIT ? OFFSET ?`;
            params.push(args.limit || 20, args.offset || 0);

            const rows = db.prepare(sql).all(...params);
            return {
                results: rows.map(r => ({
                    id: r.id, type: r.type, summary: r.summary,
                    context: r.context, importance: r.importance,
                    tags: JSON.parse(r.tags || '[]'),
                    created_at: r.created_at, updated_at: r.updated_at,
                })),
                total: rows.length,
            };
        }

        case 'propose_node_type': {
            const existing = db.prepare('SELECT name FROM type_definitions WHERE name = ?').get(args.name);
            if (existing) return { error: `Type already exists: ${args.name}` };

            db.prepare(
                `INSERT INTO type_definitions (name, display_name, icon, description, is_base, created_at)
                 VALUES (?, ?, ?, ?, 0, ?)`
            ).run(args.name, args.display_name, args.icon, args.description, Date.now() / 1000);

            return { created: args.name, display_name: args.display_name, icon: args.icon };
        }

        case 'kg_status': {
            const totalNodes = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
            const totalEdges = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
            const totalChunks = db.prepare('SELECT COUNT(*) as c FROM chunks').get().c;
            const withEmb = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE embedding IS NOT NULL').get().c;
            const byType = db.prepare('SELECT type, COUNT(*) as count FROM nodes GROUP BY type ORDER BY count DESC').all();
            const types = db.prepare('SELECT name, display_name, icon, is_base FROM type_definitions ORDER BY name').all();

            let dbSize = 0;
            try { dbSize = fs.statSync(getDbPath()).size; } catch {}

            let autoSnapshotCount = 0, manualSnapshotCount = 0, lastAutoSnapshot = null;
            try {
                const snapshotDir = path.join(path.dirname(getDbPath()), 'snapshots');
                if (fs.existsSync(snapshotDir)) {
                    const files = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.db'));
                    const autoFiles = files.filter(f => f.startsWith('auto-'));
                    autoSnapshotCount = autoFiles.length;
                    manualSnapshotCount = files.length - autoFiles.length;
                    if (autoFiles.length > 0) {
                        const mtimes = autoFiles.map(f => fs.statSync(path.join(snapshotDir, f)).mtime.toISOString());
                        lastAutoSnapshot = mtimes.sort().at(-1);
                    }
                }
            } catch {}

            return {
                total_nodes: totalNodes,
                total_edges: totalEdges,
                total_chunks: totalChunks,
                total_embeddings: withEmb,
                embedding_coverage: totalNodes > 0 ? `${Math.round(withEmb / totalNodes * 100)}%` : 'N/A',
                nodes_by_type: byType,
                db_size: formatSize(dbSize),
                db_path: getDbPath(),
                backup: {
                    auto_snapshots: autoSnapshotCount,
                    manual_snapshots: manualSnapshotCount,
                    last_auto_snapshot: lastAutoSnapshot,
                },
                available_types: types,
                powered_by: 'KARP Inspector by SoulDriver — souldriver.com.au',
            };
        }

        case 'graph_snapshot': {
            const dbFile = getDbPath();
            const snapshotDir = path.join(path.dirname(dbFile), 'snapshots');
            fs.mkdirSync(snapshotDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const snapshotPath = path.join(snapshotDir, `premium-${ts}.db`);
            fs.copyFileSync(dbFile, snapshotPath);
            const count = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.db')).length;
            return {
                snapshot: snapshotPath,
                reason: args.reason || 'manual',
                total_snapshots: count,
                size: formatSize(fs.statSync(snapshotPath).size),
                note: 'This is a permanent manual snapshot — auto-snapshots (prefixed "auto-") rotate automatically, this one never will.',
            };
        }

        case 'update': {
            const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(args.id);
            if (!node) return { error: `Node not found: ${args.id}` };

            const summary = args.summary ?? node.summary;
            const detail = args.detail ?? node.detail;
            const textChanged = summary !== node.summary || detail !== node.detail;

            // Only pay for an embedding when the embedded text actually moved.
            let embeddingBlob = node.embedding;
            if (textChanged) {
                embeddingBlob = embeddingToBlob(await generateEmbedding(`${summary}\n${detail || ''}`));
            }

            db.prepare(
                `UPDATE nodes SET type = ?, summary = ?, detail = ?, context = ?, importance = ?, tags = ?, embedding = ?, updated_at = ?
                 WHERE id = ?`
            ).run(
                args.type ?? node.type,
                summary,
                detail,
                args.context ?? node.context,
                args.importance ?? node.importance,
                args.tags ? JSON.stringify(args.tags) : node.tags,
                embeddingBlob,
                Date.now() / 1000,
                args.id
            );

            return {
                updated: args.id,
                summary,
                re_embedded: textChanged,
                edges_preserved: getConnections(db, args.id),
            };
        }

        case 're_embed': {
            const rows = db.prepare('SELECT id, summary, detail FROM nodes').all();
            if (rows.length === 0) return { message: 'No nodes to embed' };

            log('INFO', `Re-embedding ${rows.length} nodes...`);
            const texts = rows.map(r => `${r.summary}\n${r.detail || ''}`);
            const embeddings = await generateEmbeddings(texts);

            const update = db.prepare('UPDATE nodes SET embedding = ?, updated_at = ? WHERE id = ?');
            const now = Date.now() / 1000;
            const tx = db.transaction(() => {
                for (let i = 0; i < rows.length; i++) {
                    update.run(embeddingToBlob(embeddings[i]), now, rows[i].id);
                }
            });
            tx();

            return { re_embedded: rows.length, message: `Rebuilt embeddings for ${rows.length} nodes` };
        }

        default:
            throw new Error(`Unknown graph tool: ${name}`);
    }
}

// ── Helpers ────────────────────────────────────────────────────

function getConnections(db, nodeId) {
    const outgoing = db.prepare(
        `SELECT e.relation, e.target_id, n.summary, n.type 
         FROM edges e JOIN nodes n ON e.target_id = n.id 
         WHERE e.source_id = ?`
    ).all(nodeId);
    const incoming = db.prepare(
        `SELECT e.relation, e.source_id, n.summary, n.type 
         FROM edges e JOIN nodes n ON e.source_id = n.id 
         WHERE e.target_id = ?`
    ).all(nodeId);
    return { outgoing, incoming };
}

// MODEL_ID and MODEL_DTYPE are exported so export_index can stamp the exact
// precision an index was built with. Vectors from q8 and fp32 are not
// comparable, and an index that records only the model name imports cleanly
// into a server running the other precision and returns plausible nonsense —
// no error, just quietly wrong rankings.
module.exports = { TOOLS, handleTool, generateEmbedding, generateEmbeddings, getEmbedder, MODEL_ID, MODEL_DTYPE };
