// OpenAI 兼容 Chat Completions 客户端:用于查词 / 本页解析 / AI 对话。
// OpenAI(gpt-5 系列)和 DeepSeek 共用这一个客户端,差异只在请求体的几个参数上
// (见 chatBody);用哪家、哪个模型、哪把 key 由 aiprovider.ts 解析。
// 都没配 key 时上层自动回退 Workers AI(Llama)→ mock。
// 想经 Cloudflare AI Gateway 统一记录/限流,只需把 OPENAI_BASE_URL 指向
// gateway 的 openai 兼容端点即可,代码无需改动。
import type { ProviderConfig } from "./aiprovider";

export type Msg = { role: "system" | "user" | "assistant"; content: string };

function chatUrl(cfg: ProviderConfig): string {
  return `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

interface ChatOpts {
  maxTokens?: number;
  json?: boolean;
  /** gpt-5 系列输出详略;查词等短输出场景用 "low" 降延迟 */
  verbosity?: "low" | "medium" | "high";
}

/** 按模型拼请求体:推理模型与普通模型的 token / 推理参数不同名 */
function chatBody(cfg: ProviderConfig, messages: Msg[], opts: ChatOpts, stream: boolean) {
  // gpt-5 系列为推理模型:用 max_completion_tokens,并以 minimal 推理换取低延迟
  const gpt5 = /^gpt-5/.test(cfg.model);
  // deepseek-reasoner 不支持 JSON 模式;没有 response_format 时靠 extractJson 兜底解析
  const jsonMode = opts.json && !/^deepseek-reasoner/.test(cfg.model);
  const maxTokens = opts.maxTokens ?? 1024;
  return {
    model: cfg.model,
    messages,
    ...(gpt5
      ? {
          max_completion_tokens: maxTokens,
          reasoning_effort: "minimal",
          ...(opts.verbosity ? { verbosity: opts.verbosity } : {}),
        }
      : { max_tokens: maxTokens }),
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function chatHeaders(cfg: ProviderConfig): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };
}

/** 非流式:返回助手文本;失败返回 null 让上层回退 */
export async function openaiChat(cfg: ProviderConfig, messages: Msg[], opts: ChatOpts = {}): Promise<string | null> {
  try {
    const res = await fetch(chatUrl(cfg), {
      method: "POST",
      headers: chatHeaders(cfg),
      body: JSON.stringify(chatBody(cfg, messages, opts, false)),
    });
    if (!res.ok) {
      console.warn(`${cfg.provider} chat 失败:`, res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.warn(`${cfg.provider} chat 异常:`, (e as Error).message);
    return null;
  }
}

/** 流式:返回纯文本 chunk 流;不可用返回 null 让上层回退 */
export async function openaiChatStream(
  cfg: ProviderConfig,
  messages: Msg[],
  maxTokens = 1200
): Promise<ReadableStream<string> | null> {
  try {
    const res = await fetch(chatUrl(cfg), {
      method: "POST",
      headers: chatHeaders(cfg),
      body: JSON.stringify(chatBody(cfg, messages, { maxTokens }, true)),
    });
    if (!res.ok || !res.body) {
      console.warn(`${cfg.provider} stream 失败:`, res.status, (await res.text().catch(() => "")).slice(0, 300));
      return null;
    }
    return parseOpenAISSE(res.body);
  } catch (e) {
    console.warn(`${cfg.provider} stream 异常:`, (e as Error).message);
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

/**
 * OpenAI 兼容的 GET /models:拿提供商当前真实支持的模型列表(设置页的下拉用)。
 * 失败返回 null,由上层回退到内置清单。
 */
export async function openaiListModels(
  cfg: Pick<ProviderConfig, "provider" | "apiKey" | "baseUrl">
): Promise<string[] | null> {
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`${cfg.provider} models 失败:`, res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? []).map((m) => (m.id ?? "").trim()).filter(Boolean);
    return ids.length ? ids : null;
  } catch (e) {
    console.warn(`${cfg.provider} models 异常:`, (e as Error).message);
    return null;
  }
}
