// 有道词典发音(dictvoice):单词/短语的词典录音,免密钥、无需配置。
// 查不到音的词会返回 500(body 是 `returned null audio` 的 JSON),这时返回 null,
// 由上层回退 ElevenLabs → melotts → 浏览器合成。

const BASE = "https://dict.youdao.com/dictvoice";
const MAX_LEN = 64; // 词典录音只适合单词/短语,长文本一律交给 TTS

/** 取单词/短语的有道发音 mp3;不可用(查不到 / 网络异常 / 文本过长)时返回 null */
export async function youdaoVoice(text: string, accent: "US" | "GB"): Promise<Uint8Array | null> {
  const word = text.trim().replace(/\s+/g, " ");
  if (!word || word.length > MAX_LEN) return null;
  const type = accent === "GB" ? 1 : 2; // 1 = 英音,2 = 美音
  try {
    const res = await fetch(`${BASE}?audio=${encodeURIComponent(word)}&type=${type}`);
    if (!res.ok || !(res.headers.get("Content-Type") ?? "").includes("audio")) {
      console.warn("有道发音失败:", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength > 0 ? bytes : null;
  } catch (e) {
    console.warn("有道发音异常:", (e as Error).message);
    return null;
  }
}
