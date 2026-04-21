# Code Conventions

## Module style

- ESM imports (`import x from "..."`), `.js` extension required on relative imports
- Zero runtime deps for CLI — everything is stdlib + a few curated packages (express, commander, repomix)
- No TypeScript — pure JS with JSDoc when needed

## Error handling

- Async jobs: catch errors, store in `job.error`, set `job.status = "failed"`. Don't throw.
- Per-item loops (papers/repos): catch per-item so one bad item doesn't kill the batch. Record in summary results with `skipped: "error: ..."`.

## Long-running work

- Always wrap in `createJob()` from `src/server.js`
- Return `{ jobId, status: "running" }` immediately
- Client polls `/api/jobs/{id}`

## File I/O

- Large JSON: use `writeJson`/`readJson` from `src/fs-utils.js` (they stream when needed)
- Embeddings file: use `saveEmbeddings`/`loadEmbeddings` (custom format, don't reuse writeJson)
- Avoid `JSON.stringify(..., null, 2)` on anything that could exceed 50MB

## API patterns

- POST for mutations, GET for reads
- Job-returning endpoints: `{ jobId, status }`
- Sync endpoints: return result directly or `{ error }` with appropriate HTTP status
- Never require auth — the KB is intentionally public-read

## Git

- `gh auth switch --user benzsevern` before pushing
- Don't commit `vault/`, `inbox/`, `.env`, or `*-filtered.json`/`*-metadata.jsonl` scratch files
