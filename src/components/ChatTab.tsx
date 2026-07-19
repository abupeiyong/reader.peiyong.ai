import { useEffect, useRef, useState } from "react";
import { api, streamChat } from "../api";
import { startRecording, type RecorderController } from "../lib/recorder";
import type { ChatMessage, ChatScope } from "../../shared/types";
import { Icon } from "./Icon";

interface Props {
  bookId: string;
  pageNo: number;
  selection: string; // 当前选中文本(可为空)
  prefill: { text: string; nonce: number } | null; // 外部触发的预填/直接提问
  onJumpPage: (page: number) => void;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

const QUICK_ACTIONS: { label: string; build: (sel: string) => string; needSelection?: boolean }[] = [
  { label: "Explain this", build: (sel) => `Please explain this sentence: "${sel}"`, needSelection: true },
  { label: "Summarize", build: () => "Please summarize the main content of the current page." },
  { label: "Give examples", build: () => "Please give examples of the key concepts on this page." },
  { label: "Quiz me", build: () => "Based on this page, ask me 2-3 comprehension questions (ask first, then give answers after I respond)." },
];

export default function ChatTab({ bookId, pageNo, selection, prefill, onJumpPage }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [scope, setScope] = useState<ChatScope>("page");
  const [busy, setBusy] = useState(false);
  const [micState, setMicState] = useState<"idle" | "recording" | "transcribing">("idle");
  const recRef = useRef<RecorderController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 历史
  useEffect(() => {
    api
      .get<ChatMessage[]>(`/api/books/${bookId}/chat`)
      .then((rows) => setMessages(rows.map((r) => ({ role: r.role, content: r.content }))))
      .catch(() => {});
  }, [bookId]);

  // 外部预填(问 AI / 选中提问)
  useEffect(() => {
    if (prefill) setInput(prefill.text);
  }, [prefill]);

  // 有选中内容时自动把范围切到"选中内容"
  useEffect(() => {
    if (selection) setScope("selection");
    else if (scope === "selection") setScope("page");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = async (text?: string) => {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: message }, { role: "assistant", content: "", streaming: true }]);
    await streamChat(
      { book_id: bookId, page_no: pageNo, scope, selection: selection || undefined, message },
      (delta) =>
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + delta };
          return copy;
        }),
      () => {
        setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? { ...msg, streaming: false } : msg)));
        setBusy(false);
      },
      (err) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + `\n\nError: ${err}`, streaming: false };
          return copy;
        });
        setBusy(false);
      }
    );
  };

  // 语音输入:录音 → Whisper 转写(不可用时回退浏览器识别)→ 填入输入框
  const toggleMic = async () => {
    if (micState === "recording") {
      setMicState("transcribing");
      try {
        const { blob, transcript } = await recRef.current!.stop();
        recRef.current = null;
        let text = "";
        try {
          const res = await fetch("/api/speech/stt", { method: "POST", body: blob });
          if (res.ok) text = ((await res.json()) as { text: string }).text;
        } catch {
          /* ignore */
        }
        if (!text.trim()) text = transcript;
        if (text.trim()) setInput((prev) => (prev ? prev + " " : "") + text.trim());
        else alert("No speech was recognized. Please try again.");
      } finally {
        setMicState("idle");
      }
      return;
    }
    if (micState !== "idle") return;
    try {
      recRef.current = await startRecording();
      setMicState("recording");
    } catch {
      alert("Cannot access the microphone. Please check browser permissions.");
    }
  };

  useEffect(() => {
    return () => recRef.current?.cancel();
  }, []);

  const clear = async () => {
    if (!confirm("Clear the chat history for this book?")) return;
    await api.del(`/api/books/${bookId}/chat`);
    setMessages([]);
  };

  return (
    <div className="chat-tab">
      <div className="chat-scope">
        <span>Scope:</span>
        {(
          [
            ["selection", "Selection"],
            ["page", "Page"],
            ["document", "Whole book"],
          ] as [ChatScope, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            className={`chip ${scope === v ? "active" : ""}`}
            disabled={v === "selection" && !selection}
            onClick={() => setScope(v)}
          >
            {label}
          </button>
        ))}
        <button className="icon-btn chat-clear" title="Clear chat" onClick={clear}><Icon name="trash" /></button>
      </div>

      {selection && scope === "selection" && (
        <div className="chat-selection">Selected: “{selection.slice(0, 80)}{selection.length > 80 ? "…" : ""}”</div>
      )}

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask AI about your selection, this page, or the whole book.
            <br />
            Page references like <span className="page-ref-demo">[p.3]</span> in answers jump back to the source.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">
              {renderContent(m.content, onJumpPage)}
              {m.streaming && <span className="cursor-blink">▌</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-quick">
        {QUICK_ACTIONS.map((qa) => (
          <button
            key={qa.label}
            className="chip"
            disabled={busy || (qa.needSelection && !selection)}
            onClick={() => send(qa.build(selection))}
          >
            {qa.label}
          </button>
        ))}
      </div>

      <div className="chat-input-row">
        <button
          className={`icon-btn mic-btn ${micState}`}
          title={micState === "recording" ? "Stop and transcribe" : "Voice input"}
          disabled={micState === "transcribing"}
          onClick={toggleMic}
        >
          {micState === "recording" ? <Icon name="stop" /> : micState === "transcribing" ? "…" : <Icon name="mic" />}
        </button>
        <textarea
          value={input}
          placeholder="Type a question. Enter to send, Shift+Enter for newline"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn btn-primary" disabled={busy || !input.trim()} onClick={() => send()}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

/** 渲染消息内容,把 [p.N] 变成可点击引用 */
function renderContent(content: string, onJumpPage: (p: number) => void) {
  const parts = content.split(/(\[p\.?\s*\d+\])/gi);
  return parts.map((part, i) => {
    const m = part.match(/^\[p\.?\s*(\d+)\]$/i);
    if (m) {
      const page = Number(m[1]);
      return (
        <button key={i} className="page-ref" title={`Go to page ${page}`} onClick={() => onJumpPage(page)}>
          p.{page}
        </button>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
