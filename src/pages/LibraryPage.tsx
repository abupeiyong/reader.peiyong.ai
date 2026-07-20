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
  const [editing, setEditing] = useState<Book | null>(null);
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

      setUploading("Generating cover…");
      await api.post(`/api/books/${id}/cover`).catch(() => {}); // 封面失败不影响上传
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
                {b.cover_key ? (
                  <img
                    className="book-cover-img"
                    src={`/api/books/${b.id}/cover?v=${encodeURIComponent(b.cover_key)}`}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <span>{b.title.slice(0, 40)}</span>
                )}
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
                className="btn btn-ghost book-edit"
                title="Edit"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(b);
                }}
              >
                <Icon name="edit" />
              </button>
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

      {editing && <EditBookModal book={editing} onClose={() => setEditing(null)} onChanged={load} />}

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

/** 编辑书籍:改书名 + 重新生成封面 */
function EditBookModal({
  book,
  onClose,
  onChanged,
}: {
  book: Book;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [coverKey, setCoverKey] = useState(book.cover_key ?? null);
  const [busy, setBusy] = useState<"regen" | "save" | null>(null);
  const [err, setErr] = useState("");

  const saveTitle = async () => {
    const t = title.trim();
    if (t && t !== book.title) await api.patch(`/api/books/${book.id}`, { title: t });
  };

  const regenerate = async () => {
    setErr("");
    setBusy("regen");
    try {
      await saveTitle(); // 用最新书名生成封面
      const { cover_key } = await api.post<{ cover_key: string }>(`/api/books/${book.id}/cover`);
      setCoverKey(cover_key);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setErr("");
    setBusy("save");
    try {
      await saveTitle();
      onChanged();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="note-modal book-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="review-head">
          <b>Edit book</b>
          <button className="btn btn-ghost" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="edit-body">
          <div className="edit-cover">
            {coverKey ? (
              <img src={`/api/books/${book.id}/cover?v=${encodeURIComponent(coverKey)}`} alt="" />
            ) : (
              <Icon name="book" size={30} />
            )}
            {busy === "regen" && <div className="edit-cover-busy">Generating…</div>}
          </div>
          <label className="edit-label" htmlFor="edit-title">Title</label>
          <input
            id="edit-title"
            className="edit-title-input"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
          {err && <div className="error-text">{err}</div>}
          <div className="edit-actions">
            <button className="btn" disabled={!!busy} onClick={regenerate}>
              <Icon name="refresh" /> {busy === "regen" ? "Regenerating…" : "Regenerate cover"}
            </button>
            <button className="btn btn-primary" disabled={!!busy || !title.trim()} onClick={save}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
