# Data Model

## kb_index.json

```js
{
  generatedAt: ISO string,
  papers:  [{ id, slug, title, notePath, markdownExcerpt, ... }],
  repos:   [{ id, slug, title, languages, keyModules, entrypoints, packedContextPath, ... }],
  docs:    [{ id, slug, title, pagesDir, pageCount, ... }],
  relations: [{ id, sourceId, targetId, type, score, ... }]
}
```

At scale (1300+ repos, 900K relations), this file exceeds Node's max string length (~512MB).

## kb_embeddings.json

Summary embeddings for all entities. One entry per chunk.

```js
{
  model: "text-embedding-3-small",
  generatedAt: ISO,
  entries: [
    { id: "<entity-id>#chunk-<n>", entityId, entityTitle, type, kind, chunkIndex, text, hash, vector: [1536 floats] }
  ]
}
```

`kind: "chunk"` for paper/doc content, `kind: "summary"` for repo summaries.

## repos/<slug>/embeddings.json

Per-repo deep content embeddings. Same entry structure but with `kind: "content"` and loaded only when `scope` or `deep` is set on search.

## Streaming I/O (required at scale)

`src/fs-utils.js` `writeJson` and `readJson` stream line-by-line for files over 50MB.

**Never revert to `JSON.stringify(obj, null, 2)`** on the index or embeddings files — will throw `Invalid string length`.

`src/embeddings.js` `loadEmbeddings` and `saveEmbeddings` also stream (their own format, bypassing `fs-utils.writeJson`).
