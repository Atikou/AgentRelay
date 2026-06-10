import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";

import { redactValue } from "../util/redact.js";

export interface TraceEvent {
  type: string;
  [key: string]: unknown;
}

export interface TraceLoggerOptions {
  /** 写入前脱敏（默认 true）。 */
  redact?: boolean;
}

/**
 * 追加式 JSONL 事件日志。用于记录模型调用、路由决策等可观测事件，便于复盘。
 */
export class TraceLogger {
  private readonly stream: WriteStream;
  private readonly redact: boolean;

  constructor(traceFile: string, options: TraceLoggerOptions = {}) {
    mkdirSync(path.dirname(traceFile), { recursive: true });
    this.stream = createWriteStream(traceFile, { flags: "a", encoding: "utf-8" });
    this.redact = options.redact !== false;
  }

  write(event: TraceEvent): void {
    const payload = this.redact ? redactValue(event) : event;
    this.stream.write(`${JSON.stringify({ time: new Date().toISOString(), ...payload })}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}
