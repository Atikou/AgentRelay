/** pending planHandoff 时，用户短句表达「继续执行计划」的识别（优先于 IntentRouter）。 */
const PLAN_HANDOFF_FOLLOW_UP_RE =
  /^(继续|接着|开始|执行|按(这个|上面|计划)|就这样|好的|ok|go|开始做|开始吧|按方案|按计划)/i;

export function isPlanHandoffFollowUpMessage(message?: string): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;
  if (text.length > 48) return false;
  return PLAN_HANDOFF_FOLLOW_UP_RE.test(text);
}
