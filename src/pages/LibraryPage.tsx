import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Book, User } from "../../shared/types";
import { loadPdf } from "../lib/pdf";
import { extractAllPages } from "../lib/pdfText";
import StatsPanel from "../components/StatsPanel";
import CalendarPanel from "../components/CalendarPanel";
import ReviewModal from "../components/ReviewModal";
import TelegramCard from "../components/TelegramCard";
import { Icon } from "../components/Icon";

export default function LibraryPage({
  user,
  onUserChange,
}: {
  user: User;
  onUserChange: (u: User | null) => void;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [dueCount, setDueCount] = useState(0);
  const [showReview, setShowReview] = useState(false);
  const [statsNonce, setStatsNonce] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.get<Book[]>("/api/books").then(setBooks).catch((e) => setError((e as Error).message));
    api.get<{ due_count: number }>("/api/review/queue").then((q) => setDueCount(q.due_count)).catch(() => {});
  }, []);

  useEffect(load, [load]);

  const upload = async (file: File) => {
    setError("");
    setUploading("Uploading…");
    try {
      const form = new FormData();
      form.append("file", file);
      const { id } = await api.postForm<{ id: string }>("/api/books", form);

      // 客户端提取文本(临时方案:免去服务端解析;后续可迁移到 Queues)
      setUploading("Extracting text…");
      const buf = await file.arrayBuffer();
      const doc = await loadPdf({ data: buf }).promise;
      const extracts = await extractAllPages(doc, (done, total) => {
        setUploading(`Extracting text ${done}/${total} pages…`);
      });
      await doc.destroy();

      setUploading("Saving…");
      await api.post(`/api/books/${id}/pages`, {
        page_count: extracts.length,
        pages: extracts.map((p, i) => ({ page_no: i + 1, text: p.text })),
      });
      load();
    } catch (e) {
      setError(`Upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async (b: Book) => {
    if (!confirm(`Delete "${b.title}"? Its PDF, analysis, and related records will all be removed.`)) return;
    await api.del(`/api/books/${b.id}`);
    load();
  };

  const logout = async () => {
    await api.post("/api/auth/logout");
    onUserChange(null);
  };

  return (
    <div className="library">
      <header className="lib-header">
        <div className="lib-brand"><Icon name="book" size={20} /> Immersive Reader</div>
        <div className="lib-user">
          <span>{user.name || user.email}</span>
          <button className="btn btn-ghost" onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="lib-main">
        <div className="lib-toolbar">
          <h2>My Library</h2>
          <div className="lib-actions">
            <button className="btn" onClick={() => setShowReview(true)}>
              <Icon name="repeat" /> Review{dueCount > 0 ? ` (${dueCount})` : ""}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
            <button className="btn btn-primary" disabled={!!uploading} onClick={() => fileRef.current?.click()}>
              {uploading ?? (<><Icon name="plus" /> Upload PDF</>)}
            </button>
          </div>
        </div>

        {error && <div className="error-text">{error}</div>}

        {books.length === 0 && !uploading && (
          <div className="empty-state">
            <div className="empty-icon"><Icon name="book" size={44} /></div>
            <p>Your library is empty. Upload an English book or paper to start reading.</p>
            <p className="hint-text">Text-layer PDFs are supported; scanned pages can be OCR-recognized page by page while reading.</p>
          </div>
        )}

        <div className="book-grid">
          {books.map((b) => (
            <div key={b.id} className="book-card" onClick={() => (location.hash = `#/read/${b.id}`)}>
              <div className="book-cover">
                <span>{b.title.slice(0, 40)}</span>
              </div>
              <div className="book-info">
                <div className="book-title" title={b.title}>{b.title}</div>
                <div className="book-meta">
                  {b.page_count > 0 ? `${b.page_count} pages` : "…"}
                  {b.progress_page ? ` · on page ${b.progress_page}` : ""}
                  {b.status !== "ready" && <span className="badge">{b.status === "processing" ? "Processing" : b.status}</span>}
                </div>
              </div>
              <button
                className="btn btn-ghost book-del"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(b);
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>

        <StatsPanel refreshNonce={statsNonce} />
        <CalendarPanel refreshNonce={statsNonce} />
        <TelegramCard />
      </main>

      {showReview && (
        <ReviewModal
          onClose={() => {
            setShowReview(false);
            load();
            setStatsNonce((n) => n + 1);
          }}
          onChanged={() => {}}
        />
      )}
    </div>
  );
}
