import { useEffect, useState } from "react";
import { api } from "../api";
import type { PageAnalysis } from "../../shared/types";
import { speakWord } from "../lib/speech";
import { Icon } from "./Icon";

interface Props {
  bookId: string;
  pageNo: number;
  onSaveWord: (word: string, meaning: string) => void | Promise<void>;
  onKnownWord: (word: string) => void;
  onAnalysis: (a: PageAnalysis | null) => void; // 把生词列表交给阅读区做轻量标记
}

export default function AnalysisTab({ bookId, pageNo, onSaveWord, onKnownWord, onAnalysis }: Props) {
  const [analysis, setAnalysis] = useState<PageAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [known, setKnown] = useState<Set<string>>(new Set());

  const doSave = async (word: string, meaning: string) => {
    setSaved((s) => new Set(s).add(word)); // 乐观反馈
    try {
      await onSaveWord(word, meaning);
    } catch {
      setSaved((s) => {
        const n = new Set(s);
        n.delete(word);
        return n;
      });
    }
  };
  const doKnown = (word: string) => {
    setKnown((s) => new Set(s).add(word));
    onKnownWord(word);
  };

  useEffect(() => {
    setAnalysis(null);
    setError("");
    setSaved(new Set());
    setKnown(new Set());
    let cancelled = false;
    api
      .get<{ text: string; analysis: PageAnalysis | null }>(`/api/books/${bookId}/pages/${pageNo}`)
      .then((r) => {
        if (cancelled) return;
        setAnalysis(r.analysis);
        onAnalysis(r.analysis);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, pageNo]);

  const generate = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const a = await api.post<PageAnalysis>(`/api/books/${bookId}/pages/${pageNo}/analysis${force ? "?force=1" : ""}`);
      setAnalysis(a);
      onAnalysis(a);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tab-body">
      {!analysis && (
        <div className="analysis-empty">
          <p>AI will analyze this page’s new words, phrases, and complex sentences, and provide background.</p>
          <button className="btn btn-primary" disabled={loading} onClick={() => generate()}>
            {loading ? "Analyzing…" : (<><Icon name="sparkles" /> Analyze this page</>)}
          </button>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}

      {analysis && (
        <>
          {analysis.source === "mock" && <div className="mock-badge">Offline demo (real AI runs automatically once online)</div>}

          {analysis.vocabulary.length > 0 && (
            <section className="ana-section">
              <h4><Icon name="bookmark" /> Likely New Words</h4>
              {analysis.vocabulary.map((v, i) => (
                <div key={i} className="ana-vocab-item">
                  <div className="ana-vocab-word">
                    <b>{v.word}</b>
                    {v.phonetic && <span className="wp-phonetic">{v.phonetic}</span>}
                    <button className="icon-btn" title="Pronounce" onClick={() => speakWord(v.word)}><Icon name="volume" /></button>
                  </div>
                  <div className="ana-vocab-meaning">{v.meaning}</div>
                  <div className="ana-vocab-actions">
                    {saved.has(v.word) ? (
                      <span className="ana-saved"><Icon name="check" size={13} /> Saved</span>
                    ) : known.has(v.word) ? (
                      <span className="wp-small">Marked as known</span>
                    ) : (
                      <>
                        <button className="link-btn" onClick={() => doSave(v.word, v.meaning)}><Icon name="star" /> Save</button>
                        <button className="link-btn" onClick={() => doKnown(v.word)}>I know this</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </section>
          )}

          {analysis.phrases.length > 0 && (
            <section className="ana-section">
              <h4><Icon name="link" /> Phrases & Collocations</h4>
              {analysis.phrases.map((p, i) => (
                <div key={i} className="ana-item">
                  <b>{p.phrase}</b>
                  <span>{p.meaning}</span>
                </div>
              ))}
            </section>
          )}

          {analysis.sentences.length > 0 && (
            <section className="ana-section">
              <h4><Icon name="text" /> Complex Sentences</h4>
              {analysis.sentences.map((s, i) => (
                <div key={i} className="ana-sentence">
                  <div className="ana-sentence-en">“{s.sentence}”</div>
                  <div className="ana-sentence-zh">{s.explanation}</div>
                </div>
              ))}
            </section>
          )}

          {analysis.background && (
            <section className="ana-section">
              <h4><Icon name="bulb" /> Background</h4>
              <p className="ana-bg">{analysis.background}</p>
            </section>
          )}

          <button className="btn btn-sm btn-ghost" disabled={loading} onClick={() => generate(true)}>
            {loading ? "Re-analyzing…" : (<><Icon name="refresh" /> Re-analyze this page</>)}
          </button>
        </>
      )}
    </div>
  );
}
