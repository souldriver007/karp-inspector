# KARP Inspector

### The Complete Development Intelligence Server for Claude Desktop

[![Smoke Test](https://github.com/souldriver007/karp-inspector/actions/workflows/smoke-test.yml/badge.svg)](https://github.com/souldriver007/karp-inspector/actions/workflows/smoke-test.yml)

**Version:** 0.5.0  
**Author:** [SoulDriver](https://souldriver.com.au) (Adelaide, Australia)  
**Licence:** MIT — free and open source, every tool included  

> Formerly **KARP Inspector Premium**. Up to v0.4.0 it was a paid extension with a licence key. From v0.5.0 all 52 tools are free for everyone.

---

## What Is This?

KARP Inspector is a single MCP server that gives Claude everything it needs to understand, navigate, modify, and reason about your codebase — plus a persistent knowledge graph that remembers decisions, tracks changes, and connects code to context.

**52 tools. One server. One database. Zero external services.**

> Everything runs locally. Your code never leaves your machine.

---

## Inspector vs Inspector Lite

Inspector Lite is the lightweight, search-only sibling. Inspector is the full toolkit.

| Capability | Inspector Lite | Inspector |
|---|---|---|
| Semantic code search | ✅ | ✅ |
| Grep / file outline / diff | ✅ | ✅ |
| Read files | ❌ | ✅ |
| Write / patch files | ❌ | ✅ (atomic, corruption-safe) |
| Move / copy / delete | ❌ | ✅ (soft delete with trash) |
| Find files (glob + filters) | ❌ | ✅ |
| Search & replace (cross-file) | ❌ | ✅ (with dry-run preview) |
| Knowledge graph | ❌ | ✅ (remember, recall, connect) |
| Custom node types | ❌ | ✅ (propose any schema) |
| Semantic graph search | ❌ | ✅ (ONNX embeddings) |
| Repo map (compressed overview) | ❌ | ✅ |
| Dependency graph | ❌ | ✅ (with circular dep detection) |
| Impact analysis | ❌ | ✅ (blast radius + symbol tracking) |
| Dead code detection | ❌ | ✅ |
| TODO / FIXME scanner | ❌ | ✅ |
| Security audit | ❌ | ✅ (secrets, keys, high-entropy) |
| Git checkpoint | ❌ | ✅ (or SQLite fallback) |
| Undo / rollback | ❌ | ✅ (snapshot-based revert) |
| Run terminal commands | ❌ | ✅ (pre-approved patterns only) |
| Disk usage analysis | ❌ | ✅ |
| File checksums | ❌ | ✅ (SHA256) |
| Unified database | ❌ | ✅ (single SQLite file) |
| Version history | File snapshots | SQLite snapshots (searchable) |
| Index observability | ❌ | ✅ (list, status, forget, export/import) |
| Server diagnostics | ❌ | ✅ (`server_status`) |
| **Total tools** | **9** | **52** |

---

## Installation

### Extension Install (Recommended)

1. Download `karp-inspector.mcpb` from the [latest release](https://github.com/souldriver007/karp-inspector/releases/latest).
2. In Claude Desktop, open **Settings** (on Windows: **File → Settings**), click **Desktop app** in the left panel, scroll to the bottom and choose **Extensions → Manage → Advanced settings → Install extension**, then select the downloaded file.
3. Choose a **Data Folder** (where the database lives) and one or more **Project Folders** (the code Claude can read and edit).
4. Click **Enable**, then **Configure**, and choose **Allow all** on the permissions screen.

Then ask Claude to run `server_status`: it should report version 0.5.0 and 52 tools.

The server runs directly via stdio (no proxy, no background process) — same pattern as every other KARP MCP server.

### Upgrading from Inspector Premium

The new extension installs under a different name, so it sits alongside the old one. Disable or remove **KARP Inspector Premium** first so the two never write to the same database at once, then install **KARP Inspector** and choose the **same Data Folder** you used before. Your knowledge graph, code index and snapshots carry straight over: the database file names (`premium.db`, `premium-*.db`) are unchanged for exactly this reason. There are no licence fields any more, so there's nothing to enter.

### Manual Config (Development)

1. `git clone https://github.com/souldriver007/karp-inspector.git`
2. Inside the folder, run `npm install`, then `npm run download-model` (the embedding model isn't committed to git; about 33MB)
3. Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "karp-inspector": {
      "command": "node",
      "args": ["C:\\path\\to\\karp-inspector\\server\\index.js"],
      "env": {
        "ALLOWED_DIRS": "C:\\Users\\You\\Projects;D:\\Code",
        "DATA_PATH": "C:\\path\\to\\your\\chosen\\data\\folder",
        "ALLOWED_COMMANDS": "node --check"
      }
    }
  }
}
```

> `ALLOWED_COMMANDS` above is the safe default. Adding `npm test`, `npm run build` or `pytest` lets the project you point at execute its own code — only do that for repositories you trust.

4. Restart Claude Desktop
5. Say: *"Set project to C:\path\to\my\project and index it"*

### Build the extension yourself

```bash
npm install
npm run download-model
npm run build
```

The extension is written to `dist/karp-inspector.mcpb`.

> **Linux (x64):** run installs as `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install` (or `npm ci`). Otherwise onnxruntime-node's install script tries to download optional GPU binaries, and that download currently fails. Inspector only needs the CPU binaries, which are already in the package.

---

## Testing

```bash
npm run smoke
```

Spawns the server and drives it over stdio with a real JSON-RPC client — no
Claude Desktop, no GUI, no SDK dependency. 32 assertions, a few
seconds.

Every assertion corresponds to something that actually broke during
development, so this is a regression net rather than a formality:

| Assertion | The bug it guards against |
|---|---|
| `set_project` outside the boundary is denied | The directory sandbox once covered only one module in four, making `grep_code` an arbitrary-file reader |
| Two roots sharing a `README.md` both index | Chunk ids were `filepath:line`, so any two projects sharing a relative path collided on the primary key |
| A one-line `const a = () => {}, b = () => {}` indexes | Two chunks with the same start line produced duplicate ids |
| `index_project` returns chunks > 0 | File hashes committed before chunks; an interrupted run left the index claiming N files with zero chunks, unrecoverable |
| `search_code` ranks the right file first | Proves the vectors are meaningful, not merely present |
| Hybrid finds a file semantic search misses | `count-lines.js` contains `totalLines`; semantic search returned `countFiles` and `countRows` instead |
| Export records `embedding_dtype` | An index recording only the model name imports cleanly into a server on the other precision and returns plausible nonsense |
| Deleting a file yields `pruned: 1` | Deleted files' chunks previously survived forever |
| Ambiguous relative path errors | `resolveInRoots` used to return the first match and call it an answer |
| `security_audit`, `git_checkpoint`, `run_check` and export → import all run | Before v0.5.0 these were licence-gated, so CI only reached them when licence secrets were set, and `import_index` shipped broken because nothing exercised it |

The fixture is created under the OS temp directory, which on macOS is a
symlink into `/private/var/...` — so the run also exercises the `realpath`
handling in `assertAllowed`.

CI runs the same suite on **macOS, Windows and Linux** on every push, covering
every tool, including `run_check`'s non-Windows `which` branch. See
`.github/workflows/smoke-test.yml`.

---

## How search works

`search_code` runs two rankers over the same chunks and fuses the results.

**Semantic** compares the query's embedding against each chunk's. Good at
concepts — "validate a token before the request runs" finds the middleware even
though it never uses those words.

**Literal** scores term frequency over each chunk's text and name, with
identifiers split on camelCase and snake_case so `totalLines` matches "total
lines". Good at the thing semantic search is worst at: you half-remember an
identifier, a config key, or an error string.

**Fusion** uses Reciprocal Rank Fusion — `Σ 1/(60 + rank)` across both lists.
RRF works on ranks rather than raw scores, which matters because cosine
similarity and term frequency aren't on comparable scales. Every result reports
`semantic_score`, `lexical_score` and the fused `rrf` value, so a ranking can be
explained rather than taken on trust.

Why both: on a real codebase, a query for "count the number of lines of code"
returned `countFiles`, `countRows` and `getRecordCounts` from semantic search
alone — and missed a file named `count-lines.js` containing `totalLines`. Literal
matching finds it instantly. Neither ranker is sufficient by itself.

Pass `mode: "semantic"` or `mode: "literal"` to force one.

**A note on queries.** Search quality depends more on vocabulary than on any
setting. Search the way the code is *written*, not the way you'd describe it to a
colleague — `"service worker cache"` rather than `"works offline"`. The embedding
model matches vocabulary in context; it does not reliably infer that
`caches.match()` means offline support.

---

## Indexed file types

Text and source files up to 1MB:

```
.py .js .jsx .ts .tsx .html .css .md .txt
.sql .sh .ps1 .bat
.go .rs .java .cs .rb .php .vue .svelte .kt .swift
.c .h .cpp .hpp .scala .ex .exs
```

Config and data formats (`.json`, `.yaml`, `.toml`, `.ini`) are deliberately
not indexed: generated files like `package-lock.json` crowd out real code in
search results. `grep_code` reads straight from disk, so literal lookups in
those files still work.

Three of these get structural parsing rather than fixed-size windows:

- **Python** — functions and classes become individual chunks
- **JavaScript / TypeScript** — parsed with `acorn`
- **HTML** — inline `<script>` is parsed as JavaScript with correct absolute
  line numbers, inline `<style>` is skipped, and remaining markup is chunked as
  prose only when it reads like prose rather than a navigation menu

Everything else is chunked into overlapping windows, which works acceptably for
uniform content.

`.gitignore` is respected, along with a default skip list (`node_modules`,
`.git`, `dist`, `build`, `__pycache__` and similar). If a root contains nothing
indexable, `index_project` says so and lists what it looks for, rather than
reporting a successful index of nothing.

---

## Configuration Reference

| Environment Variable | Required | Description | Example |
|---|---|---|---|
| `ALLOWED_DIRS` | **Required** (manual config) | Semicolon-separated list of directories the server may access. **There is no unrestricted mode** — if this is empty and no `project_dirs` are passed, every filesystem, search and analysis tool refuses to run. The `.mcpb` extension config uses `project_dirs` (a folder picker, see below) instead of this env var — both feed the same boundary. | `C:\Users\Me\Desktop;D:\Projects` |
| `DATA_PATH` | Required via `.mcpb` config screen (Data Folder); optional in manual config | Where the unified SQLite database is stored, including automatic snapshots (`DATA_PATH/snapshots/`). Manual-config default is `~/.karp-premium` (the name dates from the Premium release and is kept so existing data still loads). | `C:\path\to\data` |
| `ALLOWED_COMMANDS` | Optional | Semicolon-separated command prefixes for `run_check`. Defaults to `node --check` only. Leave empty to disable terminal execution entirely. **Adding test or build runners lets a project execute its own code** — `npm test`/`npm run build` run scripts from that project's `package.json`, and `pytest` runs its `conftest.py`. Only add them for repositories you trust. | `node --check;npm test;pytest` |
| `TRASH_DIR` | Optional | Where soft-deleted files go. Defaults to `DATA_PATH/trash`. | `C:\path\to\trash` |

### MCPB Extension Config (as actually shipped)

Users configure these two fields via Claude Desktop's built-in settings UI when installing the `.mcpb`. `data_path` is a single folder picker; `project_dirs` is a multi-select folder picker (`"multiple": true`) — click it again to add more folders, and it expands to as many directories as you pick:

```json
{
  "user_config": {
    "data_path": {
      "type": "directory",
      "title": "Data Folder",
      "description": "Choose where to store your knowledge graph and code index. Pick any folder — your data stays on your machine and survives extension updates.",
      "required": true
    },
    "project_dirs": {
      "type": "directory",
      "title": "Project Folders",
      "description": "Choose one or more top-level folders Claude can read, write, and search within (subfolders included). This is the file boundary for all filesystem tools — Claude can't touch anything outside these. Click again to add more.",
      "multiple": true,
      "required": true
    }
  }
}
```

Under the hood, multi-select directory fields expand into separate command-line arguments (per the MCPB spec — arrays aren't passed through `env` as a single string), so `project_dirs` is wired into `args` rather than `env`. `server/index.js` reads both `process.argv` (for the `.mcpb` path) and the `ALLOWED_DIRS` env var (for manual config), merges and dedupes them.

---

## All 52 Tools

### Filesystem (20 tools)

| Tool | Description |
|---|---|
| `list_allowed_directories` | Show which directories the server can access |
| `read_file` | Read a text file with optional head/tail line limits |
| `read_files` | Read multiple files in a single call |
| `write_file` | Atomic write (temp file + rename) with parent dir creation |
| `patch_file` | Edit a file by replacing one exact text match |
| `list_directory` | List files and dirs with type, size, modification date |
| `directory_tree` | Recursive tree view respecting .gitignore |
| `file_info` | Detailed metadata: size, dates, permissions, MIME type |
| `move_file` | Move or rename files and directories |
| `copy_file` | Copy files or directories (recursive) |
| `create_directory` | Create directories (and parents) |
| `delete_file` | Soft delete to trash (or permanent) |
| `find_files` | Glob pattern search with date/size filters |
| `search_replace` | Cross-file find and replace with dry-run preview |
| `disk_usage` | Biggest files, directory sizes, breakdown by extension |
| `checksum` | SHA256 hash of one or more files |
| `run_check` | Execute pre-approved terminal commands (syntax check, tests, linter) |
| `list_allowed_commands` | Show which commands are approved for run_check |
| `git_checkpoint` | Safety checkpoint: git commit or SQLite snapshot fallback |
| `karp_undo` | Revert file changes using saved snapshots |

### Knowledge Graph (11 tools)

| Tool | Description |
|---|---|
| `remember` | Store a memory, decision, todo, insight, changelog, or custom type |
| `recall` | Semantic search across the knowledge graph by meaning |
| `forget` | Delete a node permanently |
| `connect` | Create a named relationship between two nodes |
| `update` | Edit a node in place — preserves its id, created_at and edges, re-embeds only if the text changed |
| `graph_search` | Keyword search across node summaries and details |
| `graph_list` | Browse nodes by type, tags, or date |
| `propose_node_type` | Create a custom node type with icon and description |
| `kg_status` | Health check: node counts, DB size, embedding coverage |
| `graph_snapshot` | Backup the entire database |
| `re_embed` | Rebuild all vector embeddings |

### Code Intelligence (14 tools)

| Tool | Description |
|---|---|
| `search_code` | Hybrid code search — fuses semantic similarity with literal term matching. `mode` accepts `hybrid` (default), `semantic`, or `literal` |
| `grep_code` | Exact string or regex search with context lines |
| `file_outline` | Structural overview: classes, functions, signatures, line numbers. Takes an absolute path or one relative to a root |
| `index_project` | Build or rebuild the semantic search index across every configured root |
| `reindex_file` | Re-index a single file after editing. Takes an absolute path or one relative to a root |
| `file_history` | List saved snapshots of a file |
| `file_diff` | Diff between snapshots or against the live file. Refuses rather than guess when the same path exists under several roots |
| `project_stats` | Index statistics: files, chunks, extensions |
| `set_project` | Set one root, or several at once for a monorepo — all search, grep and index tools then span every root |
| `list_projects` | Every indexed root with chunk/file counts, last indexed date, and whether it still exists on disk |
| `index_status` | What's new, changed or deleted since the last index — tells you whether indexing is needed at all |
| `forget_project` | Delete one root's index and reclaim the space. Dry run by default |
| `export_index` | Export a root's chunks and embeddings to a portable file |
| `import_index` | Import an exported index, optionally remapping the root path |

### Server (1 tool)

| Tool | Description |
|---|---|
| `server_status` | Version, uptime, directory boundary, allowed commands, database size, index totals, snapshot health |

### Developer Intelligence (6 tools)

| Tool | Description |
|---|---|
| `repo_map` | Compressed structural map — function signatures and class names across a directory, without implementation code. 10,000 lines → 500 tokens. |
| `dependency_graph` | Import/require mapping across the project. Finds circular dependencies. |
| `impact_analysis` | "If I change this file, what breaks?" Blast radius + symbol reference tracking. |
| `dead_code` | Find exported symbols that nothing imports |
| `todo_scan` | Extract TODO, FIXME, HACK, XXX, NOTE comments across the codebase |
| `security_audit` | Scan for API keys, tokens, private keys, high-entropy strings, hardcoded credentials |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│            KARP Inspector v0.5.0            │
│         52 tools • 1 server • 1 database    │
├─────────────────────────────────────────────┤
│                                             │
│  server/index.js ─ MCP Protocol (hand-rolled) │
│     │              runs directly via stdio  │
│     │              (Desktop's entry_point)  │
│     ├── filesystem.js   (20 tools)          │
│     ├── graph.js        (11 tools)          │
│     ├── inspector.js    (14 tools)          │
│     └── intelligence.js ( 6 tools)          │
│                                             │
│  database.js ── Unified SQLite (WAL mode)   │
│     ├── nodes          (knowledge graph)    │
│     ├── edges          (relationships)      │
│     ├── type_definitions                    │
│     ├── chunks         (code index)         │
│     ├── file_hashes    (change detection)   │
│     └── snapshots      (version history —   │
│                          auto + manual)     │
│                                             │
│  utils.js ── Shared helpers + dir boundary  │
│                                             │
├─────────────────────────────────────────────┤
│  Stack: Node.js • SQLite • ONNX • Acorn    │
│  Protocol: Hand-rolled MCP (no SDK dep)     │
│  Embeddings: bge-small-en-v1.5 (local)      │
│  External services: None                    │
└─────────────────────────────────────────────┘
```

### What makes this different

- **Unified database** — Code index, knowledge graph, and version history in one SQLite file. A file write, an index update, and a changelog entry happen in the same transaction.
- **Multi-root projects** — `set_project` takes one directory or several. A monorepo's `frontend/` and `api/`, or a project plus its shared library, are searched and indexed together instead of switching back and forth. Chunk ids are namespaced by root, so two roots holding the same `README.md` or `src/index.js` coexist cleanly.
- **The index is visible and reversible** — `index_status` says whether indexing is even needed, `list_projects` shows what's stored, and `forget_project` removes a root you indexed by mistake. Most tools in this space let you build an index and never look inside it again.
- **No SDK dependency** — Hand-rolled MCP protocol over stdio. Fewer dependencies, fewer failure modes.
- **No external services** — No Docker, no Qdrant, no PostgreSQL, no API keys. Everything runs in-process.
- **Knowledge + code in one tool** — Ask "why did we change the auth flow?" and get both the reasoning (graph) AND the code diff (inspector).

---

## Performance

| Scenario | Time |
|---|---|
| First index — 12 files, 117 chunks, model load included | ~17s |
| Re-index — 12 files, 117 chunks, model cached | ~13s |
| Incremental index — 1 changed file | **0.1s** (11 skipped via SHA256) |
| No-op index — nothing changed | 0.02s |
| Semantic search | <1s |
| Grep search | Instant |
| Repo map | Instant |
| Dependency graph (first call / cached) | Instant / cached 60s |
| Project switching (cached) | Instant |
| Git checkpoint (SQLite fallback, 19 files) | <1s |

Embedding runs at roughly **9 chunks/sec** on CPU with the full-precision
bge-small model. That is the dominant cost of a first index and it scales
linearly — 1,800 chunks is about 200 seconds. The fastest index is the one
you don't run, which is what `index_status` and the pre-flight guard on
`index_project` are for. Measured on Windows, Node 24, no GPU acceleration
(`onnxruntime-node` ships CPU-only binaries by default).

---

## Supported Languages

**Full AST parsing:** JavaScript, TypeScript, JSX, TSX (via Acorn)  
**Regex parsing:** Python (classes, functions, decorators, multi-line signatures)  
**Section-based chunking:** HTML, CSS, Markdown, plain text  
**Dependency analysis:** JavaScript/TypeScript (import/require), Python (import/from)

---

## Requirements

- **Claude Desktop** (Windows or macOS)
- **Node.js 18+** (ships with Claude Desktop)
- **Windows** — developed and tested here
- **macOS / Linux** — core functionality verified by CI on every commit; the `.mcpb` install flow in Claude Desktop has not yet been walked through by hand on a Mac
- ~33MB disk for the bundled embedding model (quantized bge-small, ships inside the extension — no download, works offline)
- No Python, Docker, API keys, or external services

---

## How Is This Different?

| Tool | Filesystem | Knowledge Graph | Code Intelligence | Terminal |
|---|---|---|---|---|
| Anthropic Filesystem Extension | ✅ | ❌ | ❌ | ❌ |
| KARP Inspector Lite | ❌ | ❌ | ✅ (9 tools) | ❌ |
| KARP Graph Lite | ❌ | ✅ (11 tools) | ❌ | ❌ |
| Cline | ✅ | ❌ | Partial | ✅ |
| Aider | ✅ | ❌ | Partial | ✅ |
| **KARP Inspector** | **✅ (20 tools)** | **✅ (11 tools)** | **✅ (20 tools)** | **✅ (pre-approved commands)** |

**Key differentiators:**
- Filesystem, knowledge graph and code intelligence in one server
- Unified SQLite database — code changes and decisions in the same store
- Terminal execution limited to the command prefixes you pre-approve
- Impact analysis with blast radius — knows what breaks before you break it
- Repo map — 10,000 lines compressed to 500 tokens
- Security audit built in — catches secrets before they ship
- Free and MIT licensed — read the code, fork it, change it

---

## Privacy Policy

KARP Inspector is fully local. **No data is collected, transmitted, or shared.**

- No telemetry, analytics, or tracking
- No network requests after initial model download
- No API keys or external services
- Your code never leaves your machine
- Database stored locally in your configured DATA_PATH

---

## Restoring from a Snapshot

If the database gets corrupted, wiped, or bloated, here's how to actually restore from a snapshot:

1. **Fully quit Claude Desktop first.** Toggling the extension off/on in Desktop's UI is **not sufficient** — the underlying `node.exe` process can stay running with the old (bad) database already loaded in memory, and any write from that stale process will silently overwrite whatever file you restore. On Windows, if Desktop doesn't close cleanly, end it via Task Manager. Confirmed this the hard way: a toggle left `kg_status` still reporting the pre-restore state; only a full close did.
2. With Desktop closed, copy the snapshot you want over the live database: `<DATA_PATH>\snapshots\auto-<timestamp>.db` (or `premium-<timestamp>.db` for a manual `graph_snapshot`) → `<DATA_PATH>\premium.db`, overwriting it.
3. Start Claude Desktop back up. `server/index.js` reads `premium.db` fresh on process start — this is the point where your restored snapshot actually takes effect.
4. Verify with `kg_status` — check `total_nodes`/`total_chunks` and `db_size` match what you expect from the snapshot you restored, not the state you were trying to get away from.

---

## Licence

MIT. See [LICENSE](LICENSE). Use it, fork it, ship it.

Up to v0.4.0 this project was sold as KARP Inspector Premium, with 25 of its 52 tools behind an offline licence key. From v0.5.0 the licence check is gone and every tool is free.

### Third-party components

| Component | Licence |
|---|---|
| [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) embedding model (BAAI), bundled in the `.mcpb` | MIT |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | Apache-2.0 |
| [acorn](https://github.com/acornjs/acorn) and acorn-walk | MIT |
| [sql.js](https://github.com/sql-js/sql.js) | MIT |

---

## Contributing

Issues and pull requests are welcome. Please run `npm run smoke` before opening a pull request; CI runs the same suite on Windows, macOS and Linux.

---

## Support

- **Bugs and questions:** [GitHub Issues](https://github.com/souldriver007/karp-inspector/issues)
- **Website:** [souldriver.com.au/karp-tools.html](https://souldriver.com.au/karp-tools.html)

---

**Built in Adelaide, Australia by [SoulDriver](https://souldriver.com.au)**  
*Part of the KARP ecosystem — Knowledge Acquisition Research Protocol*  
*Democratising access to intelligent tools.*
