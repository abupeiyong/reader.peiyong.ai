import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { PageAnalysis, User } from "../../shared/types";
import { pdfjs, loadPdf, type PDFDocumentProxy } from "../lib/pdf";
import { extractPage, splitSentences, type Paragraph } from "../lib/pdfText";
import { extractToc, type TocItem } from "../lib/toc";
import PdfViewer, { type WordClickInfo } from "../components/PdfViewer";
import WordPopover from "../components/WordPopover";
import AnalysisTab from "../components/AnalysisTab";
import ChatTab from "../components/ChatTab";
import VocabTab from "../components/VocabTab";
import ReadAloudBar from "../components/ReadAloudBar";
import ReviewModal from "../components/ReviewModal";
import { Icon } from "../components/Icon";

interface BookMeta {
  id: string;
  title: string;
  page_count: number;
  status: string;
}

type Tab = "analysis" | "chat" | "vocab";

export default function ReaderPage({
  bookId,
  user,
  onUserChange,
}: {
  bookId: string;
  user: User;
  onUserChange: (u: User | null) => void;
}) {
  const [book, setBook] = useState<BookMeta | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [zoom, setZoom] = useState(1.2);
  const [paragraphs, setParagraphs] = useState<Paragraph[]>([]);
  const [tab, setTab] = useState<Tab>("analysis");
  const [popover, setPopover] = useState<WordClickInfo | null>(null);
  const [selection, setSelection] = useState("");
  const [chatPrefill, setChatPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [vocabNonce, setVocabNonce] = useState(0);
  const [knownWords, setKnownWords] = useState<Set<string>>(new Set());
  const [analysis, setAnalysis] = useState<PageAnalysis | null>(null);
  const [modelHints, setModelHints] = useState<string[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [pageHasText, setPageHasText] = useState(true);
  const [showHints, setShowHints] = useState(user.hints_enabled === 1);
  const [flashPage, setFlashPage] = useState(0);
  const [ttsCommand, setTtsCommand] = useState<{ action: "playParagraph" | "playPage"; index: number; nonce: number } | null>(null);
  const [ttsHighlight, setTtsHighlight] = useState<{ paraIndex: number; sentIndex: number } | null>(null);
  const [showTtsBar, setShowTtsBar] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<{ page_no: number; snippet: string }[] | null>(null);
  const [error, setError] = useState("");
  const [showReview, setShowReview] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [timer, setTimer] = useState<{ ms: number; paused: boolean }>({ ms: 0, paused: false });
  const [textDamaged, setTextDamaged] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const pageAreaRef = useRef<HTMLDivElement>(null);

  const saveNote = async () => {
    if (!noteText.trim()) return;
    setNoteBusy(true);
    try {
      await api.post("/api/notes", { book_id: bookId, page_no: pageNo, quote: selection || undefined, note: noteText });
      setNoteText("");
      setShowNote(false);
    } finally {
      setNoteBusy(false);
    }
  };

  // 加载书 + PDF + 进度 + 已认识单词
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meta = await api.get<BookMeta>(`/api/books/${bookId}`);
        if (cancelled) return;
        setBook(meta);
        const progress = await api.get<{ page_no: number; zoom: number }>(`/api/books/${bookId}/progress`);
        if (cancelled) return;
        setPageNo(Math.max(1, progress.page_no));
        if (progress.zoom) setZoom(progress.zoom);
        const known = await api.get<string[]>("/api/known-words");
        if (!cancelled) setKnownWords(new Set(known));
        const loaded = await loadPdf({ url: `/api/books/${bookId}/file` }).promise;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setDoc(loaded);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  useEffect(() => {
    return () => {
      void doc?.destroy();
    };
  }, [doc]);

  // 阅读计时:进书开始,离开结束;1 分钟无操作暂停计时(计入 idle 并记一次中断),有操作恢复
  useEffect(() => {
    let sessionId: string | null = null;
    let disposed = false;
    let active = 0;
    let idle = 0;
    let pauses = 0;
    let paused = false;
    let lastAct = Date.now();
    const IDLE_MS = 60 * 1000;

    api
      .post<{ id: string }>("/api/reading-sessions", { book_id: bookId })
      .then((r) => {
        if (!disposed) sessionId = r.id;
      })
      .catch(() => {});

    const onAct = () => {
      lastAct = Date.now();
      if (paused) {
        paused = false;
        setTimer({ ms: active, paused: false });
      }
    };
    const events = ["mousemove", "mousedown", "keydown", "scroll", "wheel", "touchstart"];
    events.forEach((e) => window.addEventListener(e, onAct, { passive: true }));

    const tick = window.setInterval(() => {
      if (document.hidden) return; // 切走标签页不计时
      if (Date.now() - lastAct > IDLE_MS) {
        if (!paused) {
          paused = true;
          pauses += 1;
        }
        idle += 1000;
      } else {
        active += 1000;
      }
      setTimer({ ms: active, paused });
    }, 1000);

    const save = (keepalive: boolean) => {
      if (!sessionId) return;
      void fetch(`/api/reading-sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active_ms: active, idle_ms: idle, pauses }),
        keepalive,
      }).catch(() => {});
    };
    const hb = window.setInterval(() => save(false), 20000); // 心跳保存,防丢

    return () => {
      disposed = true;
      clearInterval(tick);
      clearInterval(hb);
      events.forEach((e) => window.removeEventListener(e, onAct));
      save(true); // 离开时用 keepalive 可靠上报
      setTimer({ ms: 0, paused: false });
    };
  }, [bookId]);

  // 章节目录:优先 PDF outline,无则后端启发式兜底
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    extractToc(doc).then(async (t) => {
      if (cancelled) return;
      if (t.length > 0) {
        setToc(t);
        return;
      }
      try {
        const server = await api.get<TocItem[]>(`/api/books/${bookId}/toc`);
        if (!cancelled) setToc(server);
      } catch {
        /* 无目录 */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [doc, bookId]);

  // 当前页段落(用于朗读与句子定位)
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc.getPage(pageNo).then(async (p) => {
      const ex = await extractPage(p);
      if (!cancelled) {
        setParagraphs(ex.paragraphs);
        setPageHasText(ex.text.trim().length > 20);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNo]);

  // 个性化生词提示(词汇模型)
  useEffect(() => {
    setModelHints([]);
    let cancelled = false;
    api
      .get<{ words: string[] }>(`/api/books/${bookId}/pages/${pageNo}/hints`)
      .then((r) => !cancelled && setModelHints(r.words))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookId, pageNo]);

  // 扫描页 OCR:渲染当前页为图片交给视觉模型识别
  const runOcr = useCallback(async () => {
    if (!doc || ocrBusy) return;
    setOcrBusy(true);
    try {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("Could not render the page image");
      const res = await fetch(`/api/books/${bookId}/pages/${pageNo}/ocr`, { method: "POST", body: blob });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `OCR failed (${res.status})`);
      }
      const { text } = (await res.json()) as { text: string };
      // 用 OCR 文本合成段落(无版面坐标,按序排布),让解析/朗读/聊天可用
      const paras = text
        .split(/\n{2,}/)
        .map((t) => t.replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 0);
      setParagraphs(
        paras.map((t, i) => ({ text: t, top: 40 + i * 60, left: 40, lineHeight: 16, sentences: splitSentences(t) }))
      );
      setPageHasText(true);
    } catch (e) {
      alert(`OCR failed: ${(e as Error).message}`);
    } finally {
      setOcrBusy(false);
    }
  }, [doc, pageNo, bookId, ocrBusy]);

  // 保存进度(防抖)
  const saveProgress = useRef<number | null>(null);
  useEffect(() => {
    if (!book) return;
    if (saveProgress.current) clearTimeout(saveProgress.current);
    saveProgress.current = window.setTimeout(() => {
      void api.put(`/api/books/${bookId}/progress`, { page_no: pageNo, zoom });
    }, 800);
  }, [pageNo, zoom, bookId, book]);

  const pageCount = doc?.numPages ?? book?.page_count ?? 1;

  const gotoPage = useCallback(
    (p: number, flash = false) => {
      const clamped = Math.min(Math.max(1, p), pageCount);
      setPageNo(clamped);
      setPopover(null);
      setSelection("");
      if (flash) setFlashPage((n) => n + 1);
      pageAreaRef.current?.scrollTo({ top: 0 });
    },
    [pageCount]
  );

  // 键盘翻页
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === "PageDown") gotoPage(pageNo + 1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") gotoPage(pageNo - 1);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [pageNo, gotoPage]);

  // 生词提示集合:词汇模型个性化提示 ∪ 本页解析生词,减去已认识的词
  const hintWords = useMemo(() => {
    const set = new Set<string>();
    for (const w of modelHints) {
      if (!knownWords.has(w)) set.add(w);
    }
    for (const v of analysis?.vocabulary ?? []) {
      const w = v.word.toLowerCase();
      if (!knownWords.has(w)) set.add(w);
    }
    return set;
  }, [analysis, knownWords, modelHints]);

  const markKnown = useCallback(
    (word: string) => {
      const w = word.toLowerCase();
      setKnownWords((prev) => new Set(prev).add(w));
      void api.post("/api/word-events", { word: w, action: "known", book_id: bookId, page_no: pageNo });
    },
    [bookId, pageNo]
  );

  const saveWordFromAnalysis = useCallback(
    async (word: string, meaning: string) => {
      // 从当前页找到该词所在的句子一并保存,方便日后按句复习
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const sentence = paragraphs.flatMap((p) => p.sentences).find((s) => re.test(s)) ?? null;
      await api.post("/api/vocab", {
        word,
        context_sentence: sentence,
        book_id: bookId,
        page_no: pageNo,
        explanation: { word, meaning_zh: meaning, meaning_in_context: meaning },
      });
      setVocabNonce((n) => n + 1);
    },
    [bookId, pageNo, paragraphs]
  );

  const askAI = useCallback((word: string, sentence: string) => {
    setTab("chat");
    setChatPrefill({ text: `In the sentence "${sentence}", what does "${word}" mean? Please explain its usage in depth.`, nonce: Date.now() });
  }, []);

  const doSearch = async () => {
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    const r = await api.get<{ page_no: number; snippet: string }[]>(
      `/api/books/${bookId}/search?q=${encodeURIComponent(search.trim())}`
    );
    setSearchResults(r);
  };

  const toggleHints = async () => {
    const next = !showHints;
    setShowHints(next);
    void api.patch("/api/me", { hints_enabled: next ? 1 : 0 });
  };

  if (error) {
    return (
      <div className="center-screen">
        <div>
          <p className="error-text">Failed to load: {error}</p>
          <button className="btn" onClick={() => (location.hash = "#/")}>Back to library</button>
        </div>
      </div>
    );
  }

  return (
    <div className="reader">
      <header className="reader-header">
        <button className="btn btn-ghost" onClick={() => (location.hash = "#/")}><Icon name="arrow-left" /> Library</button>
        {toc.length > 0 && (
          <button className="icon-btn" title="Table of contents" onClick={() => setShowToc(true)}>
            <Icon name="list" />
          </button>
        )}
        <div className="reader-title" title={book?.title}>{book?.title ?? "…"}</div>

        <div
          className={`reader-timer ${timer.paused ? "paused" : ""}`}
          title={timer.paused ? "Paused after 1 min of inactivity — interact to resume" : "Reading time this session"}
        >
          <Icon name="clock" size={14} />
          <span className="timer-val">{fmtTimer(timer.ms)}</span>
          {timer.paused && <span className="timer-tag">paused</span>}
        </div>

        <div className="reader-nav">
          <button className="icon-btn" onClick={() => gotoPage(pageNo - 1)} disabled={pageNo <= 1}><Icon name="chevron-left" /></button>
          <input
            className="page-input"
            type="number"
            value={pageNo}
            min={1}
            max={pageCount}
            onChange={(e) => gotoPage(Number(e.target.value))}
          />
          <span className="page-total">/ {pageCount}</span>
          <button className="icon-btn" onClick={() => gotoPage(pageNo + 1)} disabled={pageNo >= pageCount}><Icon name="chevron-right" /></button>
        </div>

        <div className="reader-zoom">
          <button className="icon-btn" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.15).toFixed(2)))}><Icon name="minus" /></button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="icon-btn" onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.15).toFixed(2)))}><Icon name="plus" /></button>
        </div>

        <div className="reader-search">
          <input
            placeholder="Search text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
          />
          {searchResults && (
            <div className="search-results">
              <div className="search-results-head">
                {searchResults.length} results
                <button className="icon-btn" onClick={() => setSearchResults(null)}><Icon name="x" /></button>
              </div>
              {searchResults.map((r, i) => (
                <div key={i} className="search-result" onClick={() => { gotoPage(r.page_no, true); setSearchResults(null); }}>
                  <b>p.{r.page_no}</b> {r.snippet}
                </div>
              ))}
              {searchResults.length === 0 && <div className="search-result">No matches for "{search}"</div>}
            </div>
          )}
        </div>

        <button
          className={`btn btn-ghost ${showHints ? "" : "dim"}`}
          title={showHints ? "Turn off word hints (immersive mode)" : "Turn on word hints"}
          onClick={toggleHints}
        >
          {showHints ? (<><Icon name="sun" /> Hints On</>) : (<><Icon name="moon" /> Immersive</>)}
        </button>
        <button className="btn btn-ghost" title="Read this page aloud" onClick={() => { setShowTtsBar(true); setTtsCommand({ action: "playPage", index: 0, nonce: Date.now() }); }}>
          <Icon name="volume" /> Read aloud
        </button>
        <button className="btn btn-ghost" title="Add a note" onClick={() => setShowNote(true)}>
          <Icon name="message" /> Note
        </button>
      </header>

      <div className="reader-body">
        <div className="pdf-area" ref={pageAreaRef}>
          {doc && !pageHasText && (
            <div className="ocr-banner">
              <span>This page has no text layer (likely scanned). AI features need the text recognized first.</span>
              <button className="btn btn-sm btn-primary" disabled={ocrBusy} onClick={runOcr}>
                {ocrBusy ? "Recognizing…" : (<><Icon name="search" /> OCR this page</>)}
              </button>
            </div>
          )}
          {doc && pageHasText && textDamaged && (
            <div className="ocr-banner">
              <span>
                This PDF's embedded text layer is corrupted (bad font metrics), so tap-to-look-up, highlights and
                per-paragraph buttons are turned off for it. Reading aloud, page analysis and AI chat still work.
              </span>
            </div>
          )}
          {doc ? (
            <PdfViewer
              doc={doc}
              pageNo={pageNo}
              zoom={zoom}
              paragraphs={paragraphs}
              hintWords={hintWords}
              showHints={showHints}
              flashPage={flashPage}
              onWordClick={(info) => {
                setPopover(info);
              }}
              onSelection={(text) => setSelection(text)}
              onPlayParagraph={(i) => {
                setShowTtsBar(true);
                setTtsCommand({ action: "playParagraph", index: i, nonce: Date.now() });
              }}
              ttsHighlight={ttsHighlight}
              onDamaged={setTextDamaged}
            />
          ) : (
            <div className="center-fill"><div className="spinner" /></div>
          )}
        </div>

        <aside className="side-panel">
          <div className="tabs">
            {(
              [
                ["analysis", "Analysis"],
                ["chat", "AI Chat"],
                ["vocab", "Learning"],
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </div>

          <div className="tab-content" style={{ display: tab === "analysis" ? undefined : "none" }}>
            <AnalysisTab
              bookId={bookId}
              pageNo={pageNo}
              onSaveWord={saveWordFromAnalysis}
              onKnownWord={markKnown}
              onAnalysis={setAnalysis}
            />
          </div>
          <div className="tab-content" style={{ display: tab === "chat" ? undefined : "none" }}>
            <ChatTab
              bookId={bookId}
              pageNo={pageNo}
              selection={selection}
              prefill={chatPrefill}
              onJumpPage={(p) => gotoPage(p, true)}
            />
          </div>
          <div className="tab-content" style={{ display: tab === "vocab" ? undefined : "none" }}>
            <VocabTab refreshNonce={vocabNonce} onKnownWord={markKnown} onStartReview={() => setShowReview(true)} />
          </div>
        </aside>
      </div>

      {showTtsBar && (
        <ReadAloudBar
          paragraphs={paragraphs}
          bookId={bookId}
          pageNo={pageNo}
          command={ttsCommand}
          onHighlight={setTtsHighlight}
          onClose={() => { setShowTtsBar(false); setTtsHighlight(null); }}
          onRecordingSaved={() => setVocabNonce((n) => n + 1)}
        />
      )}

      {showToc && (
        <div className="toc-mask" onClick={() => setShowToc(false)}>
          <div className="toc-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="toc-head">
              <b>Contents</b>
              <button className="icon-btn" onClick={() => setShowToc(false)}><Icon name="x" /></button>
            </div>
            <div className="toc-list">
              {toc.map((t, i) => (
                <button
                  key={i}
                  className={`toc-item ${t.page === pageNo ? "current" : ""}`}
                  style={{ paddingLeft: 14 + t.level * 16 }}
                  disabled={!t.page}
                  onClick={() => {
                    if (t.page) gotoPage(t.page, true);
                    setShowToc(false);
                  }}
                >
                  <span className="toc-title">{t.title}</span>
                  {t.page > 0 && <span className="toc-page">{t.page}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showNote && (
        <div className="modal-mask" onClick={() => setShowNote(false)}>
          <div className="note-modal" onClick={(e) => e.stopPropagation()}>
            <div className="review-head">
              <b>Add note</b>
              <span className="wp-small">Page {pageNo}</span>
              <button className="icon-btn" onClick={() => setShowNote(false)}><Icon name="x" /></button>
            </div>
            <div className="note-body">
              {selection && <div className="note-quote">“{selection.slice(0, 240)}{selection.length > 240 ? "…" : ""}”</div>}
              <textarea
                autoFocus
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder={selection ? "Your note on the selected text…" : "Write a note for this page…"}
                rows={5}
              />
              <div className="note-actions">
                <button className="btn btn-primary btn-sm" disabled={noteBusy || !noteText.trim()} onClick={saveNote}>
                  {noteBusy ? "Saving…" : "Save note"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showReview && (
        <ReviewModal
          onClose={() => {
            setShowReview(false);
            setVocabNonce((n) => n + 1);
          }}
          onChanged={() => {}}
        />
      )}

      {popover && (
        <WordPopover
          word={popover.word}
          sentence={popover.sentence}
          x={popover.x}
          y={popover.y}
          yTop={popover.yTop}
          bookId={bookId}
          pageNo={pageNo}
          onClose={() => setPopover(null)}
          onSaved={() => setVocabNonce((n) => n + 1)}
          onKnown={markKnown}
          onAskAI={askAI}
        />
      )}
    </div>
  );
}

/** 会话计时显示:mm:ss,超 1 小时 h:mm:ss */
function fmtTimer(ms: number): string {
  const s = Math.floor(ms / 1000);
  const sec = String(s % 60).padStart(2, "0");
  const min = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${sec}`;
  return `${min}:${sec}`;
}
