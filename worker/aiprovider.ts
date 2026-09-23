// LLM 提供商:OpenAI 与 DeepSeek —— 两家都是 OpenAI 兼容的 Chat Completions 协议,
// 所以共用 openai.ts 里的客户端,这里只负责「用哪家、哪个模型、哪把 key」。
//
// key 的优先级:设置页填的(users 表)> 部署时的环境变量 secret。
// 选中的提供商没有 key 时 resolveProvider 返回 null,上层照旧回退 Workers AI → mock。
import type { Env } from "./env";
import { openaiListModels } from "./openai";
import { now } from "./util";
import type { AiCallKind, AiProviderId } from "../shared/types";

interface Spec {
  label: string;
  base: string;
  model: string;
  models: string[]; // 内置清单:没有 key 或问不到 /models 时的兜底
  /** 属于这家的模型名;OpenAI 的 /models 里混着 embedding/tts,要按这个过滤 */
  owns: RegExp;
  /** 是否向 /models 要实时清单(DeepSeek 只返回对话模型,直接可用) */
  live?: boolean;
}

export const PROVIDERS: Record<AiProviderId, Spec> = {
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    model: "gpt-5-nano",
    models: ["gpt-5-nano", "gpt-5-mini", "gpt-5"],
    owns: /^(gpt|o\d|chatgpt)/i,
  },
  deepseek: {
    label: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    owns: /^deepseek/i,
    live: true,
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

// 迁移 0011 的兜底:部署了新代码但 `npm run db:migrate:remote` 没跑到时,
// 这些列/表不存在,设置页和统计页会直接 500(前端只剩一个转不完的 Loading)。
// 下面的语句只在查询报「列/表不存在」时执行一次,已迁移过的库上永远不会触发。
const AI_SCHEMA_SQL = [
  "ALTER TABLE users ADD COLUMN ai_provider TEXT",
  "ALTER TABLE users ADD COLUMN ai_model TEXT",
  "ALTER TABLE users ADD COLUMN openai_api_key TEXT",
  "ALTER TABLE users ADD COLUMN deepseek_api_key TEXT",
  `CREATE TABLE IF NOT EXISTS ai_calls (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     kind TEXT NOT NULL,
     latency_ms INTEGER NOT NULL,
     ok INTEGER NOT NULL DEFAULT 1,
     stream INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_calls(user_id, created_at)",
];

function schemaMissing(e: unknown): boolean {
  const err = e as { message?: string; cause?: { message?: string } };
  return /no such (column|table)/i.test(`${err?.message ?? ""} ${err?.cause?.message ?? ""}`);
}

async function ensureAiSchema(env: Env): Promise<void> {
  for (const sql of AI_SCHEMA_SQL) {
    // 已经有的列会报 duplicate column name(ALTER 没有 IF NOT EXISTS),忽略即可
    await env.DB.prepare(sql)
      .run()
      .catch((e) => console.warn("ai schema 兜底:", (e as Error).message));
  }
}

/** 跑一条依赖迁移 0011 的语句;库上还缺这些列/表时补一次再重试 */
export async function withAiSchema<T>(env: Env, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!schemaMissing(e)) throw e;
    await ensureAiSchema(env);
    return run();
  }
}

export function loadAiSettings(env: Env, userId: string): Promise<AiSettingsRow | null> {
  return withAiSchema(env, () =>
    env.DB.prepare("SELECT ai_provider, ai_model, openai_api_key, deepseek_api_key FROM users WHERE id = ?")
      .bind(userId)
      .first<AiSettingsRow>()
  );
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

/** 模型名是不是这家的:内置清单之外,也认 /models 里新出现的同族模型 */
export function ownsModel(p: AiProviderId, model: string): boolean {
  return PROVIDERS[p].models.includes(model) || PROVIDERS[p].owns.test(model);
}

// 实时模型清单的进程内缓存:设置页每次打开都问一遍 /models 太慢,缓存 10 分钟。
// 只缓存成功的结果,失败时下次再试(失败会临时退回内置清单)。
const MODELS_TTL_MS = 10 * 60 * 1000;
const modelsCache = new Map<string, { at: number; models: string[] }>();

/**
 * 设置页可选的模型。live 的提供商(DeepSeek)优先用它 /models 返回的真实清单,
 * 这样新上/下线的模型不用改代码就能选到;没 key、超时或返回空时退回内置清单。
 */
export async function providerModels(env: Env, row: AiSettingsRow | null, p: AiProviderId): Promise<string[]> {
  const spec = PROVIDERS[p];
  const fallback = spec.models;
  if (!spec.live) return fallback;

  const apiKey = userKey(row, p) || envKey(env, p);
  if (!apiKey) return fallback;

  const baseUrl = envBase(env, p);
  const cacheKey = `${p}|${baseUrl}|${apiKey.slice(-6)}`;
  const hit = modelsCache.get(cacheKey);
  if (hit && now() - hit.at < MODELS_TTL_MS) return hit.models;

  const live = await openaiListModels({ provider: p, apiKey, baseUrl });
  const ids = (live ?? []).filter((m) => spec.owns.test(m)).sort();
  if (!ids.length) return fallback;

  // 默认模型必须在列表里,否则设置页的下拉会显示一个选不中的值
  const models = ids.includes(envModel(env, p)) ? ids : [envModel(env, p), ...ids];
  modelsCache.set(cacheKey, { at: now(), models });
  return models;
}

/**
 * 当前生效的模型。ai_model 只在属于该提供商时才认:
 * 换提供商后残留的旧模型名不会被带过去(否则请求必然 400)。
 */
export function activeModel(env: Env, row: AiSettingsRow | null, p: AiProviderId): string {
  const chosen = (row?.ai_model ?? "").trim();
  return chosen && ownsModel(p, chosen) ? chosen : envModel(env, p);
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
  return withAiSchema(env, () =>
    env.DB.prepare(
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
  ).catch((e) => console.warn("ai_calls 记录失败:", (e as Error).message));
}
