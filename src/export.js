import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { vaultRoot, projectRoot } from "./config.js";
import { fileExists } from "./fs-utils.js";

/**
 * Export essential vault files to a tar.gz archive.
 * Skips packed-context.md and packed-context.meta.json (large, only needed for re-embedding).
 */
export async function exportVault({ outPath, slim = false } = {}) {
  const archivePath = outPath ?? path.join(projectRoot, "vault-export.tar.gz");

  const files = [];
  await walk(vaultRoot, vaultRoot, files, slim);

  // Write file list to a temp file to avoid arg length limits
  const listPath = path.join(projectRoot, ".vault-export-list.txt");
  await fs.writeFile(listPath, files.map((f) => f.rel).join("\n"), "utf8");

  try {
    const forceLocal = process.platform === "win32" ? ["--force-local"] : [];
    execFileSync("tar", [
      "czf", archivePath.replace(/\\/g, "/"),
      ...forceLocal,
      "-C", vaultRoot.replace(/\\/g, "/"),
      "-T", listPath.replace(/\\/g, "/"),
    ], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } finally {
    await fs.rm(listPath, { force: true });
  }

  const stat = await fs.stat(archivePath);
  return {
    outPath: archivePath,
    fileCount: files.length,
    bytes: stat.size,
  };
}

async function walk(dir, root, files, slim = false) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      await walk(full, root, files, slim);
      continue;
    }

    // Skip heavy files not needed at runtime
    if (entry.name === "packed-context.md") continue;
    if (entry.name === "packed-context.meta.json") continue;

    // Skip rasterized page images and intermediate text files (extraction artifacts)
    if (/\.(png|jpg|jpeg|webp)$/i.test(entry.name) && /\/pages\//.test(rel)) continue;
    if (/\.txt$/i.test(entry.name) && /\/text\//.test(rel)) continue;

    // Slim mode: skip per-repo content embeddings (regeneratable via kb embed-content)
    if (slim && entry.name === "embeddings.json" && /repos\//.test(rel)) continue;

    files.push({ full, rel });
  }
}

/**
 * Import a tar.gz archive into the vault directory.
 */
export async function importVault(archivePath) {
  if (!(await fileExists(archivePath))) {
    throw new Error(`Archive not found: ${archivePath}`);
  }

  execFileSync("tar", ["xzf", archivePath.replace(/\\/g, "/"), "-C", vaultRoot.replace(/\\/g, "/")], {
    encoding: "utf8",
    stdio: "pipe",
  });

  return { vaultRoot };
}
