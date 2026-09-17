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
  /** 还有下一页可读(整页朗读读完后自动续播用) */
  hasNextPage: boolean;
  /** 连续播放时翻到下一页 */
  onNextPage: () => void;
  /** 常驻模式(手机端):朗读栏不可关闭,隐藏关闭按钮 */
  persistent?: boolean;
}

type Mode = "idle" | "playing" | "paused";

/** 连续播放时最多连翻几页空白/插图页,避免在无文本的书里一直翻下去 */
const MAX_SKIP_PAGES = 3;

export default function ReadAloudBar({
  paragraphs,
  pageNo,
  command,
  onHighlight,
  onClose,
  hasNextPage,
  onNextPage,
  persistent,
}: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [accent, setAccent] = useState<Accent>("US");
  const [rate, setRate] = useState(1.0);
  const [paraIndex, setParaIndex] = useState(0);
  const [sentIndex, setSentIndex] = useState(0);
  const ttsRef = useRef<TtsController | null>(null);
  const accentRef = useRef(accent);
  const rateRef = useRef(rate);
  const hasNextPageRef = useRef(hasNextPage);
  const onNextPageRef = useRef(onNextPage);
  accentRef.current = accent;
  rateRef.current = rate;
  hasNextPageRef.current = hasNextPage;
  onNextPageRef.current = onNextPage;

  // 连续播放:翻页后等新一页段落就绪再接着读
  const autoPlayNextRef = useRef(false);
  const skippedPagesRef = useRef(0);

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
          return;
        }
        // 整页读完:有声书式连续播放,自动翻到下一页接着读
        if (pageModeRef.current && hasNextPageRef.current) {
          onHighlight(null);
          autoPlayNextRef.current = true;
          skippedPagesRef.current = 0;
          setMode("playing");
          onNextPageRef.current();
          return;
        }
        setMode("idle");
        onHighlight(null);
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
  // 连续播放自己翻的页不算「用户中断」,保持 playing,等新页段落到了接着读。
  const lastPageRef = useRef(pageNo);
  useEffect(() => {
    if (lastPageRef.current === pageNo) return;
    lastPageRef.current = pageNo;
    stopAll();
    if (!autoPlayNextRef.current) setMode("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNo]);

  // 连续播放:新一页段落解析好后接着读;整页无可读文本(插图/空白页)就继续往后翻
  useEffect(() => {
    if (!autoPlayNextRef.current) return;
    const idx = findNextReadable(paragraphs, -1);
    if (idx !== -1) {
      autoPlayNextRef.current = false;
      pageModeRef.current = true;
      play(idx, 0);
      return;
    }
    if (hasNextPageRef.current && skippedPagesRef.current < MAX_SKIP_PAGES) {
      skippedPagesRef.current += 1;
      onNextPageRef.current();
      return;
    }
    autoPlayNextRef.current = false;
    setMode("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paragraphs]);

  const pause = () => {
    autoPlayNextRef.current = false; // 正好卡在翻页间隙暂停:别再自动续上
    ttsRef.current?.pause();
    setMode("paused");
  };
  const resume = () => {
    ttsRef.current?.resume();
    setMode("playing");
  };
  const stop = () => {
    autoPlayNextRef.current = false;
    stopAll();
    setMode("idle");
  };

  const firstReadable = findNextReadable(paragraphs, -1);

  return (
    <div className="tts-bar">
      <div className="tts-controls">
        {mode === "playing" ? (
          <button className="icon-btn big tts-main" title="Pause" aria-label="Pause" onClick={pause}><Icon name="pause" size={22} /></button>
        ) : mode === "paused" ? (
          <button className="icon-btn big tts-main" title="Resume" aria-label="Resume" onClick={resume}><Icon name="play" size={22} /></button>
        ) : (
          <button
            className="icon-btn big tts-main"
            title="Listen to this book from here"
            aria-label="Play"
            disabled={firstReadable === -1}
            onClick={() => {
              pageModeRef.current = true;
              skippedPagesRef.current = 0;
              if (firstReadable !== -1) play(firstReadable);
            }}
          >
            <Icon name="play" size={22} />
          </button>
        )}
        <button className="icon-btn" title="Stop" aria-label="Stop" onClick={stop}><Icon name="stop" size={17} /></button>

        <select value={accent} onChange={(e) => setAccent(e.target.value as Accent)} title="Accent">
          <option value="US">US</option>
          <option value="GB">UK</option>
        </select>

        <label className="tts-rate">
          Speed {rate.toFixed(1)}x
          <input type="range" min="0.5" max="1.5" step="0.1" value={rate} onChange={(e) => setRate(Number(e.target.value))} />
        </label>

        {!persistent && (
          <button className="icon-btn tts-close" title="Close" onClick={() => { stop(); onClose(); }}><Icon name="x" /></button>
        )}
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
            <span className="tts-progress-count">p.{pageNo} · {cur + 1} / {scope.length}</span>
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
