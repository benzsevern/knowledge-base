# Knowledge Base

Local-first RAG knowledge base: ingests papers (PDFs), GitHub repos, and doc sites; makes them searchable via semantic search, RAG chat, topic briefs, and gap analysis.

## Stack
- Node.js zero-dep CLI + Express API, deployed on Railway (`kb-api-production-d23f.up.railway.app`)
- MCP stdio server in `mcp/server.js` proxies tools to the API
- OpenAI `text-embedding-3-small` for embeddings, `gpt-5.4-nano` via Responses API for LLM tasks
- Firecrawl `/v1/crawl` for documentation ingestion
- Railway persistent volume at `/app/vault` (50GB)
- Postgres + pgvector on Railway is the primary read store; ingest dual-writes to PG and vault JSON

## Layout
- `src/` — CLI + API server + services
- `mcp/server.js` — MCP stdio bridge
- `vault/` (on Railway) — `kb_index.json`, `kb_embeddings.json`, `papers/`, `repos/`, `docs/`
- `vendor/repomix/` — git submodule, don't modify
- `.mcp.json` — **gitignored**, holds `KB_API_TOKEN`; copy from `.mcp.json.example` and fill via `railway variables --kv | grep KB_API_TOKEN`

## Current scale (Postgres)
203 papers, 1321 repos, 17 docs, 913K relations, 827K+ embeddings. Run `kb_status` for live counts.

## API auth
- `PROTECTED_PREFIXES` in `src/server.js` (token-gated): `/api/search`, `/api/chat`, `/api/embed`, `/api/ingest*`, `/api/admin*`, etc.
- Unauth'd diagnostics: `/api/ping`, `/api/status`, `/api/db-health`, `/api/entity/:id`, `/api/graph`.
- Test protected endpoints with `curl -H "Authorization: Bearer $(railway variables --kv | grep KB_API_TOKEN | cut -d= -f2)"`.

## Gotchas
- `upsertEntityPG` uses `ON CONFLICT DO UPDATE` — re-ingesting an existing entity does NOT increment counts. Use `kb_entity` / `/api/entity/:id` to confirm presence.
- `.mcp.json` env reload requires full Claude Code restart; `/mcp` reconnect alone keeps stale env.
- Embedding `kind`: `buildContentIndex` writes `kind='content'`, `buildEmbeddingIndex` writes `kind='chunk'|'summary'`. `semanticSearchPG` filters must include both `'content'` and `'deep'` spellings.

## Context files
- [context/architecture.md](context/architecture.md) — system design
- [context/operations.md](context/operations.md) — Railway + deploy quirks
- [context/embedding-pipeline.md](context/embedding-pipeline.md) — OpenAI batching rules
- [context/data-model.md](context/data-model.md) — index + embeddings schemas
- [context/mcp-integration.md](context/mcp-integration.md) — MCP tool conventions
- [context/troubleshooting.md](context/troubleshooting.md) — known bugs, recovery
- [context/conventions.md](context/conventions.md) — code style
