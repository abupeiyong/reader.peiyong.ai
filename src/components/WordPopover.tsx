import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { WordExplanation } from "../../shared/types";
import { speakWord } from "../lib/speech";
import { Icon } from "./Icon";

interface Props {
  word: string;
  sentence: string;
  x: number;
  y: number;
  yTop: number;
  bookId: string;
  pageNo: number;
  onClose: () => void;
  onSaved: () => void;      // 收藏后刷新生词本
  onKnown: (word: string) => void; // 标记认识
  onAskAI: (word: string, sentence: string) => void;
}

export default function WordPopover({ word, sentence, x, y, yTop, bookId, pageNo, onClose, onSaved, onKnown, onAskAI }: Props) {
  const [exp, setExp] = useState<WordExplanation | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExp(null);
    setSaved(false);
    setError("");
    let cancelled = false;
    api
      .post<WordExplanation>("/api/ai/explain-word", { word, sentence, book_id: bookId, page_no: pageNo })
      .then((e) => !cancelled && setExp(e))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [word, sentence, bookId, pageNo]);

  // 点击外部关闭
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [onClose]);

  const save = async (status: "learning" | "known") => {
    await api.post("/api/vocab", {
      word,
      context_sentence: sentence,
      book_id: bookId,
      page_no: pageNo,
      explanation: exp,
      status,
    });
    if (status === "known") {
      onKnown(word.toLowerCase());
    } else {
      setSaved(true);
    }
    onSaved();
    if (status === "known") onClose();
  };

  // 定位:优先词下方,空间不足则翻转到词上方;高度变化后重新测量
  const [top, setTop] = useState(() => y + 8);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (y + 8 + h > window.innerHeight - 12) {
      setTop(Math.max(12, yTop - h - 8));
    } else {
      setTop(y + 8);
    }
  }, [exp, error, y, yTop]);

  const style: React.CSSProperties = {
    left: Math.min(Math.max(12, x - 160), window.innerWidth - 340),
    top,
  };

  return (
    <div className="word-popover" style={style} ref={ref}>
      <div className="wp-head">
        <span className="wp-word">{word}</span>
        {exp?.phonetic && <span className="wp-phonetic">{exp.phonetic}</span>}
        <button className="icon-btn" title="Pronounce" onClick={() => speakWord(word)}><Icon name="volume" /></button>
        <button className="icon-btn wp-close" onClick={onClose}><Icon name="x" /></button>
      </div>

      {!exp && !error && <div className="wp-loading">Generating explanation…</div>}
      {error && <div className="error-text">{error}</div>}

      {exp && (
        <div className="wp-body">
          {exp.source === "mock" && <div className="mock-badge">Offline demo</div>}
          <div className="wp-row"><b>{exp.pos}</b> {exp.meaning_zh}</div>
          <div className="wp-context">{exp.meaning_in_context}</div>
          {exp.collocations?.length > 0 && (
            <div className="wp-row wp-small">Collocations: {exp.collocations.join(" · ")}</div>
          )}
          {exp.forms?.length > 0 && <div className="wp-row wp-small">Forms: {exp.forms.join(" / ")}</div>}
          {exp.examples?.length > 0 && (
            <div className="wp-examples">
              {exp.examples.map((ex, i) => (
                <div key={i}>{ex}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="wp-actions">
        <button className="btn btn-sm btn-primary" disabled={!exp || saved} onClick={() => save("learning")}>
          {saved ? (<><Icon name="check" size={14} /> Saved</>) : (<><Icon name="star" size={14} /> Save</>)}
        </button>
        <button className="btn btn-sm" onClick={() => save("known")}>I know this</button>
        <button className="btn btn-sm" onClick={() => { onAskAI(word, sentence); onClose(); }}>Ask AI</button>
      </div>
    </div>
  );
}
