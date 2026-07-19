export function uid(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix ? `${prefix}_${hex}` : hex;
}

export function now(): number {
  return Date.now();
}

/** 从 AI 返回的文本中尽力解析出 JSON 对象 */
export function extractJson<T>(text: string): T | null {
  // 去掉 markdown 代码块包裹
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 把英文文本切成句子(简单规则,MVP 够用) */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function tokenizeWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z']+/g) || []).filter((w) => w.length > 0);
}
