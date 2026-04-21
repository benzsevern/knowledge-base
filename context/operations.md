# Operations

## Railway

- **URL**: `https://kb-api-production-d23f.up.railway.app`
- **Deployment**: GitHub push to `main` → auto-deploy
- **Volume**: `/app/vault` (50GB persistent)
- **Jobs**: in-memory Map, wiped on redeploy
- **Healthcheck**: `/api/status` returns 200 even when index is corrupted (`{ ok: false, degraded: true }`)

## Redeploy behavior

- Pushing a commit triggers redeploy
- **Empty commits sometimes don't trigger redeploy** — push a real change if you need a restart
- Redeploy kills all in-flight jobs + their results (in-memory)
- Completed work on disk (embeddings, index) survives

## Kill a stuck job

No cancel endpoint exists. Force redeploy:
```bash
cd D:/show_case/knowledge_base
echo "// restart $(date +%s)" >> src/server.js && git add -u && git commit -m "Force restart" && git push
```

## GitHub auth quirk

The `gh` CLI has two users (`benzsevern` personal, `benzsevern-mjh` work). Before pushing:
```bash
gh auth switch --user benzsevern
```
Without this, pushes to benzsevern/knowledge-base may 403.

## Environment variables

Required on Railway:
- `OPENAI_API_KEY` — for embeddings + LLM
- `FIRECRAWL_API_KEY` — for doc ingestion
- `RAILWAY_TOKEN` (local) — for CLI operations

## MCP client config

Add to Claude Desktop/Code MCP settings:
```json
{
  "knowledge-base": {
    "command": "node",
    "args": ["D:/show_case/knowledge_base/mcp/server.js"],
    "env": { "KB_API_URL": "https://kb-api-production-d23f.up.railway.app" }
  }
}
```
