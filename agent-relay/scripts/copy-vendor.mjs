/**
 * 将 @scalar/api-reference 浏览器包复制到 public/vendor，供 /api-docs 离线加载。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "node_modules", "@scalar", "api-reference", "dist");
const outDir = path.join(root, "public", "vendor");

mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(pkgDir, "browser", "standalone.js"), path.join(outDir, "scalar-api-reference.js"));
copyFileSync(path.join(pkgDir, "style.css"), path.join(outDir, "scalar-api-reference.css"));
console.log("vendor: scalar-api-reference copied to public/vendor/");
