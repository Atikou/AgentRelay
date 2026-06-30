import type { CompanionVectorStatus } from "./types.js";

export function companionVectorStatus(storageRoot: string): CompanionVectorStatus {
  return {
    enabled: false,
    namespace: `companion:${storageRoot}`,
    reason: "MVP 使用摘要压缩；LanceDB 向量召回为后续增强。",
  };
}

