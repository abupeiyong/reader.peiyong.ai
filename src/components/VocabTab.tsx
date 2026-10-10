import { useEffect, useState } from "react";
import { api } from "../api";
import type { VocabItem, WordExplanation } from "../../shared/types";
import { fmtInterval, untilDue } from "../../shared/srs";
import { speakWord } from "../lib/speech";
import { Icon } from "./Icon";

interface Props {
  refreshNonce: number; // 外部收藏后触发刷新
  onKnownWord: (word: string) => void;
  onStartReview: () => void;
}

const STATUS_LABEL: Record<string, string> = { learning: "Learning", known: "Mastered", review: "Review" };

export default function VocabTab({ refreshNonce, onKnownWord, onStartReview }: Props) {
  const [items, setItems] = useState<VocabItem[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  // 展开时按需补齐的释义(音标 + 例句),键是词条 id
  const [exps, setExps] = useState<Record<string, WordExplanation>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const load = () => {
    api.get<VocabItem[]>("/api/vocab").then(setItems).catch(() => {});
  };

  useEffect(load, [refreshNonce]);

  // 展开的词条缺音标 / 例句时按需生成(服务端会写回缓存);接口和复习卡共用一个
  useEffect(() => {
    const item = items.find((i) => i.id === expanded);
    if (!item || exps[item.id] || isComplete(parseExp(item.explanation_json))) return;
    let cancelled = false;
    setLoadingId(item.id);
    api
      .post<WordExplanation>(`/api/review/${item.id}/explanation`, {})
      .then((e) => !cancelled && setExps((m) => ({ ...m, [item.id]: e })))
      .catch(() => {})
      .finally(() => !cancelled && setLoadingId(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const setStatus = async (item: VocabItem, status: string) => {
    await api.patch(`/api/vocab/${item.id}`, { status });
    if (status === "known") onKnownWord(item.normalized);
    load();
  };

  const remove = async (item: VocabItem) => {
    await api.del(`/api/vocab/${item.id}`);
    load();
  };

  const filtered = filter === "all" ? items : items.filter((i) => i.status === filter);

  return (
    <div className="tab-body">
      <button className="btn btn-sm review-entry" onClick={onStartReview}><Icon name="repeat" /> Start review</button>
      <div className="vocab-filters">
        {["all", "learning", "review", "known"].map((f) => (
          <button key={f} className={`chip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : STATUS_LABEL[f]}
          </button>
        ))}
      </div>

      {filtered.length === 0 && <div className="chat-empty">No saved words yet. Click a word in the text to look it up and save it.</div>}

      {groupByDay(filtered).map((grp) => (
        <div key={grp.key} className="vocab-day">
          <div className="vocab-day-h">{grp.label} · {grp.items.length}</div>
          {grp.items.map((item) => {
            const exp = pickExp(exps[item.id], parseExp(item.explanation_json));
            // 离线模拟的音标 / 例句是占位文本,别当真:展开时会重新生成
            const real = exp?.source === "mock" ? null : exp;
            const open = expanded === item.id;
            return (
              <div key={item.id} className="vocab-item">
                <div className="vocab-row" onClick={() => setExpanded(open ? null : item.id)}>
                  <b>{item.word}</b>
                  {real?.phonetic && <span className="wp-phonetic vocab-phonetic">{real.phonetic}</span>}
                  <span className={`status-dot ${item.status}`} title={STATUS_LABEL[item.status]} />
                  <span className="vocab-meaning">{exp?.meaning_zh ?? ""}</span>
                  <button
                    className="icon-btn"
                    title="Pronounce"
                    onClick={(e) => {
                      e.stopPropagation();
                      speakWord(item.word);
                    }}
                  >
                    <Icon name="volume" />
                  </button>
                </div>
                {open && (
                  <div className="vocab-detail">
                    {item.context_sentence && <div className="vocab-context">“{item.context_sentence}”</div>}
                    {exp && <div className="wp-context">{exp.meaning_in_context}</div>}
                    {loadingId === item.id && <div className="wp-loading">Generating phonetic and examples…</div>}
                    {real?.examples?.length ? (
                      <div className="wp-examples">
                        {real.examples.map((ex, i) => (
                          <div key={i}>{ex}</div>
                        ))}
                      </div>
                    ) : null}
                    {item.page_no != null && <div className="wp-small">From page {item.page_no}</div>}
                    <div className="wp-small">{reviewLine(item)}</div>
                    <div className="vocab-actions">
                      {item.status !== "known" && (
                        <button className="link-btn" onClick={() => setStatus(item, "known")}>Mark mastered</button>
                      )}
                      {item.status !== "review" && (
                        <button className="link-btn" onClick={() => setStatus(item, "review")}>Add to review</button>
                      )}
                      {item.status !== "learning" && (
                        <button className="link-btn" onClick={() => setStatus(item, "learning")}>Mark learning</button>
                      )}
                      <button className="link-btn danger" onClick={() => remove(item)}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** 该词的复习进度:复习了几次、下次什么时候 —— 让复习结果在生词本里看得见 */
function reviewLine(item: VocabItem): string {
  if (item.status === "known") return "Mastered · no longer in the review queue";
  const head = item.reps ? `Reviewed ${item.reps}× · interval ${fmtInterval(item.interval_days)}` : "Not reviewed yet";
  const left = untilDue(item.due_at, Date.now());
  return `${head} · ${left ? `next review in ${left}` : "due now"}`;
}

// 按收藏日期(本地)分组,日期降序;当天/昨天用友好标签
function groupByDay(items: VocabItem[]): { key: string; label: string; items: VocabItem[] }[] {
  const sorted = [...items].sort((a, b) => b.created_at - a.created_at);
  const keyOf = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  const today = keyOf(Date.now());
  const yesterday = keyOf(Date.now() - 86400000);
  const groups: { key: string; label: string; items: VocabItem[] }[] = [];
  for (const it of sorted) {
    const k = keyOf(it.created_at);
    let g = groups.find((x) => x.key === k);
    if (!g) {
      const label =
        k === today
          ? "Today"
          : k === yesterday
          ? "Yesterday"
          : new Date(it.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      g = { key: k, label, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  return groups;
}

/** 展示用的释义:按需生成的那份更全,但生成退化成离线模拟时,还是用原来存的那份 */
function pickExp(fresh: WordExplanation | undefined, stored: WordExplanation | null): WordExplanation | null {
  if (!fresh) return stored;
  return fresh.source === "mock" && stored ? stored : fresh;
}

/** 音标和例句都在才算完整 —— 缺了就得找服务端补(离线模拟的那份也不算) */
function isComplete(exp: WordExplanation | null): boolean {
  return !!exp && exp.source !== "mock" && !!exp.phonetic && !!exp.examples?.length;
}

function parseExp(json: string | null): WordExplanation | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as WordExplanation;
  } catch {
    return null;
  }
}
