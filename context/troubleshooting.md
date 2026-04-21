# Troubleshooting

## `Invalid string length` error

Node's max string length is ~512MB. Hit when:
- `JSON.stringify(embeddings, null, 2)` on 24K+ entries
- `JSON.parse(await fs.readFile(index))` on 1M+ relations

**Fix**: Use streaming read/write. Already implemented in `src/fs-utils.js` and `src/embeddings.js`. Never revert.

## Corrupted `kb_index.json`

Usually from ENOSPC (disk full) or crash mid-write.

**Recovery**:
```bash
curl -X POST https://kb-api-production-d23f.up.railway.app/api/recover-index
```

Scans `vault/papers/`, `vault/repos/`, `vault/docs/` filesystem and rebuilds the index. Does NOT rebuild relations — run `/api/rebuild-links` afterward.

## `/api/status` returning `degraded: true`

Index is unreadable. Healthcheck stays 200 so Railway doesn't kill the service. Same fix as above.

## OpenAI 400 "Requested X tokens"

Batch exceeded ~300K tokens. Check `MAX_BATCH_TOKENS` and token estimate. See embedding-pipeline.md.

## OpenAI 429 rate limits

Too many concurrent requests. Lower `EMBED_CONCURRENCY` in `src/embeddings.js` (current: 4).

## Job stuck in `running` forever

Kill via redeploy (see operations.md). Completed per-repo work is saved incrementally to disk so progress isn't lost.

## Deep search times out

`{ deep: true }` without scope tries to load all ~700K repo content vectors. **Always pass `scope: ["repo-<slug>", ...]`** to deep search.

## Papers missing after session

`recover-index` only rebuilds from vault files. URL-cached papers (`inbox/url-cache/`) aren't picked up. Re-run ingest if needed.

## Windows bash quirks

- Python sometimes fails `open('/tmp/...')` via `-c` but succeeds via stdin pipe
- Use `/dev/null` not `NUL`, forward slashes in paths
- `gh auth switch --user benzsevern` before pushes
