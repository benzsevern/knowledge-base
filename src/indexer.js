import { indexPath } from "./config.js";
import { readJson, writeJson } from "./fs-utils.js";

const emptyIndex = () => ({
  generatedAt: new Date(0).toISOString(),
  papers: [],
  repos: [],
  relations: [],
});

export async function loadIndex() {
  return readJson(indexPath, emptyIndex());
}

export async function saveIndex(index) {
  const normalized = {
    generatedAt: new Date().toISOString(),
    papers: [...index.papers].sort((a, b) => a.id.localeCompare(b.id)),
    repos: [...index.repos].sort((a, b) => a.id.localeCompare(b.id)),
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
  const match = [...index.papers, ...index.repos].find((item) => {
    return item.id === identifier || item.slug === identifier || item.title === identifier || item.repoName === identifier;
  });

  return match ?? null;
}
