// SM-2(艾宾浩斯遗忘曲线)的纯计算 + 间隔的统一写法。
// 放在 shared/ 而不是 worker/ 里,是为了网页端能在评分按钮上预览各档的下次间隔,
// 并和服务端、Telegram 卡片用同一套规则、同一种措辞。

export type ReviewGrade = "again" | "hard" | "good" | "easy";

export interface SrsState {
  interval_days: number;
  ease: number;
  reps: number;
}

/** "again" 不排到明天,10 分钟后在本次会话里重来 */
export const AGAIN_DELAY_MS = 10 * 60 * 1000;

export function applyReview(s: SrsState, grade: ReviewGrade, now: number): SrsState & { due_at: number } {
  let { interval_days: interval, ease, reps } = s;
  switch (grade) {
    case "again":
      ease = Math.max(1.3, ease - 0.2);
      reps = 0;
      interval = 0;
      return { interval_days: interval, ease, reps, due_at: now + AGAIN_DELAY_MS };
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

/** 间隔天数的短写法:10h / 3d / 2mo */
export function fmtInterval(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 30) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}

export function fmtDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** 距 due_at 还有多久;已到期返回 null(调用方显示 "due now") */
export function untilDue(dueAt: number | null, now: number): string | null {
  if (dueAt == null || dueAt <= now) return null;
  return fmtInterval((dueAt - now) / (24 * 3600 * 1000));
}
