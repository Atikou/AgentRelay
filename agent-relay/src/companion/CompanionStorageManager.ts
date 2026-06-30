import path from "node:path";

import { CompanionStorage } from "./CompanionStorage.js";

export class CompanionStorageManager {
  private readonly cache = new Map<string, CompanionStorage>();

  constructor(private readonly projectRoot: string) {}

  resolveStorageRoot(input?: string): string {
    const raw = input?.trim();
    if (!raw) return path.join(this.projectRoot, ".agentrelay", "companion");
    return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.projectRoot, raw);
  }

  get(input?: string): CompanionStorage {
    const root = this.resolveStorageRoot(input);
    const cached = this.cache.get(root);
    if (cached) return cached;
    const storage = new CompanionStorage(root);
    this.cache.set(root, storage);
    return storage;
  }

  closeAll(): void {
    for (const storage of this.cache.values()) {
      storage.close();
    }
    this.cache.clear();
  }
}

