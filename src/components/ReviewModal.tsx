import { useEffect, useState } from "react";
import { api } from "../api";
import type { ReviewQueue, WordExplanation } from "../../shared/types";
import { speakWord, prefetchWordAudio } from "../lib/speech";
import { Icon } from "./Icon";

type Item = ReviewQueue["items"][number];

const GRADES: { key: "again" | "hard" | "good" | "easy"; label: string; hint: string; cls: string }[] = [
  { key: "again", label: "Again", hint: "10 min", cls: "g-again" },
  { key: "hard", label: "Hard", hint: "", cls: "g-hard" },
  { key: "good", label: "Good", hint: "", cls: "g-good" },
  { key: "easy", label: "Easy", hint: "", cls: "g-easy" },
];

export default function ReviewModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [queue, setQueue] = useState<Item[]>([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [graduated, setGraduated] = useState(0);
  const [exps, setExps] = useState<Record<string, WordExplanation>>({});
  const [expLoading, setExpLoading] = useState(false);

  useEffect(() => {
    api.get<ReviewQueue>("/api/review/queue").then((q) => {
      setQueue(q.items);
      setLoading(false);
    });
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

  const grade = async (g: "again" | "hard" | "good" | "easy") => {
    if (!current) return;
    const res = await api.post<{ graduated: boolean }>(`/api/review/${current.id}`, { grade: g });
    if (res.graduated) setGraduated((n) => n + 1);
    setDoneCount((n) => n + 1);
    setRevealed(false);
    if (g === "again") {
      // 重来的词挪到队尾
      setQueue((q) => {
        const copy = [...q];
        const [item] = copy.splice(idx, 1);
        copy.push(item);
        return copy;
      });
    } else {
      setIdx((i) => i + 1);
    }
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
            {doneCount > 0 ? (
              <p>Session complete! {doneCount} reviews done{graduated > 0 ? `, ${graduated} word(s) graduated to mastered` : ""}.</p>
            ) : (
              <p>No words are due for review. Save some new words while reading!</p>
            )}
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        )}

        {!finished && current && (
          <div className="review-body">
            <div className="review-word">
              {current.word}
              <button className="icon-btn" title="Pronounce" onClick={() => speakWord(current.word)}><Icon name="volume" /></button>
            </div>
            {exp?.phonetic && <div className="wp-phonetic">{exp.phonetic}</div>}

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
                <div className="review-grades">
                  {GRADES.map((g) => (
                    <button key={g.key} className={`btn review-grade ${g.cls}`} onClick={() => grade(g.key)}>
                      {g.label}
                      {g.hint && <span className="grade-hint">{g.hint}</span>}
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
