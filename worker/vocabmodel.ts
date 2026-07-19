// 个性化词汇水平模型(二期)
// 思路:以词频排名为"难度"轴。用户的行为提供观测:
//   - 标记"认识"的词 rank=r  → "水平 ≥ r" 的证据
//   - 点击查询/收藏的词 rank=r → "水平 < r" 的证据
// 用最小错分阈值 + 先验混合估计用户词汇量(rank 口径),再据此计算每个词的
// P(不认识),用于生词轻量提示。全部确定性计算,零 AI 成本。
import { wordRank } from "./wordfreq";

const LEVEL_PRIOR: Record<string, number> = {
  beginner: 2000,
  intermediate: 4500,
  advanced: 8000,
};
const PRIOR_WEIGHT = 10; // 先验相当于 10 个观测
const UNKNOWN_RANK = 12000; // 不在词频表中的词按此难度处理
const SLOPE = 1500;

export function priorRank(level: string): number {
  return LEVEL_PRIOR[level] ?? LEVEL_PRIOR.intermediate;
}

export interface VocabObservations {
  knownRanks: number[]; // "认识"的词的 rank
  unknownRanks: number[]; // 查询/收藏过的词的 rank
}

/** 估计用户词汇量(词频 rank 口径) */
export function estimateVocabRank(level: string, obs: VocabObservations): number {
  const prior = priorRank(level);
  const points: { rank: number; known: boolean }[] = [
    ...obs.knownRanks.map((r) => ({ rank: r, known: true })),
    ...obs.unknownRanks.map((r) => ({ rank: r, known: false })),
  ];
  if (points.length === 0) return prior;

  // 候选阈值:各观测点 rank;选错分最少的阈值(预测:rank<=t 认识)
  const candidates = [...new Set(points.map((p) => p.rank))].sort((a, b) => a - b);
  candidates.push(candidates[candidates.length - 1] + 1);
  let best = prior;
  let bestErr = Infinity;
  for (const t of candidates) {
    let err = 0;
    for (const p of points) {
      if (p.known && p.rank > t) err++;
      if (!p.known && p.rank <= t) err++;
    }
    if (err < bestErr || (err === bestErr && Math.abs(t - prior) < Math.abs(best - prior))) {
      bestErr = err;
      best = t;
    }
  }
  // 与先验混合,避免少量观测大幅跳动
  const n = points.length;
  return Math.round((prior * PRIOR_WEIGHT + best * n) / (PRIOR_WEIGHT + n));
}

export function pUnknown(rank: number | null, userRank: number): number {
  const r = rank ?? UNKNOWN_RANK;
  return 1 / (1 + Math.exp(-(r - userRank) / SLOPE));
}

export interface HintOptions {
  userRank: number;
  knownWords: Set<string>; // 已标记认识
  threshold?: number; // P(不认识) 阈值
  maxHints?: number;
}

/** 从页面文本中挑出该用户可能不认识的词 */
export function hintsForText(text: string, opts: HintOptions): string[] {
  const threshold = opts.threshold ?? 0.55;
  const maxHints = opts.maxHints ?? 15;

  // 统计词的出现形态,只出现在句首/专有名词形态(始终大写)的词跳过
  const tokens = text.match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];
  const lowerSeen = new Set<string>();
  const capOnly = new Map<string, boolean>();
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (t[0] === t[0].toLowerCase()) {
      lowerSeen.add(lower);
      capOnly.set(lower, false);
    } else if (!capOnly.has(lower)) {
      capOnly.set(lower, true);
    }
  }

  const scored: { word: string; p: number }[] = [];
  for (const [word, onlyCap] of capOnly) {
    if (onlyCap && !lowerSeen.has(word)) continue; // 专有名词
    if (word.length < 4) continue;
    if (opts.knownWords.has(word)) continue;
    if (!/^[a-z][a-z'-]+$/.test(word)) continue;
    const rank = wordRank(word);
    if (rank !== null && rank <= 1500) continue; // 高频词直接跳过
    const p = pUnknown(rank, opts.userRank);
    if (p >= threshold) scored.push({ word, p });
  }
  scored.sort((a, b) => b.p - a.p);
  return scored.slice(0, maxHints).map((s) => s.word);
}

// ---------- SM-2 间隔重复 ----------

export type ReviewGrade = "again" | "hard" | "good" | "easy";

export interface SrsState {
  interval_days: number;
  ease: number;
  reps: number;
}

export function applyReview(s: SrsState, grade: ReviewGrade, now: number): SrsState & { due_at: number } {
  let { interval_days: interval, ease, reps } = s;
  switch (grade) {
    case "again":
      ease = Math.max(1.3, ease - 0.2);
      reps = 0;
      interval = 0;
      return { interval_days: interval, ease, reps, due_at: now + 10 * 60 * 1000 }; // 10 分钟后重来
    case "hard":
      ease = Math.max(1.3, ease - 0.15);
      interval = Math.max(1, interval * 1.2);
      break;
    case "good":
      interval = reps === 0 ? 1 : interval * ease;
      break;
    case "easy":
      ease = ease + 0.15;
      interval = reps === 0 ? 2 : interval * ease * 1.3;
      break;
  }
  interval = Math.min(interval, 365);
  reps += 1;
  return { interval_days: interval, ease, reps, due_at: now + interval * 24 * 3600 * 1000 };
}
