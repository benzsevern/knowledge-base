# Architecture

## Components

- **CLI** (`src/cli.js`) — local commands for ingest/embed/search
- **API server** (`src/server.js`) — Express HTTP endpoints, async job runner
- **MCP server** (`mcp/server.js`) — stdio JSON-RPC bridge to API (for Claude Desktop/Code)
- **Services** (`src/*.js`) — ingester, embeddings, indexer, briefings, linker

## Entity types
Three kinds of entries live in `kb_index.json`:
- **Papers** — PDFs extracted via pymupdf + LLM vision fallback (gpt-5.4-nano). Stored under `vault/papers/<slug>/`
- **Repos** — GitHub repos cloned and packed via repomix. Stored under `vault/repos/<slug>/`
- **Docs** — Documentation sites crawled via Firecrawl. Stored under `vault/docs/<slug>/pages/`

All three have summary embeddings. Repos additionally support deep content embeddings (per-repo `embeddings.json`).

## Data flow (ingest)

1. Source (URL / local path / org/repo shorthand) → downloader
2. Extract content (pymupdf → LLM vision for papers, repomix for repos, Firecrawl for docs)
3. Chunk + summarize via LLM
4. Upsert to index (`src/indexer.js`)
5. `rebuildLinks()` computes token-overlap + language-based relations (O(n²))
6. `buildEmbeddingIndex()` creates/refreshes summary embeddings
7. `buildContentIndex()` creates per-repo deep embeddings (opt-in, not done by default)

## Job system

All long-running operations run as async jobs in-memory:
- `POST /api/ingest-*`, `/api/embed*`, `/api/topic-brief`, etc. — return `{ jobId, status }` immediately
- `GET /api/jobs/{id}` — poll status (`running` | `completed` | `failed`), `result`, `error`, `progress`
- `GET /api/jobs` — list all
- **Jobs are in-memory only** — redeploy wipes them (see operations.md)

## Search modes

- **Summary search** — fast, covers all entities. Default.
- **Scoped deep search** — `{ scope: ["repo-<slug>"] }` loads that repo's content embeddings. Fast.
- **Global deep search** — `{ deep: true }` without scope loads ALL repo content (~700K vectors). **Times out.** Avoid.
