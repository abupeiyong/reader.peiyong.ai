// 复习评分落库(SM-2/艾宾浩斯遗忘曲线)。
// 网页端 /api/review/:id 与 Telegram 卡片按钮共用同一套规则,避免两处算出不同的下次复习时间。
import type { Env } from "./env";
import { now } from "./util";
import { applyReview, type ReviewGrade } from "../shared/srs";

export interface GradeOutcome {
  due_at: number;
  interval_days: number;
  graduated: boolean;
}

/** 按 grade 推进一张卡;词不存在或不属于该用户时返回 null */
export async function gradeVocab(
  env: Env,
  userId: string,
  vocabId: string,
  grade: ReviewGrade
): Promise<GradeOutcome | null> {
  const item = await env.DB.prepare("SELECT interval_days, ease, reps FROM vocab WHERE id = ? AND user_id = ?")
    .bind(vocabId, userId)
    .first<{ interval_days: number; ease: number; reps: number }>();
  if (!item) return null;

  const ts = now();
  const next = applyReview(item, grade, ts);
  const graduated = next.interval_days >= 30; // 长间隔视为已掌握
  await env.DB.prepare(
    `UPDATE vocab SET interval_days = ?, ease = ?, reps = ?, due_at = ?, last_review = ?, updated_at = ?
     ${graduated ? ", status = 'known'" : ""} WHERE id = ? AND user_id = ?`
  )
    .bind(next.interval_days, next.ease, next.reps, next.due_at, ts, ts, vocabId, userId)
    .run();
  // 与 index.ts 的 logActivity 写同一张表,这里直写避免 worker 内循环依赖
  await env.DB.prepare("INSERT INTO activity (user_id, kind, created_at) VALUES (?, 'review', ?)")
    .bind(userId, ts)
    .run()
    .catch((e) => console.warn("activity log 失败:", (e as Error).message));

  return { due_at: next.due_at, interval_days: next.interval_days, graduated };
}
