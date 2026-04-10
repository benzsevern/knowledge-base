import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(moduleDir, "..");
export const vaultRoot = path.resolve(projectRoot, process.env.KB_VAULT_ROOT ?? "vault");
export const sourceRoot = path.resolve(projectRoot, process.env.KB_SOURCE_ROOT ?? "sources");
export const repoCloneRoot = path.join(sourceRoot, "repos");
export const vendorRoot = path.join(projectRoot, "vendor");
export const markerRoot = path.join(vendorRoot, "marker");
export const repomixRoot = path.join(vendorRoot, "repomix");
export const indexPath = path.join(vaultRoot, "kb_index.json");
