import { mkdirSync } from "node:fs";
import path from "node:path";

import { matchesTagFilter } from "./contextTags.js";
import { EMBEDDING_DIMENSION } from "./EmbeddingService.js";
import type { MemoryScope, SemanticItem } from "./types.js";

export interface VectorSearchFilter {
  scope?: MemoryScope;
  scopeId?: string;
  itemType?: SemanticItem["itemType"];
  /** 至少命中其一的标签。 */
  tags?: string[];
}

export interface VectorStore {
  addItem(item: SemanticItem): Promise<void>;
  search(queryVector: number[], filter: VectorSearchFilter | undefined, topK: number): Promise<SemanticItem[]>;
  deleteItem(id: string): Promise<void>;
  deleteBySource(sourceId: string): Promise<void>;
  updateItem(item: SemanticItem): Promise<void>;
}

type LanceRow = {
  id: string;
  item_type: string;
  scope: string;
  scope_id: string;
  source_id: string;
  content: string;
  summary: string;
  vector: Float32Array;
  tags: string;
  created_at: string;
  updated_at: string;
};

/** 内存向量库：单测与 LanceDB 不可用时的回退。 */
export class InMemoryVectorStore implements VectorStore {
  private readonly items = new Map<string, SemanticItem>();

  async addItem(item: SemanticItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async search(
    queryVector: number[],
    filter: VectorSearchFilter | undefined,
    topK: number,
  ): Promise<SemanticItem[]> {
    const scored: Array<{ item: SemanticItem; score: number }> = [];
    for (const item of this.items.values()) {
      if (filter?.scope && item.scope !== filter.scope) continue;
      if (filter?.scopeId && item.scopeId !== filter.scopeId) continue;
      if (filter?.itemType && item.itemType !== filter.itemType) continue;
      if (!matchesTagFilter(item.tags, filter?.tags)) continue;
      scored.push({ item, score: cosine(queryVector, item.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.item);
  }

  async deleteItem(id: string): Promise<void> {
    this.items.delete(id);
  }

  async deleteBySource(sourceId: string): Promise<void> {
    for (const [id, item] of this.items) {
      if (item.sourceId === sourceId) this.items.delete(id);
    }
  }

  async updateItem(item: SemanticItem): Promise<void> {
    this.items.set(item.id, item);
  }

  listAll(): SemanticItem[] {
    return [...this.items.values()];
  }
}

/** LanceDB 表损坏 / 维度不一致等可恢复错误。 */
function isLanceRecoverableError(err: unknown): boolean {
  const msg = String(err);
  return /vector column|dimension|query stream|GenericFailure|panicked|arrow-data|Invalid input/i.test(
    msg,
  );
}

function toFloatVector(values: number[] | Float32Array, dim: number): Float32Array {
  const out = new Float32Array(dim);
  const n = Math.min(values.length, dim);
  for (let i = 0; i < n; i += 1) {
    out[i] = values[i]!;
  }
  return out;
}

/** LanceDB 向量存储（数据目录下 lancedb/）。 */
export class LanceDbVectorStore implements VectorStore {
  private tablePromise: Promise<import("@lancedb/lancedb").Table> | null = null;

  constructor(
    private readonly lanceDir: string,
    private readonly vectorDim: number = EMBEDDING_DIMENSION,
  ) {
    mkdirSync(lanceDir, { recursive: true });
  }

  private zeroVector(): Float32Array {
    return new Float32Array(this.vectorDim);
  }

  private async getDb(): Promise<import("@lancedb/lancedb").Connection> {
    const lancedb = await import("@lancedb/lancedb");
    return lancedb.connect(this.lanceDir);
  }

  private async getTable(): Promise<import("@lancedb/lancedb").Table> {
    if (!this.tablePromise) {
      this.tablePromise = this.openTable();
    }
    return this.tablePromise;
  }

  private invalidateTable(): void {
    this.tablePromise = null;
  }

  private async openTable(): Promise<import("@lancedb/lancedb").Table> {
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes("semantic_items")) {
      const table = await db.openTable("semantic_items");
      if (await this.validateTableHealth(table)) {
        return table;
      }
      await db.dropTable("semantic_items");
    }
    return this.createTable(db);
  }

  private async createTable(
    db: import("@lancedb/lancedb").Connection,
  ): Promise<import("@lancedb/lancedb").Table> {
    const seed: LanceRow[] = [
      {
        id: "__schema_seed__",
        item_type: "memory",
        scope: "global",
        scope_id: "",
        source_id: "__schema_seed__",
        content: "",
        summary: "",
        vector: this.zeroVector(),
        tags: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    const table = await db.createTable("semantic_items", seed);
    await table.delete('id = "__schema_seed__"');
    return table;
  }

  /** 读一行 + 向量检索；旧表若含损坏 fragment 会在此失败。 */
  private async validateTableHealth(
    table: import("@lancedb/lancedb").Table,
  ): Promise<boolean> {
    try {
      await table.query().limit(1).toArray();
      await table.vectorSearch(this.zeroVector()).limit(1).toArray();
      return true;
    } catch {
      return false;
    }
  }

  private async resetTable(): Promise<import("@lancedb/lancedb").Table> {
    this.invalidateTable();
    const db = await this.getDb();
    const names = await db.tableNames();
    if (names.includes("semantic_items")) {
      await db.dropTable("semantic_items");
    }
    const table = await this.createTable(db);
    this.tablePromise = Promise.resolve(table);
    return table;
  }

  async addItem(item: SemanticItem): Promise<void> {
    const row = toRow(item, this.vectorDim);
    try {
      const table = await this.getTable();
      await table.add([row]);
    } catch (err) {
      if (!isLanceRecoverableError(err)) throw err;
      const table = await this.resetTable();
      await table.add([row]);
    }
  }

  async search(
    queryVector: number[],
    filter: VectorSearchFilter | undefined,
    topK: number,
  ): Promise<SemanticItem[]> {
    const query = toFloatVector(queryVector, this.vectorDim);
    try {
      return await this.searchInner(query, filter, topK);
    } catch (err) {
      if (!isLanceRecoverableError(err)) throw err;
      await this.resetTable();
      return [];
    }
  }

  private async searchInner(
    queryVector: Float32Array,
    filter: VectorSearchFilter | undefined,
    topK: number,
  ): Promise<SemanticItem[]> {
    const table = await this.getTable();
    let query = table.vectorSearch(queryVector).limit(topK);
    const clauses: string[] = [];
    if (filter?.scope) clauses.push(`scope = '${filter.scope}'`);
    if (filter?.scopeId) clauses.push(`scope_id = '${filter.scopeId}'`);
    if (filter?.itemType) clauses.push(`item_type = '${filter.itemType}'`);
    if (clauses.length > 0) {
      query = query.where(clauses.join(" AND "));
    }
    const rows = (await query.toArray()) as LanceRow[];
    return rows.map(fromRow).filter((item) => matchesTagFilter(item.tags, filter?.tags));
  }

  async deleteItem(id: string): Promise<void> {
    try {
      const table = await this.getTable();
      await table.delete(`id = '${id.replace(/'/g, "''")}'`);
    } catch (err) {
      if (!isLanceRecoverableError(err)) throw err;
    }
  }

  async deleteBySource(sourceId: string): Promise<void> {
    try {
      const table = await this.getTable();
      await table.delete(`source_id = '${sourceId.replace(/'/g, "''")}'`);
    } catch (err) {
      if (!isLanceRecoverableError(err)) throw err;
    }
  }

  async updateItem(item: SemanticItem): Promise<void> {
    await this.deleteItem(item.id);
    await this.addItem(item);
  }
}

function toRow(item: SemanticItem, dim: number): LanceRow {
  return {
    id: item.id,
    item_type: item.itemType,
    scope: item.scope,
    scope_id: item.scopeId ?? "",
    source_id: item.sourceId,
    content: item.content,
    summary: item.summary ?? "",
    vector: toFloatVector(item.vector, dim),
    tags: (item.tags ?? []).join(","),
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function fromRow(row: LanceRow): SemanticItem {
  const raw = row.vector as Float32Array | number[];
  const vec = raw instanceof Float32Array ? raw : toFloatVector(raw, raw.length);
  const itemType = row.item_type as SemanticItem["itemType"];
  return {
    id: row.id,
    itemType,
    scope: row.scope as MemoryScope,
    scopeId: row.scope_id || undefined,
    sourceType: itemType,
    sourceId: row.source_id,
    content: row.content,
    summary: row.summary || undefined,
    vector: [...vec],
    tags: row.tags ? row.tags.split(",").filter(Boolean) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function createVectorStore(dataDir: string, useLance = true): VectorStore {
  const lanceDir = path.join(dataDir, "agent_data", "lancedb");
  if (!useLance) return new InMemoryVectorStore();
  try {
    return new LanceDbVectorStore(lanceDir, EMBEDDING_DIMENSION);
  } catch {
    return new InMemoryVectorStore();
  }
}
