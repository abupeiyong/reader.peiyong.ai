import { useEffect, useRef, useState } from "react";
import type { Paragraph } from "../lib/pdfText";
import { speakSentences, type Accent, type TtsController } from "../lib/speech";
import { startRecording, type RecorderController } from "../lib/recorder";
import { api } from "../api";
import type { RecordingFeedback } from "../../shared/types";
import { Icon } from "./Icon";

interface Props {
  paragraphs: Paragraph[];
  bookId: string;
  pageNo: number;
  command: { action: "playParagraph" | "playPage"; index: number; nonce: number } | null;
  onHighlight: (h: { paraIndex: number; sentIndex: number } | null) => void;
  onClose: () => void;
  onRecordingSaved: () => void;
}

type Mode = "idle" | "playing" | "paused" | "recording" | "uploading" | "feedback";

export default function ReadAloudBar({ paragraphs, bookId, pageNo, command, onHighlight, onClose, onRecordingSaved }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [accent, setAccent] = useState<Accent>("US");
  const [rate, setRate] = useState(1.0);
  const [paraIndex, setParaIndex] = useState(0);
  const [sentIndex, setSentIndex] = useState(0);
  const [feedback, setFeedback] = useState<RecordingFeedback | null>(null);
  const ttsRef = useRef<TtsController | null>(null);
  const recRef = useRef<RecorderController | null>(null);
  const accentRef = useRef(accent);
  const rateRef = useRef(rate);
  accentRef.current = accent;
  rateRef.current = rate;

  const para = paragraphs[paraIndex];

  const stopAll = () => {
    ttsRef.current?.stop();
    ttsRef.current = null;
    onHighlight(null);
  };

  const play = (pIdx: number, sIdx = 0) => {
    stopAll();
    const target = paragraphs[pIdx];
    if (!target || target.sentences.length === 0) return;
    setParaIndex(pIdx);
    setSentIndex(sIdx);
    setMode("playing");
    ttsRef.current = speakSentences(target.sentences, {
      accent: accentRef.current,
      rate: rateRef.current,
      startIndex: sIdx,
      onSentence: (i) => {
        setSentIndex(i);
        onHighlight({ paraIndex: pIdx, sentIndex: i });
      },
      onEnd: () => {
        // 整页模式:继续下一段
        const next = findNextReadable(paragraphs, pIdx);
        if (pageModeRef.current && next !== -1) {
          play(next, 0);
        } else {
          setMode("idle");
          onHighlight(null);
        }
      },
    });
  };

  const pageModeRef = useRef(false);

  // 外部命令(段落按钮 / 播放本页)
  useEffect(() => {
    if (!command) return;
    pageModeRef.current = command.action === "playPage";
    const idx = command.action === "playPage" ? findNextReadable(paragraphs, -1) : command.index;
    if (idx !== -1) play(idx, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // 卸载 & 翻页时停止
  useEffect(() => {
    return () => {
      ttsRef.current?.stop();
      recRef.current?.cancel();
    };
  }, []);
  useEffect(() => {
    stopAll();
    setMode("idle");
    setFeedback(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNo]);

  const pause = () => {
    ttsRef.current?.pause();
    setMode("paused");
  };
  const resume = () => {
    ttsRef.current?.resume();
    setMode("playing");
  };
  const stop = () => {
    stopAll();
    setMode("idle");
  };

  const recStartRef = useRef(0);

  const startRecord = async () => {
    stopAll();
    setFeedback(null);
    try {
      recRef.current = await startRecording();
      recStartRef.current = Date.now();
      setMode("recording");
    } catch {
      alert("Cannot access the microphone. Please check browser permissions.");
      setMode("idle");
    }
  };

  const stopRecord = async () => {
    if (!recRef.current) return;
    setMode("uploading");
    try {
      const { blob, transcript } = await recRef.current.stop();
      recRef.current = null;
      const form = new FormData();
      form.append("audio", new File([blob], "rec.webm", { type: blob.type }));
      form.append("ref_text", para?.text ?? "");
      form.append("browser_transcript", transcript);
      form.append("book_id", bookId);
      form.append("page_no", String(pageNo));
      form.append("duration_ms", String(Date.now() - recStartRef.current));
      const res = await api.postForm<{ id: string; feedback: RecordingFeedback }>("/api/recordings", form);
      setFeedback(res.feedback);
      setMode("feedback");
      onRecordingSaved();
    } catch (e) {
      alert(`Upload failed: ${(e as Error).message}`);
      setMode("idle");
    }
  };

  const cancelRecord = () => {
    recRef.current?.cancel();
    recRef.current = null;
    setMode("idle");
  };

  if (paragraphs.length === 0) return null;

  return (
    <div className="tts-bar">
      <div className="tts-controls">
        {mode === "playing" ? (
          <button className="icon-btn big" title="Pause" onClick={pause}><Icon name="pause" size={20} /></button>
        ) : mode === "paused" ? (
          <button className="icon-btn big" title="Resume" onClick={resume}><Icon name="play" size={20} /></button>
        ) : (
          <button
            className="icon-btn big"
            title="Read this page aloud"
            onClick={() => {
              pageModeRef.current = true;
              const idx = findNextReadable(paragraphs, -1);
              if (idx !== -1) play(idx);
            }}
          >
            <Icon name="play" size={20} />
          </button>
        )}
        <button className="icon-btn" title="Stop" onClick={stop}><Icon name="stop" size={17} /></button>

        <select value={accent} onChange={(e) => setAccent(e.target.value as Accent)} title="Accent">
          <option value="US">US</option>
          <option value="GB">UK</option>
        </select>

        <label className="tts-rate">
          Speed {rate.toFixed(1)}x
          <input type="range" min="0.5" max="1.5" step="0.1" value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </label>

        {mode === "recording" ? (
          <>
            <span className="rec-dot">● Recording</span>
            <button className="btn btn-sm btn-primary" onClick={stopRecord}>Done</button>
            <button className="btn btn-sm" onClick={cancelRecord}>Cancel</button>
          </>
        ) : mode === "uploading" ? (
          <span className="wp-small">Evaluating…</span>
        ) : (
          <button className="btn btn-sm" title="Read this paragraph aloud and get feedback" onClick={startRecord}><Icon name="mic" /> Practice</button>
        )}

        <button className="icon-btn tts-close" title="Close" onClick={() => { stop(); onClose(); }}><Icon name="x" /></button>
      </div>

      {(mode === "playing" || mode === "paused") && para && (() => {
        // 播放进度条:整页模式覆盖全页可读句子,段落模式只覆盖当前段;点击跳到对应句
        const scope: { p: number; s: number }[] = [];
        if (pageModeRef.current) {
          for (let p = 0; p < paragraphs.length; p++) {
            if (paragraphs[p].sentences.length === 0 || paragraphs[p].text.split(" ").length < 4) continue;
            for (let s = 0; s < paragraphs[p].sentences.length; s++) scope.push({ p, s });
          }
        } else {
          for (let s = 0; s < para.sentences.length; s++) scope.push({ p: paraIndex, s });
        }
        const cur = Math.max(0, scope.findIndex((x) => x.p === paraIndex && x.s === sentIndex));
        const pct = scope.length ? ((cur + 1) / scope.length) * 100 : 0;
        const seek = (e: React.MouseEvent<HTMLDivElement>) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = Math.min(0.999, Math.max(0, (e.clientX - rect.left) / rect.width));
          const target = scope[Math.floor(frac * scope.length)];
          if (target) play(target.p, target.s);
        };
        return (
          <div className="tts-progress-row">
            <div
              className="tts-progress"
              role="slider"
              aria-label="Playback position"
              aria-valuemin={1}
              aria-valuemax={scope.length}
              aria-valuenow={cur + 1}
              title="Click to jump"
              onClick={seek}
            >
              <div className="tts-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="tts-progress-count">{cur + 1} / {scope.length}</span>
          </div>
        );
      })()}

      {mode === "recording" && para && (
        <div className="tts-sentences record-ref">
          <b>Read aloud:</b> {para.text}
        </div>
      )}

      {mode === "feedback" && feedback && (
        <div className="feedback-panel">
          <div className="feedback-row">
            <span className={`coverage big ${feedback.coverage >= 80 ? "good" : feedback.coverage >= 50 ? "ok" : "bad"}`}>
              Completeness {feedback.coverage}%
            </span>
            <span className="wp-small">
              {feedback.matched_count}/{feedback.ref_word_count} words matched
              {feedback.wpm ? ` · ${feedback.wpm} wpm` : ""}
              {feedback.source === "browser" ? " · browser recognition" : ""}
            </span>
            <button className="icon-btn" title="Close feedback" onClick={() => setMode("idle")}><Icon name="x" /></button>
          </div>
          {feedback.transcript && <div className="wp-small">Recognized as: “{feedback.transcript}”</div>}
          {feedback.missed_words.length > 0 && (
            <div className="feedback-words">
              Missed: 
              {feedback.missed_words.slice(0, 12).map((w) => (
                <span key={w} className="chip miss">{w}</span>
              ))}
            </div>
          )}
          <div className="feedback-suggest">{feedback.suggestions}</div>
          <div>
            <button className="btn btn-sm" onClick={() => play(paraIndex, 0)}><Icon name="volume" /> Hear original</button>
            <button className="btn btn-sm" onClick={startRecord}><Icon name="mic" /> Try again</button>
          </div>
        </div>
      )}
    </div>
  );
}

function findNextReadable(paragraphs: Paragraph[], after: number): number {
  for (let i = after + 1; i < paragraphs.length; i++) {
    if (paragraphs[i].sentences.length > 0 && paragraphs[i].text.split(" ").length >= 4) return i;
  }
  return -1;
}
