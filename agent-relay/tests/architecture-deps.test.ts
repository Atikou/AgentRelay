/**
 * 架构依赖自检：确保 src 内部 TypeScript import 图没有循环依赖。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function normalizeForReport(file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

function resolveImport(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const asFile = path.normalize(path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ".ts")));
  if (fileSet.has(asFile)) return asFile;
  const asIndex = path.normalize(path.resolve(path.dirname(fromFile), specifier, "index.ts"));
  if (fileSet.has(asIndex)) return asIndex;
  return undefined;
}

async function buildImportGraph(): Promise<Map<string, string[]>> {
  const files = await walk(root);
  const fileSet = new Set(files.map((file) => path.normalize(file)));
  const graph = new Map<string, string[]>();
  const importPattern =
    /import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["']|export\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g;

  for (const file of files) {
    const text = await readFile(file, "utf-8");
    const deps = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(text))) {
      const resolved = resolveImport(file, match[1] ?? match[2] ?? "", fileSet);
      if (resolved) deps.add(resolved);
    }
    graph.set(path.normalize(file), [...deps]);
  }
  return graph;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexes = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const cycles: string[][] = [];

  function visit(node: string): void {
    indexes.set(node, index);
    lowlinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const dep of graph.get(node) ?? []) {
      if (!indexes.has(dep)) {
        visit(dep);
        lowlinks.set(node, Math.min(lowlinks.get(node)!, lowlinks.get(dep)!));
      } else if (onStack.has(dep)) {
        lowlinks.set(node, Math.min(lowlinks.get(node)!, indexes.get(dep)!));
      }
    }

    if (lowlinks.get(node) !== indexes.get(node)) return;

    const component: string[] = [];
    let dep: string | undefined;
    do {
      dep = stack.pop();
      if (!dep) break;
      onStack.delete(dep);
      component.push(dep);
    } while (dep !== node);

    if (component.length > 1) {
      cycles.push(component.map(normalizeForReport).sort());
    }
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) visit(node);
  }
  return cycles.sort((a, b) => a.join("|").localeCompare(b.join("|")));
}

const graph = await buildImportGraph();
const cycles = findCycles(graph);

assert.deepEqual(cycles, []);
console.log(`architecture-deps: ${graph.size} files checked, 0 cycles`);
