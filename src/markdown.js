import path from "node:path";

import { escapeYaml } from "./fs-utils.js";

function frontmatterLines(metadata) {
  const lines = ["---"];

  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - "${escapeYaml(item)}"`);
      }
      continue;
    }

    if (value && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        lines.push(`  ${nestedKey}: "${escapeYaml(nestedValue)}"`);
      }
      continue;
    }

    lines.push(`${key}: "${escapeYaml(value)}"`);
  }

  lines.push("---", "");
  return lines;
}

function normalizeList(values) {
  return values?.length ? values.map((value) => `- ${value}`) : ["- None"];
}

export function renderPaperNote(paper, linkedRepos) {
  // Defensive defaults — "article" records (from sitemap ingest) and older
  // rows in PG may not carry every paper-shape field. Missing → empty.
  const tags = paper.tags ?? [];
  const authors = paper.authors ?? [];
  const assets = paper.assets ?? [];
  const citations = paper.citations ?? [];

  const frontmatter = frontmatterLines({
    id: paper.id,
    type: paper.type ?? "academic_paper",
    title: paper.title,
    source_path: paper.sourcePath ?? "",
    source_url: paper.sourceUrl ?? "",
    tags: [paper.type ?? "academic_paper", ...tags],
    created_at: paper.createdAt,
    updated_at: paper.updatedAt,
    authors,
    year: paper.year ?? "",
    methodology_summary: paper.methodologySummary ?? "",
    constraints: paper.constraintsSummary ?? "",
    artifacts: assets,
    citations,
  });

  const repoLinks = linkedRepos.map((repo) => `[[repos/${repo.slug}/note|${repo.title}]]`);
  const body = [
    `# ${paper.title}`,
    "",
    "## Summary",
    paper.summary || "Summary pending extraction.",
    "",
    "## Methodology",
    paper.methodologySummary || "Methodology summary unavailable.",
    "",
    "## Constraints",
    paper.constraintsSummary || "Constraints unavailable.",
    "",
    "## Affected Repositories",
    ...normalizeList(repoLinks),
    "",
    "## Assets",
    ...normalizeList(assets.map((asset) => `![[${path.relative(path.dirname(paper.notePath), asset).replace(/\\/g, "/")}]]`)),
    "",
    "## Citations",
    ...normalizeList(citations),
    "",
    "## Source Extract",
    paper.markdownExcerpt || "No extracted markdown available.",
    "",
  ];

  return [...frontmatter, ...body].join("\n");
}

export function renderRepoNote(repo, linkedPapers, linkedRepos = []) {
  const frontmatter = frontmatterLines({
    id: repo.id,
    type: "repo",
    title: repo.title,
    source_path: repo.sourcePath,
    source_url: repo.sourceUrl ?? "",
    tags: ["repo", ...repo.tags],
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    repo_name: repo.repoName,
    origin: repo.origin,
    languages: repo.languages,
    entrypoints: repo.entrypoints,
    key_modules: repo.keyModules,
    packed_context_path: repo.packedContextPath,
    packed_context_meta_path: repo.packedContextMetaPath ?? "",
  });

  const paperLinks = linkedPapers.map((paper) => `[[papers/${paper.slug}/note|${paper.title}]]`);
  const body = [
    `# ${repo.title}`,
    "",
    "## Summary",
    repo.summary || "Repository summary unavailable.",
    "",
    "## Key Modules",
    ...normalizeList(repo.keyModules),
    "",
    "## Entrypoints",
    ...normalizeList(repo.entrypoints),
    "",
    "## Upstream Papers",
    ...normalizeList(paperLinks),
    "",
    "## Related Repositories",
    ...normalizeList(linkedRepos.map((other) => `[[repos/${other.slug}/note|${other.title}]]`)),
    "",
    "## Packed Context",
    `- [[${path.relative(path.dirname(repo.notePath), repo.packedContextPath).replace(/\\/g, "/")}]]`,
    `- [[${path.relative(path.dirname(repo.notePath), repo.packedContextMetaPath).replace(/\\/g, "/")}]]`,
    "",
  ];

  return [...frontmatter, ...body].join("\n");
}

export function renderRepoRepoRelationNote(relation, a, b) {
  const frontmatter = frontmatterLines({
    id: relation.id,
    type: "relation",
    title: `${a.title} <-> ${b.title}`,
    tags: ["relation", relation.relationType],
    created_at: relation.createdAt,
    updated_at: relation.updatedAt,
    from_id: relation.fromId,
    to_id: relation.toId,
    relation_type: relation.relationType,
    confidence: relation.confidence,
    evidence: relation.evidence.join(" | "),
  });

  return [
    ...frontmatter,
    `# ${a.title} <-> ${b.title}`,
    "",
    `- Repo A: [[repos/${a.slug}/note|${a.title}]]`,
    `- Repo B: [[repos/${b.slug}/note|${b.title}]]`,
    `- Relation: ${relation.relationType}`,
    `- Confidence: ${relation.confidence}`,
    "",
    "## Evidence",
    ...normalizeList(relation.evidence),
    "",
  ].join("\n");
}

export function renderRelationNote(relation, paper, repo) {
  const frontmatter = frontmatterLines({
    id: relation.id,
    type: "relation",
    title: `${paper.title} -> ${repo.title}`,
    tags: ["relation", relation.relationType],
    created_at: relation.createdAt,
    updated_at: relation.updatedAt,
    from_id: relation.fromId,
    to_id: relation.toId,
    relation_type: relation.relationType,
    confidence: relation.confidence,
    evidence: relation.evidence.join(" | "),
  });

  return [
    ...frontmatter,
    `# ${paper.title} -> ${repo.title}`,
    "",
    `- Paper: [[papers/${paper.slug}/note|${paper.title}]]`,
    `- Repo: [[repos/${repo.slug}/note|${repo.title}]]`,
    `- Relation: ${relation.relationType}`,
    `- Confidence: ${relation.confidence}`,
    "",
    "## Evidence",
    ...normalizeList(relation.evidence),
    "",
  ].join("\n");
}
