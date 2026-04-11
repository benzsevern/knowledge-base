import {
  discoverArxivCandidates,
  fetchArxivCandidates,
  fetchRepoCandidates,
  ingestDocsSite,
  ingestPaper,
  ingestRepo,
  ingestPapersBatch,
  ingestReposBatch,
  queryContext,
  rebuildLinks,
  searchArxiv,
  searchGithubRepos,
} from "./commands.js";
import { buildContentIndex, buildEmbeddingIndex, semanticSearch } from "./embeddings.js";
import { chat, gapAnalysis, literatureReview } from "./rag.js";

function formatDuration(seconds) {
  const sec = Math.max(0, Math.round(seconds));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function helpText() {
  return `
Usage:
  kb ingest-paper <pdf_path>
  kb ingest-papers <pdf_path> [pdf_path...]
  kb ingest-repo <repo_path_or_git_url>
  kb ingest-repos <repo_path> [repo_path...]
  kb ingest-docs <url> [--max-pages N] [--include path,path] [--exclude path,path]
  kb rebuild-links
  kb discover-arxiv
  kb search-arxiv "<query>" [--top N]
  kb fetch-candidates [--top N]
  kb search-github "<query>" [--top N] [--sort stars|updated]
  kb fetch-repo-candidates [--top N]
  kb embed [--force]
  kb embed-content [--repos id,id,...] [--all] [--force]
  kb search "<query>" [--top N] [--scope id,id,...] [--deep]
  kb chat "<question>" [--top K] [--scope id,id,...] [--deep]
  kb lit-review <entity_id_or_slug> [--out path]
  kb gap-analysis <repo_id_or_slug> [--out path]
  kb export [--out path]
  kb query-context <entity_id_or_slug>
`.trim();
}

export async function main(args) {
  const [command, ...rest] = args;

  switch (command) {
    case "ingest-paper": {
      const target = rest[0];
      if (!target) {
        throw new Error("Missing pdf path.");
      }
      const paper = await ingestPaper(target);
      console.log(`Ingested paper: ${paper.id}`);
      return;
    }
    case "ingest-papers": {
      if (!rest.length) {
        throw new Error("Missing pdf path(s).");
      }
      await ingestPapersBatch(rest, {
        onProgress: ({ record, index, total, elapsedSec, etaSec }) => {
          const eta = etaSec > 0 ? `, ETA ${formatDuration(etaSec)}` : "";
          console.log(
            `[${index}/${total}] Ingested paper: ${record.id} (${formatDuration(elapsedSec)}${eta})`,
          );
        },
      });
      return;
    }
    case "ingest-repo": {
      const target = rest[0];
      if (!target) {
        throw new Error("Missing repository path or URL.");
      }
      const repo = await ingestRepo(target);
      console.log(`Ingested repo: ${repo.id}`);
      return;
    }
    case "ingest-repos": {
      if (!rest.length) {
        throw new Error("Missing repo path(s).");
      }
      await ingestReposBatch(rest, {
        onProgress: ({ record, error, input, index, total, elapsedSec, etaSec }) => {
          if (error) {
            console.log(`[${index}/${total}] FAILED ${input}: ${error}`);
            return;
          }
          const eta = etaSec > 0 ? `, ETA ${formatDuration(etaSec)}` : "";
          console.log(
            `[${index}/${total}] Ingested repo: ${record.id} (${formatDuration(elapsedSec)}${eta})`,
          );
        },
      });
      return;
    }
    case "ingest-docs": {
      const url = rest.find((arg) => !arg.startsWith("--"));
      if (!url) throw new Error("Missing URL.");
      const maxFlag = rest.indexOf("--max-pages");
      const maxPages = maxFlag !== -1 ? Number(rest[maxFlag + 1]) : 100;
      const includeFlag = rest.indexOf("--include");
      const excludeFlag = rest.indexOf("--exclude");
      const includePaths = includeFlag !== -1 ? rest[includeFlag + 1].split(",") : undefined;
      const excludePaths = excludeFlag !== -1 ? rest[excludeFlag + 1].split(",") : undefined;
      const titleFlag = rest.indexOf("--title");
      const title = titleFlag !== -1 ? rest[titleFlag + 1] : undefined;
      console.log(`Crawling ${url} (max ${maxPages} pages)...`);
      const record = await ingestDocsSite(url, { maxPages, includePaths, excludePaths, title });
      console.log(`Ingested docs: ${record.id} (${record.pageCount} pages, ${(record.totalBytes / 1024).toFixed(0)} KB)`);
      return;
    }
    case "rebuild-links": {
      const index = await rebuildLinks();
      console.log(`Rebuilt ${index.relations.length} relations.`);
      return;
    }
    case "discover-arxiv": {
      const result = await discoverArxivCandidates();
      console.log(`Found ${result.candidates.length} candidate arXiv IDs.`);
      console.log(`Written to: ${result.outPath}`);
      const top = result.candidates.slice(0, 25);
      if (top.length) {
        console.log("\nTop verified candidates (by citation count across your library):");
        for (const c of top) {
          const title = c.title ? ` — ${c.title.slice(0, 80)}` : "";
          console.log(`  ${c.arxivId}  (${c.sources.length}x)${title}`);
        }
      }
      return;
    }
    case "search-arxiv": {
      const query = rest.find((arg) => !arg.startsWith("--"));
      if (!query) throw new Error("Missing search query.");
      const topFlag = rest.indexOf("--top");
      const limit = topFlag !== -1 ? Number(rest[topFlag + 1]) : 20;
      const result = await searchArxiv(query, { limit });
      console.log(`Found ${result.candidates.length} new papers (already-ingested excluded).`);
      console.log(`Written to: ${result.outPath}`);
      if (result.candidates.length) {
        console.log("\nCandidates:");
        for (const c of result.candidates) {
          const abs = c.abstract ? ` — ${c.abstract.slice(0, 100)}` : "";
          console.log(`  ${c.arxivId}  ${c.title.slice(0, 80)}${abs}`);
        }
        console.log(`\nRun \`kb fetch-candidates --top N\` to download and ingest.`);
      }
      return;
    }
    case "fetch-candidates": {
      const topFlag = rest.indexOf("--top");
      const limit = topFlag !== -1 ? Number(rest[topFlag + 1]) : 10;
      const result = await fetchArxivCandidates(limit, {
        onProgress: ({ record, index, total, elapsedSec, etaSec }) => {
          const eta = etaSec > 0 ? `, ETA ${formatDuration(etaSec)}` : "";
          console.log(
            `[${index}/${total}] Ingested paper: ${record.id} (${formatDuration(elapsedSec)}${eta})`,
          );
        },
      });
      console.log(`\nDownloaded ${result.downloaded.length} PDFs, ingested ${result.ingested.length}.`);
      return;
    }
    case "search-github": {
      const query = rest.find((arg) => !arg.startsWith("--"));
      if (!query) throw new Error("Missing search query.");
      const topFlag = rest.indexOf("--top");
      const limit = topFlag !== -1 ? Number(rest[topFlag + 1]) : 20;
      const sortFlag = rest.indexOf("--sort");
      const sort = sortFlag !== -1 ? rest[sortFlag + 1] : "stars";
      const result = await searchGithubRepos(query, { limit, sort });
      console.log(`Found ${result.candidates.length} repos (already-ingested excluded).`);
      console.log(`Written to: ${result.outPath}`);
      if (result.candidates.length) {
        console.log("\nCandidates:");
        for (const c of result.candidates) {
          const desc = c.description ? ` — ${c.description.slice(0, 80)}` : "";
          console.log(`  ${c.fullName}  ★${c.stars}  ${c.language ?? ""}${desc}`);
        }
        console.log(`\nRun \`kb fetch-repo-candidates --top N\` to clone and ingest.`);
      }
      return;
    }
    case "fetch-repo-candidates": {
      const topFlag = rest.indexOf("--top");
      const limit = topFlag !== -1 ? Number(rest[topFlag + 1]) : 10;
      const result = await fetchRepoCandidates(limit, {
        onProgress: ({ record, error, input, index, total, elapsedSec, etaSec }) => {
          if (error) {
            console.log(`[${index}/${total}] FAILED ${input}: ${error}`);
            return;
          }
          const eta = etaSec > 0 ? `, ETA ${formatDuration(etaSec)}` : "";
          console.log(
            `[${index}/${total}] Ingested repo: ${record.id} (${formatDuration(elapsedSec)}${eta})`,
          );
        },
      });
      console.log(`\nIngested ${result.ingested.length} repos.`);
      return;
    }
    case "embed": {
      const force = rest.includes("--force");
      const result = await buildEmbeddingIndex({ force });
      console.log(`Embeddings: ${result.total} entries (${result.embedded} new, ${result.reused} reused).`);
      return;
    }
    case "embed-content": {
      const force = rest.includes("--force");
      const reposFlag = rest.indexOf("--repos");
      const all = rest.includes("--all");
      let repoIds = null;
      if (reposFlag !== -1) {
        repoIds = rest[reposFlag + 1].split(",").map((s) => s.trim()).filter(Boolean);
      } else if (!all) {
        throw new Error("Specify --repos id,id,... or --all");
      }
      const summary = await buildContentIndex({ repoIds, force });
      let totalChunks = 0;
      let reusedRepos = 0;
      let newRepos = 0;
      for (const row of summary) {
        if (row.skipped) {
          console.log(`  ${row.repo}: skipped (${row.skipped})`);
          continue;
        }
        totalChunks += row.chunks;
        if (row.reused) reusedRepos += 1;
        else newRepos += 1;
        const tag = row.reused ? "reused" : "embedded";
        console.log(`  ${row.repo}: ${row.chunks} chunks (${tag})`);
      }
      console.log(`\n${totalChunks} total chunks across ${summary.length} repos (${newRepos} embedded, ${reusedRepos} reused).`);
      return;
    }
    case "search": {
      const positional = rest.filter((arg, i) => !arg.startsWith("--") && (i === 0 || !rest[i - 1].startsWith("--")));
      const query = positional[0];
      if (!query) throw new Error("Missing query string.");
      const topFlag = rest.indexOf("--top");
      const topK = topFlag !== -1 ? Number(rest[topFlag + 1]) : 10;
      const scopeFlag = rest.indexOf("--scope");
      const scope = scopeFlag !== -1 ? rest[scopeFlag + 1].split(",").map((s) => s.trim()) : null;
      const deep = rest.includes("--deep");
      const hits = await semanticSearch(query, { topK, scope, deep });
      for (const hit of hits) {
        const preview = hit.entry.text.replace(/\s+/g, " ").slice(0, 140);
        const kindTag = hit.entry.kind ? `:${hit.entry.kind}` : "";
        console.log(`${hit.score.toFixed(3)}  ${hit.entry.type}${kindTag}  ${hit.entry.entityTitle}`);
        console.log(`        ${preview}`);
      }
      return;
    }
    case "chat": {
      const positional = rest.filter((arg, i) => !arg.startsWith("--") && (i === 0 || !rest[i - 1].startsWith("--")));
      const question = positional[0];
      if (!question) throw new Error("Missing question.");
      const topFlag = rest.indexOf("--top");
      const topK = topFlag !== -1 ? Number(rest[topFlag + 1]) : 8;
      const scopeFlag = rest.indexOf("--scope");
      const scope = scopeFlag !== -1 ? rest[scopeFlag + 1].split(",").map((s) => s.trim()) : null;
      const deep = rest.includes("--deep");
      const result = await chat(question, { topK, scope, deep });
      console.log(result.answer);
      console.log("\nSources:");
      for (const hit of result.hits) {
        console.log(`  ${hit.score.toFixed(3)}  ${hit.entry.entityTitle}`);
      }
      return;
    }
    case "lit-review": {
      const entity = rest.find((arg) => !arg.startsWith("--"));
      if (!entity) throw new Error("Missing entity id.");
      const outFlag = rest.indexOf("--out");
      const outPath = outFlag !== -1 ? rest[outFlag + 1] : undefined;
      const result = await literatureReview(entity, { outPath });
      console.log(`Wrote review covering ${result.paperCount} papers to: ${result.outPath}`);
      return;
    }
    case "gap-analysis": {
      const entity = rest.find((arg) => !arg.startsWith("--"));
      if (!entity) throw new Error("Missing repo id.");
      const outFlag = rest.indexOf("--out");
      const outPath = outFlag !== -1 ? rest[outFlag + 1] : undefined;
      const result = await gapAnalysis(entity, { outPath });
      console.log(`Wrote gap analysis covering ${result.paperCount} papers to: ${result.outPath}`);
      return;
    }
    case "export": {
      const { exportVault } = await import("./export.js");
      const outFlag = rest.indexOf("--out");
      const outPath = outFlag !== -1 ? rest[outFlag + 1] : undefined;
      const slim = rest.includes("--slim");
      const result = await exportVault({ outPath, slim });
      console.log(`Exported ${result.fileCount} files (${(result.bytes / 1024 / 1024).toFixed(1)} MB) to: ${result.outPath}`);
      return;
    }
    case "query-context": {
      const target = rest[0];
      if (!target) {
        throw new Error("Missing entity identifier.");
      }
      console.log(await queryContext(target));
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(helpText());
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
}
