# MCP Integration

The MCP server (`mcp/server.js`) exposes KB operations as MCP tools to Claude Desktop/Code.

## Architecture

- stdio JSON-RPC (not HTTP)
- Thin proxy — every tool just calls the HTTP API
- `KB_API_URL` env var picks target (default: Railway prod)

## Tools exposed

- `kb_status`, `kb_search`, `kb_chat`
- `kb_search_arxiv`, `kb_search_github`, `kb_discover_arxiv`
- `kb_fetch_paper_candidates`, `kb_fetch_repo_candidates`
- `kb_ingest_docs`, `kb_ingest_repo`, `kb_ingest_repos`
- `kb_embed`, `kb_embed_content`
- `kb_job_status`, `kb_jobs`, `kb_graph`
- `kb_topic_brief`, `kb_lit_review`, `kb_gap_analysis`

## Adding a new tool

1. Add entry to `TOOLS[]` array with JSONSchema `inputSchema`
2. Add `case` to `handleTool()` that proxies to a new `/api/<name>` endpoint
3. Add the endpoint in `src/server.js`

## Running against local API

Set `KB_API_URL=http://localhost:3000` in the MCP config to test against a local server.
