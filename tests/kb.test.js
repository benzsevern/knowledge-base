import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kb-test-"));
process.env.KB_VAULT_ROOT = path.join(tempRoot, "vault");
process.env.KB_SOURCE_ROOT = path.join(tempRoot, "sources");

const { ingestPaper, ingestRepo, queryContext, rebuildLinks } = await import("../src/commands.js");
const { loadIndex } = await import("../src/indexer.js");

test("ingests repo and paper, then links them", async () => {
  const repoRoot = path.join(tempRoot, "sample-repo");
  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "package.json"), '{ "name": "ingestion-service" }\n', "utf8");
  await fs.writeFile(path.join(repoRoot, ".gitignore"), "build/\n*.log\n", "utf8");
  await fs.writeFile(
    path.join(repoRoot, "src", "ingestion.js"),
    "export class DataIngestionService { run() { return 'ok'; } }\n",
    "utf8",
  );
  await fs.mkdir(path.join(repoRoot, "build"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "build", "ignored.js"), "console.log('ignore me');\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "trace.log"), "ignore me\n", "utf8");

  const paperRoot = path.join(tempRoot, "papers");
  await fs.mkdir(paperRoot, { recursive: true });
  const pdfPath = path.join(paperRoot, "2026-ingestion-constraints.pdf");
  const sidecarMarkdownPath = path.join(paperRoot, "2026-ingestion-constraints.md");
  await fs.writeFile(pdfPath, "%PDF-1.4\n", "utf8");
  await fs.writeFile(
    sidecarMarkdownPath,
    [
      "# 2026 Ingestion Constraints",
      "",
      "## Methodology",
      "The methodology updates the sample-repo around the src ingestion pipeline.",
      "",
      "## Constraints",
      "The sample-repo must batch records and preserve source ordering.",
      "",
    ].join("\n"),
    "utf8",
  );

  const repo = await ingestRepo(repoRoot);
  const paper = await ingestPaper(pdfPath);
  const index = await loadIndex();

  assert.equal(repo.id, "repo-sample-repo");
  assert.equal(paper.id, "paper-2026-ingestion-constraints");
  assert.equal(index.relations.length, 1);
  assert.match(index.relations[0].id, /paper-2026-ingestion-constraints__repo-sample-repo/);

  const context = await queryContext(repo.id);
  assert.match(context, /paper-2026-ingestion-constraints/);
  assert.match(context, /packed_context:/);
  assert.match(context, /packed_context_meta:/);

  const meta = JSON.parse(await fs.readFile(repo.packedContextMetaPath, "utf8"));
  assert.equal(meta.includedFiles.some((file) => file.path === "build/ignored.js"), false);
  assert.equal(meta.includedFiles.some((file) => file.path === "trace.log"), false);
  assert.equal(meta.includedFiles.some((file) => file.path === "src/ingestion.js"), true);
});

test("rebuild-links is idempotent with existing index", async () => {
  const index = await rebuildLinks();
  const again = await rebuildLinks(index);
  assert.equal(index.relations.length, again.relations.length);
});
