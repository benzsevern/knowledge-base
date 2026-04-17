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
~1,400 papers (arxiv + sitemap articles), 1,321 repos, 18 docs, ~2.3M relations, ~874K embeddings. Run `kb_status` for live counts.

## Ingest endpoints
- `/api/ingest-arxiv` — `{arxivId}` or `{url}`, downloads PDF + ingests. Single paper.
- `/api/ingest-arxiv-batch` — `{arxivIds: [...]}`, downloads all (concurrency=6), single `rebuildLinks` at end. Used for citation spidering.
- `/api/ingest-sitemap` — `{sitemapUrl, urlFilter?, maxPages?, concurrency?}`, fetches HTML per URL, converts to markdown via gpt-5.4-nano (no Firecrawl). One entity per page (type="paper", meta.kind="article").
- `/api/admin/resummarize` — `{type: "paper"|"repo", force?, concurrency?}`, LLM backfill of summary/methodology/constraints/topics (papers) or summary/purpose/architecture/usage/topics (repos). Idempotent — skips entities with populated `topics` unless `force=true`.

## LLM summarization
- `src/llm-summarize.js` — paper-shape: `{summary, methodology, constraints, topics}`
- `src/llm-repo-summarize.js` — repo-shape: `{summary, purpose, architecture, usage, topics}`, reads README + first 40KB of packed-context
- `src/sitemap-ingester.js` — Firecrawl-free per-page ingest via gpt-5.4-nano HTML→markdown conversion
- All three have 429 retry with exponential backoff (2s→30s cap)

## API auth
- `PROTECTED_PREFIXES` in `src/server.js` (token-gated): `/api/search`, `/api/chat`, `/api/embed`, `/api/ingest*`, `/api/admin*`, etc.
- Unauth'd diagnostics: `/api/ping`, `/api/status`, `/api/db-health`, `/api/entity/:id`, `/api/graph`.
- Test protected endpoints with `curl -H "Authorization: Bearer $(railway variables --kv | grep KB_API_TOKEN | cut -d= -f2)"`.

## Gotchas
- `upsertEntityPG` uses `ON CONFLICT DO UPDATE` — re-ingesting an existing entity does NOT increment counts. Use `kb_entity` / `/api/entity/:id` to confirm presence.
- `.mcp.json` env reload requires full Claude Code restart; `/mcp` reconnect alone keeps stale env.
- Embedding `kind`: `buildContentIndex` writes `kind='content'`, `buildEmbeddingIndex` writes `kind='chunk'|'summary'`. `semanticSearchPG` filters must include both `'content'` and `'deep'` spellings.
- `renderPaperNote` in `src/markdown.js` iterates `paper.assets.map()`, `paper.citations`, `paper.tags`. Article-shaped records (from sitemap ingester) and legacy PG rows may lack these — always use `??` fallbacks. This crashed `rebuildLinks` 3 times before it was caught.
- OpenAI TPM: `EMBED_CONCURRENCY=2` (was 4, caused 429 starvation). LLM summarize also contends for TPM. Monitor for `insufficient_quota` on large backfill jobs — OpenAI spend cap will silently kill long-running work.
- Semantic Scholar API for citation spidering: `api.semanticscholar.org/graph/v1/paper/arXiv:{id}/references?fields=externalIds,title,year` — rate-limited, use 1.2s delay. New papers take days to weeks to index.
- Railway cross-project: `railway link --project golden-showcase --service backend && railway redeploy --yes` manages sibling projects from this session.

## Context files
- [context/architecture.md](context/architecture.md) — system design
- [context/operations.md](context/operations.md) — Railway + deploy quirks
- [context/embedding-pipeline.md](context/embedding-pipeline.md) — OpenAI batching rules
- [context/data-model.md](context/data-model.md) — index + embeddings schemas
- [context/mcp-integration.md](context/mcp-integration.md) — MCP tool conventions
- [context/troubleshooting.md](context/troubleshooting.md) — known bugs, recovery
- [context/conventions.md](context/conventions.md) — code style
