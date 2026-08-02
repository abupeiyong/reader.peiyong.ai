// AI 能力抽象层:优先 Workers AI,不可用时(本地未登录 Cloudflare 等)自动回退到
// 确定性的 mock 实现,保证整条产品链路在本地可跑通。上线后无需改代码。
import type { Env } from "./env";
import type { PageAnalysis, WordExplanation } from "../shared/types";
import { extractJson } from "./util";
import { openaiChat, openaiChatStream } from "./openai";

// 流式聊天兜底仍用 llama(gpt-oss 流式为 Responses 事件流,解析格式不同,暂不切)
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// 非流式兜底:gpt-oss-120b,实测比 llama-70b 快(~1.7s vs 3.3-4.1s)且质量更好
const FALLBACK_MODEL = "@cf/openai/gpt-oss-120b";
const WHISPER_MODEL = "@cf/openai/whisper";

type Msg = { role: "system" | "user" | "assistant"; content: string };

// 文本生成:优先 OpenAI(gpt-5-nano)→ 回退 Workers AI(gpt-oss-120b)→ null(上层用 mock)
async function runLLM(
  env: Env,
  messages: Msg[],
  maxTokens = 1024,
  json = false,
  verbosity?: "low" | "medium" | "high"
): Promise<string | null> {
  const oa = await openaiChat(env, messages, { maxTokens, json, verbosity });
  if (oa != null) return oa;
  try {
    if (!env.AI) throw new Error("本地开发无 AI 绑定");
    // gpt-oss 走 Responses 风格:input 纯文本;输出在 output[].content[].text
    const input = messages
      .map((m) => (m.role === "system" ? `[系统指令]\n${m.content}` : m.content))
      .join("\n\n");
    const res = (await env.AI.run(FALLBACK_MODEL as Parameters<Ai["run"]>[0], {
      input,
      reasoning: { effort: "low" },
    })) as {
      output_text?: string;
      output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    };
    const msg = res?.output?.find((o) => o.type === "message");
    const text = res?.output_text ?? msg?.content?.map((c) => c.text ?? "").join("");
    return text?.trim() ? text : null;
  } catch (e) {
    console.warn("Workers AI 不可用,回退 mock:", (e as Error).message);
    return null;
  }
}

// ---------- 单词解释 ----------

export async function explainWord(
  env: Env,
  word: string,
  sentence: string,
  level: string
): Promise<WordExplanation> {
  // 精简 prompt + verbosity low:输出 token 是延迟主因,实测比长版快 ~35%
  const prompt = `英语助手,用户水平 ${level}。结合句子解释单词,只返回 JSON:
{"word":"原词","phonetic":"IPA 音标","pos":"本句词性","meaning_zh":"语境中文释义","meaning_in_context":"这句里的含义,中文1句","collocations":["2-3个常见搭配"],"forms":["主要词形变化"],"examples":["1个短英文例句(附中文)"]}
单词:"${word}" 句子:"${sentence}"`;
  const text = await runLLM(env, [{ role: "user", content: prompt }], 500, true, "low");
  if (text) {
    const parsed = extractJson<WordExplanation>(text);
    if (parsed && parsed.word) return { ...parsed, source: "ai" };
  }
  return mockExplainWord(word, sentence);
}

function mockExplainWord(word: string, sentence: string): WordExplanation {
  return {
    word,
    phonetic: `/${word.toLowerCase()}/`,
    pos: "n./v./adj.(离线模式无法判断)",
    meaning_zh: `「${word}」的语境释义(离线模拟)`,
    meaning_in_context: `离线模拟模式:AI 服务当前不可用。它在句子「${sentence.slice(0, 80)}${sentence.length > 80 ? "…" : ""}」中的含义需联网 AI 生成。部署到 Cloudflare 或登录 wrangler 后将自动启用真实解释。`,
    collocations: [`${word.toLowerCase()} + sth`, `make ${word.toLowerCase()}`],
    forms: [word.toLowerCase(), word.toLowerCase() + "s"],
    examples: [`This is an example sentence with "${word}". (这是一个包含该词的例句。)`],
    source: "mock",
  };
}

// ---------- 本页解析 ----------

