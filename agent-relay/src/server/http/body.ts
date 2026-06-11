import type { IncomingMessage } from "node:http";

import { HttpError } from "./response.js";

export async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HttpError(413, `请求体过大，最大允许 ${maxBodyBytes} 字节`);
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buf.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new HttpError(413, `请求体过大，最大允许 ${maxBodyBytes} 字节`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}
