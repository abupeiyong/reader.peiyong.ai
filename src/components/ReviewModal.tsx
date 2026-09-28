import { useEffect, useState } from "react";
import { api } from "../api";
import type { ReviewQueue, ReviewResult, VocabItem, WordExplanation } from "../../shared/types";
import { AGAIN_DELAY_MS, applyReview, fmtInterval, type ReviewGrade } from "../../shared/srs";
import { speakWord, prefetchWordAudio } from "../lib/speech";
import { Icon } from "./Icon";

type Item = VocabItem;

const GRADES: { key: ReviewGrade; label: string; cls: string }[] = [
  { key: "again", label: "Again", cls: "g-again" },
  { key: "hard", label: "Hard", cls: "g-hard" },
  { key: "good", label: "Good", cls: "g-good" },
  { key: "easy", label: "Easy", cls: "g-easy" },
];

/** 刚打分那张卡的结果,打完立刻显示出来,让人看见评分确实记下了 */
interface LastResult {
  word: string;
  label: string;
  text: string;
}

export default function ReviewModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [queue, setQueue] = useState<Item[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [graduated, setGraduated] = useState(0);
  const [exps, setExps] = useState<Record<string, WordExplanation>>({});
  const [expLoading, setExpLoading] = useState(false);
  const [grading, setGrading] = useState(false);
  const [last, setLast] = useState<LastResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<ReviewQueue>("/api/review/queue")
      .then((q) => setQueue(q.items))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const current = queue[idx];
  const exp = current ? exps[current.id] ?? parseExp(current.explanation_json) : null;

  // 当前卡出现即预取发音,点喇叭零等待
  useEffect(() => {
    if (current) prefetchWordAudio(current.word);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // 当前卡缺完整释义时按需生成(服务端会写回缓存)
  useEffect(() => {
    if (!current || exps[current.id] || parseExp(current.explanation_json)) return;
    let cancelled = false;
    setExpLoading(true);
    api
      .post<WordExplanation>(`/api/review/${current.id}/explanation`, {})
      .then((e) => !cancelled && setExps((m) => ({ ...m, [current.id]: e })))
      .catch(() => {})
      .finally(() => !cancelled && setExpLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const grade = async (g: ReviewGrade) => {
    if (!current || grading) return;
    setGrading(true);
    setError("");
    let res: ReviewResult;
    try {
      res = await api.post<ReviewResult>(`/api/review/${current.id}`, { grade: g });
    } catch (e) {
      // 打分没落库时不要推进卡片,否则这次评分会被静默丢掉
      setError(`未能保存评分:${(e as Error).message}`);
      setGrading(false);
      return;
    }

    const label = GRADES.find((x) => x.key === g)?.label ?? g;
    setLast({
      word: current.word,
      label,
      text: res.graduated ? "mastered, leaving the review queue 🎓" : `next review in ${fmtInterval(res.interval_days)}`,
    });
    if (res.graduated) setGraduated((n) => n + 1);
    setDoneCount((n) => n + 1);
    setRevealed(false);

    // 服务端与这里用同一套 SM-2 规则,本地同步一份新状态,按钮上的间隔预览才不会停在旧值
    const next = { ...current, ...applyReview(current, g, Date.now()), due_at: res.due_at };
    const moreLeft = queue.length - idx > 1;
    if (g === "again" && moreLeft) {
      // 重来的词挪到队尾,本轮还会再见一次
      setQueue((q) => {
        const copy = [...q];
        copy.splice(idx, 1);
        copy.push(next);
        return copy;
      });
    } else {
      // 只剩这一张时不要原地重放(会卡住走不完),10 分钟后重新进队列
      setQueue((q) => q.map((it, i) => (i === idx ? next : it)));
      setIdx((i) => i + 1);
    }
    setGrading(false);
    onChanged();
  };

  const finished = !loading && (queue.length === 0 || idx >= queue.length);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="review-modal" onClick={(e) => e.stopPropagation()}>
        <div className="review-head">
          <b>Word Review</b>
          <span className="wp-small">
            {finished ? "" : `${Math.min(idx + 1, queue.length)} / ${queue.length}`}
          </span>
          <button className="icon-btn" onClick={onClose}><Icon name="x" /></button>
        </div>

        {loading && <div className="review-body"><div className="spinner" /></div>}

        {finished && !loading && (
          <div className="review-body review-done">
            <div className="empty-icon"><Icon name="award" size={40} /></div>
            {doneCount > 0 && (
              <p>Session complete! {doneCount} reviews saved{graduated > 0 ? `, ${graduated} word(s) graduated to mastered` : ""}.</p>
            )}
            {doneCount === 0 && !error && <p>No words are due for review. Save some new words while reading!</p>}
            {error && <div className="review-error">{error}</div>}
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        )}

        {!finished && current && (
          <div className="review-body">
            {last && (
              <div className="review-last">
                <Icon name="check" size={14} /> {last.word}: {last.label} — {last.text}
              </div>
            )}
            <div className="review-word">
              {current.word}
              <button className="icon-btn" title="Pronounce" onClick={() => speakWord(current.word)}><Icon name="volume" /></button>
            </div>
            {exp?.phonetic && <div className="wp-phonetic">{exp.phonetic}</div>}
            <div className="wp-small">{reviewState(current)}</div>

            {!revealed ? (
              <>
                <div className="review-context">
                  {current.context_sentence ? `“${maskWord(current.context_sentence, current.word)}”` : "Recall what this word means…"}
                </div>
                <button className="btn btn-primary review-reveal" onClick={() => setRevealed(true)}>
                  Show answer
                </button>
              </>
            ) : (
              <>
                <div className="review-answer">
                  {!exp && expLoading && <div className="wp-loading">Generating explanation…</div>}
                  {!exp && !expLoading && <div className="review-meaning">(no definition available)</div>}
                  {exp && (
                    <>
                      <div className="review-meaning">
                        {exp.pos && <span className="review-pos">{exp.pos}</span>} {exp.meaning_zh}
                      </div>
                      {exp.meaning_in_context && <div className="wp-context">{exp.meaning_in_context}</div>}
                      {exp.collocations?.length ? <div className="wp-small">Collocations: {exp.collocations.join(" · ")}</div> : null}
                      {exp.forms?.length ? <div className="wp-small">Forms: {exp.forms.join(" / ")}</div> : null}
                      {exp.examples?.length ? <div className="wp-examples">{exp.examples.map((ex, i) => <div key={i}>{ex}</div>)}</div> : null}
                    </>
                  )}
                  {current.context_sentence && <div className="review-context">“{current.context_sentence}”</div>}
                </div>
                {error && <div className="review-error">{error}</div>}
                <div className="review-grades">
                  {GRADES.map((g) => (
                    <button
                      key={g.key}
                      className={`btn review-grade ${g.cls}`}
                      disabled={grading}
                      onClick={() => grade(g.key)}
                    >
                      {g.label}
                      <span className="grade-hint">{gradePreview(current, g.key)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 按钮上标出这一档对应的下次间隔(和服务端同一套 SM-2 规则算出来的) */
function gradePreview(item: Item, g: ReviewGrade): string {
  if (g === "again") return `${Math.round(AGAIN_DELAY_MS / 60000)} min`;
  return fmtInterval(applyReview(item, g, 0).interval_days);
}

/** 这张卡当前的复习进度,让人看到之前的评分是记下来的 */
function reviewState(item: Item): string {
  if (!item.reps) return "New word";
  return `Reviewed ${item.reps}× · current interval ${fmtInterval(item.interval_days)}`;
}

function parseExp(json: string | null): WordExplanation | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as WordExplanation;
  } catch {
    return null;
  }
}

/** 在例句中把目标词挖空 */
function maskWord(sentence: string, word: string): string {
  return sentence.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "____");
}
