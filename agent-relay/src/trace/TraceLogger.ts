import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";

export interface TraceEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * 追加式 JSONL 事件日志。用于记录模型调用、路由决策等可观测事件，便于复盘。
 */
export class TraceLogger {
  private readonly stream: WriteStream;

  constructor(traceFile: string) {
    mkdirSync(path.dirname(traceFile), { recursive: true });
    this.stream = createWriteStream(traceFile, { flags: "a", encoding: "utf-8" });
  }

  write(event: TraceEvent): void {
    this.stream.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}
