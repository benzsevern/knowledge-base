import { indexPath } from "./config.js";
import { readJson, writeJson } from "./fs-utils.js";

const emptyIndex = () => ({
  generatedAt: new Date(0).toISOString(),
  papers: [],
  repos: [],
  docs: [],
  relations: [],
});

export async function loadIndex() {
  const idx = await readJson(indexPath, emptyIndex());
  // Backfill missing fields for older indexes.
  if (!Array.isArray(idx.docs)) idx.docs = [];
  return idx;
}

export async function saveIndex(index) {
  const normalized = {
    generatedAt: new Date().toISOString(),
    papers: [...index.papers].sort((a, b) => a.id.localeCompare(b.id)),
    repos: [...index.repos].sort((a, b) => a.id.localeCompare(b.id)),
    docs: [...(index.docs ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...index.relations].sort((a, b) => a.id.localeCompare(b.id)),
  };

  await writeJson(indexPath, normalized);
  return normalized;
}

export function upsertEntity(collection, entity) {
  const next = collection.filter((item) => item.id !== entity.id);
  next.push(entity);
  return next;
}

export function findEntity(index, identifier) {
  const match = [...index.papers, ...index.repos, ...(index.docs ?? [])].find((item) => {
    return item.id === identifier || item.slug === identifier || item.title === identifier || item.repoName === identifier;
  });

  return match ?? null;
}
