import { useEffect, useRef, useState } from "react";
import type { Paragraph } from "../lib/pdfText";
import { speakSentences, type Accent, type TtsController } from "../lib/speech";
import { Icon } from "./Icon";

interface Props {
  paragraphs: Paragraph[];
  pageNo: number;
  command: { action: "playParagraph" | "playPage"; index: number; nonce: number } | null;
  onHighlight: (h: { paraIndex: number; sentIndex: number } | null) => void;
  onClose: () => void;
}

type Mode = "idle" | "playing" | "paused";

export default function ReadAloudBar({ paragraphs, pageNo, command, onHighlight, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [accent, setAccent] = useState<Accent>("US");
  const [rate, setRate] = useState(1.0);
  const [paraIndex, setParaIndex] = useState(0);
  const [sentIndex, setSentIndex] = useState(0);
  const ttsRef = useRef<TtsController | null>(null);
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
      onBlocked: () => {
        // 浏览器拒绝了自动播放:显示成暂停,用户点一下(带手势)就能继续
        setMode("paused");
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
    };
  }, []);
  // 翻页时停止。注意只在 pageNo 真的变了时才停:
  // 挂载时这个 effect 也会跑一次,而此时上面的 command effect 已经起了播放,
  // 无条件 stopAll 会把它掐掉 —— 表现就是「朗读栏没开着时,第一次点播放没反应」。
  const lastPageRef = useRef(pageNo);
  useEffect(() => {
    if (lastPageRef.current === pageNo) return;
    lastPageRef.current = pageNo;
    stopAll();
    setMode("idle");
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

    </div>
  );
}

function findNextReadable(paragraphs: Paragraph[], after: number): number {
  for (let i = after + 1; i < paragraphs.length; i++) {
    if (paragraphs[i].sentences.length > 0 && paragraphs[i].text.split(" ").length >= 4) return i;
  }
  return -1;
}
