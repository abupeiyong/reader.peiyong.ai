// LLM 提供商:OpenAI 与 DeepSeek —— 两家都是 OpenAI 兼容的 Chat Completions 协议,
// 所以共用 openai.ts 里的客户端,这里只负责「用哪家、哪个模型、哪把 key」。
//
// key 的优先级:设置页填的(users 表)> 部署时的环境变量 secret。
// 选中的提供商没有 key 时 resolveProvider 返回 null,上层照旧回退 Workers AI → mock。
// 除了固定某一家,还能选 random:每次调用在有 key 的几家里随机挑一家(见 resolveProvider)。
import type { Env } from "./env";
import { openaiListModels } from "./openai";
import { now } from "./util";
import { THINK_LEVELS } from "../shared/types";
import type { AiCallKind, AiProviderChoice, AiProviderId, ThinkLevel } from "../shared/types";

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
/** 「每次调用随机挑一家」的伪提供商,存在 users.ai_provider 里 */
export const RANDOM_PROVIDER = "random";

export function isProviderId(v: unknown): v is AiProviderId {
  return typeof v === "string" && (PROVIDER_IDS as string[]).includes(v);
}

export function isProviderChoice(v: unknown): v is AiProviderChoice {
  return v === RANDOM_PROVIDER || isProviderId(v);
}

export function isThinkLevel(v: unknown): v is ThinkLevel {
  return typeof v === "string" && (THINK_LEVELS as readonly string[]).includes(v);
}

export interface ProviderConfig {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  /**
   * 这次调用允许模型「思考」到哪一档(推理)。
   * undefined = 沿用各场景原有的默认(最低推理档),只有查词会显式给值。
   */
  thinkLevel?: ThinkLevel;
}

/** users 表里与 AI 提供商相关的几列 */
export interface AiSettingsRow {
  ai_provider: string | null;
  /** 迁移 0013 之前的单列模型;现在只当老数据的兜底读,不再写 */
  ai_model: string | null;
  ai_model_openai: string | null;
  ai_model_deepseek: string | null;
  openai_api_key: string | null;
  deepseek_api_key: string | null;
  /** 迁移 0014 之前的开关;现在只当老数据的兜底读,不再写 */
  ai_word_thinking: number | null;
  ai_word_think_level: string | null;
}

