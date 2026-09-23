// LLM 提供商:OpenAI 与 DeepSeek —— 两家都是 OpenAI 兼容的 Chat Completions 协议,
// 所以共用 openai.ts 里的客户端,这里只负责「用哪家、哪个模型、哪把 key」。
//
// key 的优先级:设置页填的(users 表)> 部署时的环境变量 secret。
// 选中的提供商没有 key 时 resolveProvider 返回 null,上层照旧回退 Workers AI → mock。
import type { Env } from "./env";
import { now } from "./util";
import type { AiCallKind, AiProviderId } from "../shared/types";

interface Spec {
  label: string;
  base: string;
  model: string;
  models: string[]; // 设置页可选的模型(服务端也用它校验)
}

export const PROVIDERS: Record<AiProviderId, Spec> = {
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    model: "gpt-5-nano",
    models: ["gpt-5-nano", "gpt-5-mini", "gpt-5"],
  },
  deepseek: {
    label: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as AiProviderId[];
export const DEFAULT_PROVIDER: AiProviderId = "openai";

export function isProviderId(v: unknown): v is AiProviderId {
  return typeof v === "string" && (PROVIDER_IDS as string[]).includes(v);
}

export interface ProviderConfig {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/** users 表里与 AI 提供商相关的几列 */
export interface AiSettingsRow {
  ai_provider: string | null;
  ai_model: string | null;
  openai_api_key: string | null;
  deepseek_api_key: string | null;
}

export function loadAiSettings(env: Env, userId: string): Promise<AiSettingsRow | null> {
  return env.DB.prepare(
    "SELECT ai_provider, ai_model, openai_api_key, deepseek_api_key FROM users WHERE id = ?"
  )
    .bind(userId)
    .first<AiSettingsRow>();
}

export function userKey(row: AiSettingsRow | null, p: AiProviderId): string {
  return ((p === "deepseek" ? row?.deepseek_api_key : row?.openai_api_key) ?? "").trim();
}

export function envKey(env: Env, p: AiProviderId): string {
  return ((p === "deepseek" ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY) ?? "").trim();
}

/** 环境变量里的默认模型(没配就用内置默认) */
export function envModel(env: Env, p: AiProviderId): string {
  return (p === "deepseek" ? env.DEEPSEEK_CHAT_MODEL : env.OPENAI_CHAT_MODEL) || PROVIDERS[p].model;
}

function envBase(env: Env, p: AiProviderId): string {
  return (p === "deepseek" ? env.DEEPSEEK_BASE_URL : env.OPENAI_BASE_URL) || PROVIDERS[p].base;
}

export function activeProvider(row: AiSettingsRow | null): AiProviderId {
  return isProviderId(row?.ai_provider) ? row.ai_provider : DEFAULT_PROVIDER;
}

/**
 * 当前生效的模型。ai_model 只在属于该提供商时才认:
 * 换提供商后残留的旧模型名不会被带过去(否则请求必然 400)。
 */
export function activeModel(env: Env, row: AiSettingsRow | null, p: AiProviderId): string {
  const chosen = (row?.ai_model ?? "").trim();
  return chosen && PROVIDERS[p].models.includes(chosen) ? chosen : envModel(env, p);
}

export function providerConfig(env: Env, row: AiSettingsRow | null, p: AiProviderId): ProviderConfig | null {
  const apiKey = userKey(row, p) || envKey(env, p);
  if (!apiKey) return null;
  return { provider: p, model: activeModel(env, row, p), apiKey, baseUrl: envBase(env, p) };
}

/** 该用户当前该用哪家/哪个模型/哪把 key;没有可用 key 返回 null */
export async function resolveProvider(env: Env, userId: string | null): Promise<ProviderConfig | null> {
  const row = userId ? await loadAiSettings(env, userId).catch(() => null) : null;
  return providerConfig(env, row, activeProvider(row));
}

/** 单次调用的延迟日志(AI 统计页用),失败不影响主流程 */
export function logAiCall(
  env: Env,
  row: {
    userId: string | null;
    provider: string;
    model: string;
    kind: AiCallKind;
    latencyMs: number;
    ok: boolean;
    stream?: boolean;
  }
) {
  return env.DB.prepare(
    "INSERT INTO ai_calls (user_id, provider, model, kind, latency_ms, ok, stream, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      row.userId,
      row.provider,
      row.model,
      row.kind,
      Math.max(0, Math.round(row.latencyMs)),
      row.ok ? 1 : 0,
      row.stream ? 1 : 0,
      now()
    )
    .run()
    .catch((e) => console.warn("ai_calls 记录失败:", (e as Error).message));
}
