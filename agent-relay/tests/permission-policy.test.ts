/**
 * 权限覆盖顺序自检。
 * 运行：npm run test:permission-policy
 */
import assert from "node:assert/strict";

import { MODE_PERMISSIONS, ALL_PERMISSIONS } from "../src/agent/permissions.js";
import {
  PERMISSION_SCOPE_ORDER,
  assertUserGrantWithinCeiling,
  intersectPermissions,
  resolveEffectivePermissions,
  resolveProjectAllowedPermissions,
} from "../src/policy/PermissionPolicy.js";
import {
  DEFAULT_PATCH_TOOL_POLICY,
  DEFAULT_READONLY_TOOL_POLICY,
  defaultToolRouter,
} from "../src/subagent/index.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("scope order is project → mode → role → task → user", () => {
  assert.deepEqual(PERMISSION_SCOPE_ORDER, ["project", "mode", "role", "task", "user"]);
});

test("project ceiling narrows task mode", () => {
  const resolved = resolveEffectivePermissions({
    projectAllowed: ["read", "write"],
    modeAllowed: MODE_PERMISSIONS.task,
  });
  assert.deepEqual(resolved.allowed, ["read", "write"]);
  assert.equal(resolved.layers.length, 2);
});

test("plan mode removes write even with full project", () => {
  const resolved = resolveEffectivePermissions({
    projectAllowed: ALL_PERMISSIONS,
    modeAllowed: MODE_PERMISSIONS.plan,
  });
  assert.deepEqual(resolved.allowed, ["read"]);
});

test("strict user grant rejects expansion beyond mode", () => {
  assert.throws(
    () =>
      resolveEffectivePermissions({
        projectAllowed: ALL_PERMISSIONS,
        modeAllowed: MODE_PERMISSIONS.plan,
        userGranted: ["write"],
        strictUserGrant: true,
      }),
    /超出允许范围/,
  );
});

test("intersect preserves canonical order", () => {
  assert.deepEqual(intersectPermissions(["shell", "read"], ["read", "write"]), ["read"]);
});

test("resolveProjectAllowedPermissions defaults to all", () => {
  assert.deepEqual(resolveProjectAllowedPermissions(undefined), ALL_PERMISSIONS);
  assert.deepEqual(resolveProjectAllowedPermissions({ allowed: ["read"] }), ["read"]);
});

test("subagent readonly toolPolicy + project ceiling", () => {
  const { permissions } = defaultToolRouter.resolvePermissions(
    DEFAULT_READONLY_TOOL_POLICY,
    undefined,
    ["read", "write"],
  );
  assert.deepEqual(permissions, ["read"]);
});

test("subagent write toolPolicy requires explicit write grant", () => {
  assert.throws(
    () => defaultToolRouter.resolvePermissions(DEFAULT_PATCH_TOOL_POLICY, ["read"], ALL_PERMISSIONS),
    /write|显式授予/,
  );
  const { permissions } = defaultToolRouter.resolvePermissions(
    DEFAULT_PATCH_TOOL_POLICY,
    ["read", "write"],
    ALL_PERMISSIONS,
  );
  assert.deepEqual(permissions, ["read", "write"]);
});

test("subagent user grant cannot exceed toolPolicy ceiling", () => {
  assert.throws(
    () => defaultToolRouter.resolvePermissions(DEFAULT_READONLY_TOOL_POLICY, ["write"], ALL_PERMISSIONS),
    /超出允许范围/,
  );
});

test("assertUserGrantWithinCeiling", () => {
  assert.throws(
    () => assertUserGrantWithinCeiling(["write"], ["read"], "测试授予"),
    /测试授予超出允许范围/,
  );
});

async function main() {
  for (const t of tests) {
    t.fn();
    console.log(`ok ${t.name}`);
  }
  console.log(`\n${tests.length} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