export async function analyzePage(env: Env, pageText: string, level: string): Promise<PageAnalysis> {
  const truncated = pageText.slice(0, 6000);
  const prompt = `你是英语阅读助手。用户英语水平:${level}。分析下面这一页英文文本,帮助中文母语者学习。只返回 JSON,不要多余文字,格式:
{
  "vocabulary": [{"word": "该水平学习者可能不认识的词(5-10个)", "phonetic": "/音标/", "meaning": "本页语境下的中文释义"}],
  "phrases": [{"phrase": "常用短语或固定搭配(3-6个)", "meaning": "中文含义"}],
  "sentences": [{"sentence": "本页中的长难句(1-3句,原文摘录)", "explanation": "中文解析:结构+含义"}],
  "background": "本页涉及的背景知识或延伸说明(中文,2-4句;没有就写空字符串)"
}

页面文本:
"""
${truncated}
"""`;
  const text = await runLLM(env, [{ role: "user", content: prompt }], 1600, true);
  if (text) {
    const parsed = extractJson<PageAnalysis>(text);
    if (parsed && Array.isArray(parsed.vocabulary)) {
      return {
        vocabulary: parsed.vocabulary ?? [],
        phrases: parsed.phrases ?? [],
        sentences: parsed.sentences ?? [],
        background: parsed.background ?? "",
        source: "ai",
      };
    }
  }
  return mockAnalyzePage(pageText);
}

function mockAnalyzePage(pageText: string): PageAnalysis {
  // 离线模拟:挑选较长的词作为"可能生词",让链路可视化跑通
  const words = [...new Set(pageText.toLowerCase().match(/[a-z]{8,}/g) || [])].slice(0, 8);
  const sentences = pageText
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.split(" ").length > 22)
    .slice(0, 2);
  return {
    vocabulary: words.map((w) => ({ word: w, phonetic: "", meaning: "(离线模拟)联网后生成语境释义" })),
    phrases: [],
    sentences: sentences.map((s) => ({ sentence: s, explanation: "(离线模拟)较长句子,联网后生成结构解析" })),
    background: "离线模拟模式:AI 服务当前不可用,以上为规则挑选的候选生词/长句。部署或登录 wrangler 后自动启用真实分析。",
    source: "mock",
  };
}

// ---------- 聊天(流式) ----------

export async function chatStream(env: Env, messages: Msg[]): Promise<{ stream: ReadableStream<string>; source: "ai" | "mock" }> {
  // 优先 OpenAI(gpt-5-nano)流式
  const oaStream = await openaiChatStream(env, messages, 1200);
  if (oaStream) return { stream: oaStream, source: "ai" };
  // 回退 Workers AI(Llama)流式
  try {
    if (!env.AI) throw new Error("本地开发无 AI 绑定");
    const res = (await env.AI.run(CHAT_MODEL as Parameters<Ai["run"]>[0], {
      messages,
      max_tokens: 1200,
      stream: true,
    })) as unknown as ReadableStream<Uint8Array>;
    return { stream: parseSSEToText(res), source: "ai" };
  } catch (e) {
    console.warn("Workers AI 流式不可用,回退 mock:", (e as Error).message);
    return { stream: mockChatStream(messages), source: "mock" };
  }
}

/** Workers AI 流式返回 SSE 字节流(data: {"response":"..."}),转成纯文本 chunk 流 */
function parseSSEToText(input: ReadableStream<Uint8Array>): ReadableStream<string> {
  const decoder = new TextDecoder();
  let buf = "";
  return new ReadableStream<string>({
    async start(controller) {
      const reader = input.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload) as { response?: string };
              if (obj.response) controller.enqueue(obj.response);
            } catch {
              /* 忽略不完整行 */
            }
          }
        }
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

function mockChatStream(messages: Msg[]): ReadableStream<string> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  const pageMatch = sys.match(/第\s*(\d+)\s*页/);
  const page = pageMatch ? pageMatch[1] : "1";
  const reply =
    `(离线模拟回答)你的问题是:「${lastUser.slice(0, 60)}${lastUser.length > 60 ? "…" : ""}」。` +
    `当前处于离线模拟模式,AI 服务不可用,无法真正分析文档内容。` +
    `联网部署后,我会结合原文回答并附上引用,例如 [p.${page}] 这样的页码引用可以点击跳回原文。` +
    `你可以尝试:解释这句话、总结本页、考考我。`;
  const chunks = reply.match(/.{1,6}/g) ?? [reply];
  let i = 0;
  return new ReadableStream<string>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 30));
      controller.enqueue(chunks[i++]);
    },
  });
}

