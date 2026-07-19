// ElevenLabs TTS(eleven_v3)。配置 ELEVENLABS_API_KEY 后启用,
// 否则上层回退 Workers AI melotts → 浏览器合成。
import type { Env } from "./env";

const BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_MODEL = "eleven_v3";
// ElevenLabs 官方 premade voices(所有账号可用)
const DEFAULT_VOICE_US = "Gfpl8Yo74Is0W6cPUWWT"; // Rachel(美音)
const DEFAULT_VOICE_UK = "Fahco4VZzobUeiPqni1S"; // George(英音)

export function elevenEnabled(env: Env): boolean {
  return Boolean(env.ELEVENLABS_API_KEY);
}

export async function elevenTts(env: Env, text: string, accent: "US" | "GB"): Promise<Uint8Array | null> {
  if (!env.ELEVENLABS_API_KEY) return null;
  const voice =
    accent === "GB"
      ? env.ELEVENLABS_VOICE_UK || DEFAULT_VOICE_UK
      : env.ELEVENLABS_VOICE_US || DEFAULT_VOICE_US;
  const model = env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL;
  try {
    const res = await fetch(`${BASE}/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: model }),
    });
    if (!res.ok) {
      console.warn("ElevenLabs TTS 失败:", res.status, (await res.text().catch(() => "")).slice(0, 300));
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    console.warn("ElevenLabs TTS 异常:", (e as Error).message);
    return null;
  }
}
