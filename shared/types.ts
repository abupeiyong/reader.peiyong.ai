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

export interface RecordingFeedback {
  transcript: string;
  coverage: number;           // 0-100 完整度
  missed_words: string[];     // 漏读
  extra_words: string[];      // 多读
  matched_count: number;
  ref_word_count: number;
  suggestions: string;        // 建议(中文)
  wpm?: number | null;        // 语速(词/分钟)
  source?: "ai" | "browser";
}

export interface RecordingItem {
  id: string;
  book_id: string | null;
  page_no: number | null;
  ref_text: string;
  transcript: string | null;
  feedback_json: string | null;
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
  recording?: number;
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
  streak: number;
  vocab: Record<string, number>;
  due_count: number;
  book_count: number;
  recording_count: number;
  vocab_rank: number;
  vocab_trend: VocabSnapshot[];
}