// 迁移 0011 / 0012 / 0013 / 0014 的兜底:部署了新代码但 `npm run db:migrate:remote` 没跑到时,
// 这些列/表不存在,设置页和统计页会直接 500(前端只剩一个转不完的 Loading)。
// 下面的语句只在查询报「列/表不存在」时执行一次,已迁移过的库上永远不会触发。
const AI_SCHEMA_SQL = [
  "ALTER TABLE users ADD COLUMN ai_provider TEXT",
  "ALTER TABLE users ADD COLUMN ai_model TEXT",
  "ALTER TABLE users ADD COLUMN ai_model_openai TEXT",
  "ALTER TABLE users ADD COLUMN ai_model_deepseek TEXT",
  "ALTER TABLE users ADD COLUMN openai_api_key TEXT",
  "ALTER TABLE users ADD COLUMN deepseek_api_key TEXT",
  "ALTER TABLE users ADD COLUMN ai_word_thinking INTEGER",
  "ALTER TABLE users ADD COLUMN ai_word_think_level TEXT",
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
    env.DB.prepare(
      `SELECT ai_provider, ai_model, ai_model_openai, ai_model_deepseek,
              openai_api_key, deepseek_api_key, ai_word_thinking, ai_word_think_level
         FROM users WHERE id = ?`
    )
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

/** 设置页当前选的:某一家,或 random */
export function activeChoice(row: AiSettingsRow | null): AiProviderChoice {
  return isProviderChoice(row?.ai_provider) ? row.ai_provider : DEFAULT_PROVIDER;
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

/** 存这家选定模型的列名 */
export function modelColumn(p: AiProviderId): string {
  return p === "deepseek" ? "ai_model_deepseek" : "ai_model_openai";
}

/**
 * 设置页为这家选过的模型;没选过返回空串。
 * 每家各存一列,所以换提供商(含切到 random)不会弄丢另一家的选择。
 * 迁移 0013 之前的老数据只有单列 ai_model,它属于这家时仍然认。
 */
function userModel(row: AiSettingsRow | null, p: AiProviderId): string {
  const chosen = ((p === "deepseek" ? row?.ai_model_deepseek : row?.ai_model_openai) ?? "").trim();
  if (chosen) return chosen;
  const legacy = (row?.ai_model ?? "").trim();
  return legacy && ownsModel(p, legacy) ? legacy : "";
}

/**
 * 当前生效的模型。选定的模型只在属于该提供商时才认:
 * 换提供商后残留的旧模型名不会被带过去(否则请求必然 400)。
 */
export function activeModel(env: Env, row: AiSettingsRow | null, p: AiProviderId): string {
  const chosen = userModel(row, p);
  return chosen && ownsModel(p, chosen) ? chosen : envModel(env, p);
}

export function providerConfig(env: Env, row: AiSettingsRow | null, p: AiProviderId): ProviderConfig | null {
  const apiKey = userKey(row, p) || envKey(env, p);
  if (!apiKey) return null;
  return { provider: p, model: activeModel(env, row, p), apiKey, baseUrl: envBase(env, p) };
}

/**
 * random 模式:在「有 key 能用」的提供商里等概率挑一家。
 * 只有一家有 key 时就是那家;一家都没有返回 null(上层回退 Workers AI → mock)。
 */
function randomConfig(env: Env, row: AiSettingsRow | null): ProviderConfig | null {
  const usable = PROVIDER_IDS.map((id) => providerConfig(env, row, id)).filter(
    (cfg): cfg is ProviderConfig => cfg !== null
  );
  if (!usable.length) return null;
  return usable[Math.floor(Math.random() * usable.length)];
}

/** 查词默认不让模型思考:查词看的是「多久出结果」,推理那几秒的代价远大于收益 */
export const DEFAULT_WORD_THINK_LEVEL: ThinkLevel = "off";

/**
 * 设置页选的「查词思考档位」;没设过(NULL)按默认算。
 * 迁移 0014 之前只有开关列 ai_word_thinking,老数据的「开」当 low 读。
 */
export function wordThinkLevel(row: AiSettingsRow | null): ThinkLevel {
  if (isThinkLevel(row?.ai_word_think_level)) return row.ai_word_think_level;
  if (row?.ai_word_thinking != null) return row.ai_word_thinking === 1 ? "low" : "off";
  return DEFAULT_WORD_THINK_LEVEL;
}

/** 关思考时需要换模型的提供商:DeepSeek 的推理模型没有开关参数,只能换成非推理的那个 */
const NON_THINKING_SWAP: Partial<Record<AiProviderId, { thinks: RegExp; model: string }>> = {
  deepseek: { thinks: /^deepseek-reasoner/i, model: "deepseek-chat" },
};

/**
 * 把「这次思考到哪一档」落到具体配置上:
 * - OpenAI(gpt-5 系列)靠 reasoning_effort 调档,模型不变(见 openai.ts 的 chatBody);
 * - DeepSeek 没有这种参数,只分「思不思考」:off 时把 deepseek-reasoner 换成 deepseek-chat,
 *   其余档位都保持 reasoner(它的推理深度不可调)。
 * level 为 undefined(查词以外的场景)时不做任何改动。
 */
export function applyThinking(cfg: ProviderConfig, level: ThinkLevel | undefined): ProviderConfig {
  const swap = NON_THINKING_SWAP[cfg.provider];
  const model = level === "off" && swap?.thinks.test(cfg.model) ? swap.model : cfg.model;
  return { ...cfg, model, thinkLevel: level };
}

/**
 * 该用户这次调用该用哪家/哪个模型/哪把 key;没有可用 key 返回 null。
 * 每次 AI 任务(查词 / 本页解析 / 对话)都会各调一次,所以 random 是按任务随机,不是按会话。
 * 传了 kind 时顺带决定这次要不要思考:目前只有查词可配,其余场景保持原有行为。
 */
export async function resolveProvider(
  env: Env,
  userId: string | null,
  kind?: AiCallKind
): Promise<ProviderConfig | null> {
  const row = userId ? await loadAiSettings(env, userId).catch(() => null) : null;
  const choice = activeChoice(row);
  const cfg = choice === RANDOM_PROVIDER ? randomConfig(env, row) : providerConfig(env, row, choice);
  return cfg && applyThinking(cfg, kind === "explain_word" ? wordThinkLevel(row) : undefined);
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
