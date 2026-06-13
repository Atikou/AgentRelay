/**
 * import/export 解析自检。
 * 运行：npm run test:import-export-parser
 */
import assert from "node:assert/strict";

import {
  attachResolvedImportPaths,
  extractExportsFromContent,
  extractImportsFromContent,
  resolveImportSpec,
} from "../src/context/importExportParser.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("extractImportsFromContent 识别 esm 与 export from", () => {
  const imports = extractImportsFromContent(
    "src/a.ts",
    "import { x } from './b.js';\nexport { y } from '../c';\n",
  );
  assert.ok(imports.some((i) => i.importSpec === "./b.js" && i.kind === "esm"));
  assert.ok(imports.some((i) => i.importSpec === "../c" && i.kind === "export_from"));
});

test("extractExportsFromContent 识别 named/default export", () => {
  const exports = extractExportsFromContent(
    "src/a.ts",
    "export class Foo {}\nexport default function bar() {}\n",
  );
  assert.ok(exports.some((e) => e.exportName === "Foo" && e.kind === "named"));
  assert.ok(exports.some((e) => e.exportName === "default" && e.kind === "default"));
});

test("resolveImportSpec 解析相对路径到已知文件", () => {
  const known = new Set(["src/plan/PlanCompiler.ts", "src/util/helper.ts"]);
  assert.equal(
    resolveImportSpec("src/plan/PlanRunner.ts", "./PlanCompiler", known),
    "src/plan/PlanCompiler.ts",
  );
  assert.equal(
    resolveImportSpec("src/plan/PlanRunner.ts", "../util/helper", known),
    "src/util/helper.ts",
  );
});

test("attachResolvedImportPaths 填充 resolvedPath", () => {
  const known = new Set(["src/x.ts"]);
  const resolved = attachResolvedImportPaths(
    extractImportsFromContent("src/y.ts", "import { a } from './x';\n"),
    known,
  );
  assert.equal(resolved[0]?.resolvedPath, "src/x.ts");
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${t.name}`);
    console.error(error);
  }
}
console.log(`\nimport-export-parser: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
