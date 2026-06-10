/** 敏感字段名（小写匹配）。 */
const SENSITIVE_KEY = /password|secret|api[_-]?key|token|authorization|credential|private[_-]?key/i;

/** 常见密钥 / 令牌模式。 */
const SENSITIVE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /\bsk-[a-zA-Z0-9]{10,}\b/g, replacement: "[REDACTED_KEY]" },
  { re: /\bBearer\s+[A-Za-z0-9._-]+\b/gi, replacement: "Bearer [REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  {
    re: /-----BEGIN[\s\S]*?-----END [A-Z ]+-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    re: /(api[_-]?key|password|secret|token)\s*[=:]\s*['"]?[^\s'"]{4,}/gi,
    replacement: "$1=[REDACTED]",
  },
];

/** 对字符串中的疑似密钥做脱敏。 */
export function redactString(text: string): string {
  let out = text;
  for (const { re, replacement } of SENSITIVE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** 深度脱敏任意 JSON 可序列化值。 */
export function redactValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as T;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactValue(val);
      }
    }
    return out as T;
  }
  return value;
}

/** 工具入参预览：深度脱敏后序列化并截断。 */
export function redactPreview(input: unknown, maxLen = 400): string {
  try {
    const json = JSON.stringify(redactValue(input));
    const trimmed = json.length > maxLen ? `${json.slice(0, maxLen)}…` : json;
    return redactString(trimmed);
  } catch {
    return redactString(String(input).slice(0, maxLen));
  }
}
