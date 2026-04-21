# Embedding Pipeline

## OpenAI limits (text-embedding-3-small)

- **Per-input tokens**: 8191 max (hard)
- **Per-request tokens**: ~300K max (returns 400 if exceeded)
- **Per-input char count**: no direct limit, but tokens matter
- **Rate limit**: hit at ~8 concurrent requests with 80K-token batches

## Token estimation

**Use `~2 chars/token` for code, not 4.** Code has more punctuation and BPE often encodes symbols individually.

`estimateTokens(text) = Math.ceil(text.length / 2)` in `src/embeddings.js`.

## Configured constants

In `src/embeddings.js`:
```js
const CHUNK_MAX_CHARS = 2000;         // ~1000 tokens for code
const MAX_BATCH_TOKENS = 80_000;      // conservative; real limit ~300K
const MAX_INPUT_TOKENS = 7000;        // skip chunks exceeding this
const EMBED_CONCURRENCY = 4;          // more → 429 rate limits
```

## Batching strategy

**Token-aware, not count-aware.** `batchByTokens(texts)` packs texts into batches until adding another would exceed `MAX_BATCH_TOKENS`. Skips any single text over `MAX_INPUT_TOKENS`.

## Anti-patterns (burned us this session)

- **Recursive split on 400** — caused 2+ hour retry storms. If a batch 400s, it means the token estimate was wrong. Fix the estimate, don't split.
- **`BATCH_SIZE = 2048`** (by count, no token cap) — ~1M tokens per batch, 400s constantly.
- **`BATCH_SIZE = 64`** (too small) — 30x more API calls than necessary.

## Expected runtimes

- 754 repo summary embed: ~12 min
- 1321 repo deep content embed (first pass): ~70 min
- Retry failed-batch repos: can take 60-120 min depending on how many need processing
