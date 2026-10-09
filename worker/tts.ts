// 语音合成的统一入口:R2 持久缓存 → ElevenLabs(eleven_v3)→ Workers AI melotts。
// 网页端 /api/tts 与 Telegram 复习卡片共用,同一 (口音, 文本) 的音频跨端复用。
// 单词/短语另走 wordMp3:先取有道词典录音,取不到才落回上面这条合成链路。
import type { Env } from "./env";
import { elevenTts, voiceTag } from "./elevenlabs";
import { youdaoVoice } from "./youdao";
import { ttsAudio } from "./ai";
import { sha256Hex } from "./util";

export type Accent = "US" | "GB";

export async function ttsCacheKey(env: Env, text: string, accent: Accent): Promise<string> {
  const norm = text.trim().replace(/\s+/g, " ").toLowerCase();
  return `tts/${accent}${voiceTag(env, accent)}/${await sha256Hex(norm)}.mp3`;
}

/**
 * 取(或合成)mp3 字节;没有任何可用 provider 时返回 null。
 * 只缓存 ElevenLabs 结果;melotts 兜底不缓存,恢复后自动升级音质。
 * 传了 waitUntil 则缓存写入不阻塞返回(HTTP 请求里用),否则等写完(cron 里用)。
 */
export async function speechMp3(
  env: Env,
  text: string,
  accent: Accent = "US",
  waitUntil?: (p: Promise<unknown>) => void
): Promise<Uint8Array | null> {
  if (!text.trim()) return null;
  const key = await ttsCacheKey(env, text, accent);
  const cached = await env.BUCKET.get(key).catch(() => null);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  const eleven = await elevenTts(env, text, accent);
  if (eleven) {
    const write = env.BUCKET.put(key, eleven, { httpMetadata: { contentType: "audio/mpeg" } })
      .then(() => undefined)
      .catch((e) => console.warn("TTS 缓存写入失败:", (e as Error).message));
    if (waitUntil) waitUntil(write);
    else await write;
    return eleven;
  }
  return ttsAudio(env, text);
}

/**
 * 单词/短语发音:有道词典录音优先(真人词典音,免密钥),失败再走上面的合成链路。
 * 句子/段落朗读不走这里,仍直接用 speechMp3。
 */
export async function wordMp3(
  env: Env,
  word: string,
  accent: Accent = "US",
  waitUntil?: (p: Promise<unknown>) => void
): Promise<Uint8Array | null> {
  if (!word.trim()) return null;
  const youdao = await youdaoVoice(word, accent);
  if (youdao) return youdao;
  return speechMp3(env, word, accent, waitUntil);
}
