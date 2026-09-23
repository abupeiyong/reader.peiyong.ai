// 前后端共享类型

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  english_level: "beginner" | "intermediate" | "advanced";
  hints_enabled: number;
}

export interface Book {
  id: string;
  title: string;
  filename: string;
  size: number;
  page_count: number;
  status: "uploaded" | "processing" | "ready" | "failed";
  created_at: number;
  progress_page?: number;
  cover_key?: string | null;
}

export interface WordExplanation {
  word: string;
  phonetic: string;        // 音标,如 /ˈwɜːrd/
  pos: string;             // 词性
  meaning_zh: string;      // 当前语境中文释义
  meaning_in_context: string; // 原句中的具体含义说明(中文)
  collocations: string[];  // 常见搭配
  forms: string[];         // 词形变化
  examples: string[];      // 简短例句
  source?: "ai" | "mock";
}

export interface PageAnalysis {
  vocabulary: { word: string; phonetic?: string; meaning: string }[];
  phrases: { phrase: string; meaning: string }[];
  sentences: { sentence: string; explanation: string }[];
  background: string;
  source?: "ai" | "mock";
}

export interface VocabItem {
  id: string;
  word: string;
  normalized: string;
  context_sentence: string | null;
  book_id: string | null;
  page_no: number | null;
  explanation_json: string | null;
  status: "learning" | "known" | "review";
  created_at: number;
  updated_at: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  refs_json: string | null;
  created_at: number;
}

export type ChatScope = "selection" | "page" | "document";

// ---------- 二期 ----------

export interface ReviewQueue {
  items: (VocabItem & { due_at: number | null; interval_days: number; ease: number; reps: number })[];
  due_count: number;
}

export interface DayStat {
  date: string;
  page_view?: number;
  lookup?: number;
  vocab_add?: number;
  review?: number;
  chat?: number;
}

export interface ReadingSessionBrief {
  book_id: string;
  book_title: string | null;
  started_at: number;
  ended_at: number | null;
  active_ms: number;   // 实际阅读时长
  pauses: number;      // 中断次数(1分钟无活动暂停,恢复算一次)
}

export interface CalendarDay {
  read_ms: number;
  books: { id: string; title: string }[];
  words: { word: string; meaning: string; sentence: string | null }[];
  notes: { note: string; quote: string | null; page_no: number | null }[];
  sessions: ReadingSessionBrief[];
}

export interface CalendarData {
  days: Record<string, CalendarDay>;
}

export interface VocabSnapshot {
  day: string;              // YYYY-MM-DD (UTC)
  vocab_rank: number;       // 估计词汇量(词频排名口径)
  known_count: number;
  saved_count: number;
}

export interface Stats {
  days: DayStat[];
  read_days: { date: string; ms: number }[]; // 近 30 天每日阅读时长(本地日)
  streak: number;
  vocab: Record<string, number>;
  due_count: number;
  book_count: number;
  vocab_rank: number;
  vocab_trend: VocabSnapshot[];
}

// ---------- AI 提供商设置与调用统计 ----------

export type AiProviderId = "openai" | "deepseek";

/** 设置页选的「用哪家」:某一家,或 random —— 每次 AI 调用在配了 key 的提供商里随机挑一家 */
export type AiProviderChoice = AiProviderId | "random";

/** 记录延迟时用的调用场景 */
export type AiCallKind = "explain_word" | "analyze_page" | "chat" | "telegram";

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  models: string[];   // 可选模型;DeepSeek 取自它 /models 的实时清单,问不到时为内置清单
  default_model: string;
  key_set: boolean;
  key_source: "user" | "env" | null; // user = 设置页填的;env = 部署时的 secret
  key_hint: string;                  // 末 4 位(如 "…3f9a");没有 key 时为空串
}

/** 设置页「自检」的结果:ok=false 时 error 是提供商返回的原话(HTTP 状态 + 它的 message) */
export interface AiProviderTest {
  provider: AiProviderId;
  model: string;
  ok: boolean;
  latency_ms: number;
  error: string | null;
}

export interface AiSettings {
  provider: AiProviderChoice;
  model: string;        // 当前生效的模型;random 时为空串(各家各用自己的默认模型)
  providers: AiProviderInfo[];
  /** 查词时是否让模型先「思考」(推理);默认 false —— 查词要的是快 */
  word_thinking: boolean;
}

export interface AiLatencyGroup {
  provider: string;
  model: string;
  kind: AiCallKind | "all";
  calls: number;
  ok_calls: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
  last_at: number;
}

export interface AiCallLog {
  provider: string;
  model: string;
  kind: string;
  latency_ms: number;
  ok: number;
  stream: number;
  created_at: number;
}

export interface AiStats {
  days: number;
  total_calls: number;
  by_model: AiLatencyGroup[];
  by_kind: AiLatencyGroup[];
  recent: AiCallLog[];
}

/** 每日阅读目标:3 小时 */
export const DAILY_GOAL_MS = 3 * 60 * 60 * 1000;

export interface ReadingToday {
  ms: number;       // 今天(用户本地日)已读的 active_ms 总和(带 exclude 时不含被排除的那次会话)
  goal_ms: number;  // 当日目标
  /**
   * 被 exclude 的那次会话(通常是正在进行的这次)算不算今天:
   * 会话整段计入它「开始」的那个本地日,所以跨午夜时它可能属于昨天。
   * 为 false 时调用方不要把本次的实时时长加到 ms 上,否则提醒会和日历/统计对不上。
   */
  live_counts_today: boolean;
}