// ---------- 向量嵌入(Vectorize 检索用) ----------

const EMBED_MODEL = "@cf/baai/bge-m3"; // 多语言:支持中文提问检索英文原文

export async function embedTexts(env: Env, texts: string[]): Promise<number[][] | null> {
  try {
    if (!env.AI) throw new Error("本地开发无 AI 绑定");
    const res = (await env.AI.run(EMBED_MODEL as Parameters<Ai["run"]>[0], {
      text: texts,
    })) as { data?: number[][] };
    if (!res?.data || res.data.length !== texts.length) return null;
    return res.data;
  } catch (e) {
    console.warn("嵌入模型不可用:", (e as Error).message);
    return null;
  }
}

// ---------- 云端 TTS(melotts) ----------

const TTS_MODEL = "@cf/myshell-ai/melotts";

export async function ttsAudio(env: Env, text: string): Promise<Uint8Array | null> {
  try {
    if (!env.AI) throw new Error("本地开发无 AI 绑定");
    const res = (await env.AI.run(TTS_MODEL as Parameters<Ai["run"]>[0], {
      prompt: text,
      lang: "en",
    })) as { audio?: string } | ReadableStream;
    if (res instanceof ReadableStream) {
      const buf = await new Response(res).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (res?.audio) {
      const bin = atob(res.audio);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    return null;
  } catch (e) {
    console.warn("TTS 不可用:", (e as Error).message);
    return null;
  }
}

// ---------- OCR(视觉模型) ----------

const VISION_MODELS = ["@cf/meta/llama-3.2-11b-vision-instruct", "@cf/llava-hf/llava-1.5-7b-hf"];

export async function ocrImage(env: Env, image: ArrayBuffer): Promise<string | null> {
  if (!env.AI) return null;
  const prompt =
    "Transcribe ALL text visible in this scanned page image, preserving paragraph breaks. Output ONLY the transcribed text, no commentary.";
  for (const model of VISION_MODELS) {
    try {
      const res = (await env.AI.run(model as Parameters<Ai["run"]>[0], {
        image: [...new Uint8Array(image)],
        prompt,
        max_tokens: 1500,
      })) as { response?: unknown; description?: string };
      const out = res?.response ?? res?.description;
      if (typeof out === "string" && out.trim()) return out.trim();
    } catch (e) {
      console.warn(`OCR 模型 ${model} 失败:`, (e as Error).message);
    }
  }
  return null;
}

// ---------- 朗读建议(LLM 针对性反馈) ----------

export async function readingAdvice(
  env: Env,
  refText: string,
  transcript: string,
  missed: string[],
  wpm: number | null
): Promise<string | null> {
  const prompt = `用户在跟读英文段落。请给出 2-3 句中文的针对性练习建议(具体到单词发音要点,如元音/重音/连读),不要客套话。
原文:"${refText.slice(0, 400)}"
识别到的朗读:"${transcript.slice(0, 400)}"
未识别到的词:${missed.slice(0, 10).join(", ") || "无"}
语速:${wpm ? `${wpm} 词/分钟` : "未知"}(英语朗读常速约 120-160)`;
  const text = await runLLM(env, [{ role: "user", content: prompt }], 300);
  return text?.trim() || null;
}

// ---------- 语音转写 ----------

export async function transcribeAudio(env: Env, audio: ArrayBuffer): Promise<string | null> {
  try {
    if (!env.AI) throw new Error("本地开发无 AI 绑定");
    const res = (await env.AI.run(WHISPER_MODEL as Parameters<Ai["run"]>[0], {
      audio: [...new Uint8Array(audio)],
    })) as { text?: string };
    return res?.text ?? null;
  } catch (e) {
    console.warn("Whisper 不可用:", (e as Error).message);
    return null;
  }
}
