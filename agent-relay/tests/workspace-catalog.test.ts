import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  buildWorkspaceCatalog,
  decodeCustomWorkspaceKey,
  encodeCustomWorkspaceRoot,
  resolveWorkspaceRootFromCatalog,
} from "../src/config/workspaceCatalog.js";
import type { AppConfig } from "../src/config/types.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

const configWithWorkspaces: AppConfig = {
  workspaceRoot: "..",
  workspaces: [
    { id: "repo", label: "仓库根目录", root: ".." },
    { id: "pkg", label: "包目录", root: "." },
  ],
  models: { default: "local", clients: [] },
  routing: { strategy: "local-first", fallback: true },
};

test("buildWorkspaceCatalog resolves relative roots", () => {
  const catalog = buildWorkspaceCatalog(projectRoot, configWithWorkspaces);
  assert.equal(catalog.defaultKey, "repo");
  assert.equal(catalog.entries.length, 2);
  assert.equal(catalog.byId.get("repo")?.resolvedRoot, path.resolve(projectRoot, ".."));
  assert.equal(catalog.byId.get("pkg")?.resolvedRoot, projectRoot);
});

test("buildWorkspaceCatalog falls back to single default entry", () => {
  const catalog = buildWorkspaceCatalog(projectRoot, {
    workspaceRoot: "..",
    models: { default: "local", clients: [] },
    routing: { strategy: "local-first", fallback: true },
  });
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.defaultKey, "default");
  assert.equal(catalog.defaultRoot, path.resolve(projectRoot, ".."));
});

test("resolveWorkspaceRootFromCatalog honors workspace key", () => {
  const catalog = buildWorkspaceCatalog(projectRoot, configWithWorkspaces);
  assert.equal(
    resolveWorkspaceRootFromCatalog(catalog, "pkg"),
    path.resolve(projectRoot, "."),
  );
  assert.equal(resolveWorkspaceRootFromCatalog(catalog, "missing"), catalog.defaultRoot);
  assert.equal(resolveWorkspaceRootFromCatalog(catalog, undefined), catalog.defaultRoot);
});

test("custom workspace root can be encoded and decoded", () => {
  const customRoot = path.resolve(projectRoot, "..");
  const key = encodeCustomWorkspaceRoot(customRoot);
  assert.ok(key.startsWith("custom:"));
  assert.equal(decodeCustomWorkspaceKey(key), customRoot);
});

test("resolveWorkspaceRootFromCatalog supports custom workspace key", () => {
  const catalog = buildWorkspaceCatalog(projectRoot, configWithWorkspaces);
  const customRoot = path.resolve(projectRoot, ".");
  const key = encodeCustomWorkspaceRoot(customRoot);
  assert.equal(resolveWorkspaceRootFromCatalog(catalog, key), customRoot);
});
