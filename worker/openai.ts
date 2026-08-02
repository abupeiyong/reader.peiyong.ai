// OpenAI 接入(gpt-5-nano):用于查词 / 本页解析 / AI 对话。
// 通过标准 Chat Completions API 调用;配置 OPENAI_API_KEY 后启用,
// 否则上层自动回退 Workers AI(Llama)→ mock。
// 想经 Cloudflare AI Gateway 统一记录/限流,只需把 OPENAI_BASE_URL 指向
// gateway 的 openai 兼容端点即可,代码无需改动。
import type { Env } from "./env";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

const DEFAULT_MODEL = "gpt-5-nano";
const DEFAULT_BASE = "https://api.openai.com/v1";

export function openaiEnabled(env: Env): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

function chatUrl(env: Env): string {
  return `${(env.OPENAI_BASE_URL || DEFAULT_BASE).replace(/\/$/, "")}/chat/completions`;
}

interface ChatOpts {
  maxTokens?: number;
  json?: boolean;
  /** gpt-5 系列输出详略;查词等短输出场景用 "low" 降延迟 */
  verbosity?: "low" | "medium" | "high";
}

/** 非流式:返回助手文本;失败返回 null 让上层回退 */
export async function openaiChat(env: Env, messages: Msg[], opts: ChatOpts = {}): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const res = await fetch(chatUrl(env), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL || DEFAULT_MODEL,
        messages,
        // gpt-5 系列为推理模型:用 max_completion_tokens,并以 minimal 推理换取低延迟
        max_completion_tokens: opts.maxTokens ?? 1024,
        reasoning_effort: "minimal",
        ...(opts.verbosity ? { verbosity: opts.verbosity } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) {
      console.warn("OpenAI chat 失败:", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.warn("OpenAI chat 异常:", (e as Error).message);
    return null;
  }
}

/** 流式:返回纯文本 chunk 流;不可用返回 null 让上层回退 */
export async function openaiChatStream(env: Env, messages: Msg[], maxTokens = 1200): Promise<ReadableStream<string> | null> {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const res = await fetch(chatUrl(env), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL || DEFAULT_MODEL,
        messages,
        max_completion_tokens: maxTokens,
        reasoning_effort: "minimal",
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      console.warn("OpenAI stream 失败:", res.status, (await res.text().catch(() => "")).slice(0, 300));
      return null;
    }
    return parseOpenAISSE(res.body);
  } catch (e) {
    console.warn("OpenAI stream 异常:", (e as Error).message);
    return null;
  }
}

/** 解析 OpenAI SSE(data: {"choices":[{"delta":{"content":"..."}}]})为纯文本流 */
function parseOpenAISSE(input: ReadableStream<Uint8Array>): ReadableStream<string> {
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
              const obj = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
              const delta = obj.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(delta);
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
