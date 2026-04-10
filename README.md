# Knowledge Base

Local-first RAG and visual knowledge base built around:

- Obsidian-compatible Markdown notes in `vault/`
- `marker` vendored in `vendor/marker` for document extraction
- `repomix` vendored in `vendor/repomix` as a reference implementation for repository packing
- A zero-dependency Node CLI in `kb`

## Workflow

1. Ingest papers into the vault:

```powershell
node bin/kb.js ingest-paper path\to\paper.pdf
```

2. Ingest repositories:

```powershell
node bin/kb.js ingest-repo path\to\repo
node bin/kb.js ingest-repo https://github.com/org/repo.git
```

3. Rebuild inferred links:

```powershell
node bin/kb.js rebuild-links
```

4. Query the combined context:

```powershell
node bin/kb.js query-context repo-my-service
```

## Layout

- `vault/papers/<slug>/note.md`: canonical paper note
- `vault/repos/<slug>/note.md`: canonical repository note
- `vault/links/*.md`: generated relation notes
- `vault/kb_index.json`: machine-readable entity and relation index
- `sources/repos/`: optional clones for remote repositories

## Marker and Repomix

This project does not import `marker` or `repomix` as package dependencies.

- `vendor/marker` is a local clone used as a source-only extraction backend if you set up its Python runtime environment.
- `vendor/repomix` is a local clone kept as a reference and future extraction source.
- The current repository packer is implemented in `src/repo-packer.js` using Node built-ins only.

Set up the vendored `marker` runtime with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-marker.ps1
```

If `.venv-marker` gets into a bad state, rebuild it with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-marker.ps1 -Recreate
```

This script installs runtime dependencies only. The CLI runs `vendor/marker` directly via `PYTHONPATH` and auto-discovers `.venv-marker` before falling back to system Python or `marker_single`.

## Notes

- If `marker_single` is unavailable, paper ingestion falls back to a sibling `.md` file when present, otherwise it creates a stub note.
- Notes are regenerated from the index during linking, so generated sections should be treated as managed content.
- Repository packing respects built-in ignore defaults plus `.gitignore` and optional `.kbignore`, and writes a companion `packed-context.meta.json`.
