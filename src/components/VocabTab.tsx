import { useEffect, useState } from "react";
import { api } from "../api";
import type { RecordingFeedback, RecordingItem, VocabItem, WordExplanation } from "../../shared/types";
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
  const [recordings, setRecordings] = useState<RecordingItem[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [view, setView] = useState<"vocab" | "recordings">("vocab");

  const load = () => {
    api.get<VocabItem[]>("/api/vocab").then(setItems).catch(() => {});
    api.get<RecordingItem[]>("/api/recordings").then(setRecordings).catch(() => {});
  };

  useEffect(load, [refreshNonce]);

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
      <div className="vocab-switch">
        <button className={`chip ${view === "vocab" ? "active" : ""}`} onClick={() => setView("vocab")}>
          Words ({items.length})
        </button>
        <button className={`chip ${view === "recordings" ? "active" : ""}`} onClick={() => setView("recordings")}>
          Recordings ({recordings.length})
        </button>
      </div>

      {view === "vocab" && (
        <>
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
            const exp = parseExp(item.explanation_json);
            const open = expanded === item.id;
            return (
              <div key={item.id} className="vocab-item">
                <div className="vocab-row" onClick={() => setExpanded(open ? null : item.id)}>
                  <b>{item.word}</b>
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
                    {item.page_no != null && <div className="wp-small">From page {item.page_no}</div>}
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
        </>
      )}

      {view === "recordings" && (
        <>
          {recordings.length === 0 && (
            <div className="chat-empty">No recordings yet. Tap play beside a paragraph, or use Practice in the read-aloud bar, to start.</div>
          )}
          {recordings.map((r) => {
            const fb = parseFb(r.feedback_json);
            return (
              <div key={r.id} className="rec-item">
                <div className="rec-head">
                  <span className={`coverage ${fb && fb.coverage >= 80 ? "good" : fb && fb.coverage >= 50 ? "ok" : "bad"}`}>
                    Completeness {fb?.coverage ?? "-"}%
                  </span>
                  <span className="wp-small">
                    {r.page_no != null ? `Page ${r.page_no} · ` : ""}
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="rec-ref">“{r.ref_text.slice(0, 100)}{r.ref_text.length > 100 ? "…" : ""}”</div>
                {fb && fb.missed_words.length > 0 && (
                  <div className="wp-small">Missed: {fb.missed_words.slice(0, 8).join(", ")}</div>
                )}
                <audio controls preload="none" src={`/api/recordings/${r.id}/audio`} className="rec-audio" />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
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

function parseExp(json: string | null): WordExplanation | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as WordExplanation;
  } catch {
    return null;
  }
}

function parseFb(json: string | null): RecordingFeedback | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RecordingFeedback;
  } catch {
    return null;
  }
}
