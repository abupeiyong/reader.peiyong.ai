import { useEffect, useRef, useState } from "react";
import { pdfjs, type PDFDocumentProxy } from "../lib/pdf";
import type { Paragraph } from "../lib/pdfText";
import { Icon } from "./Icon";

export interface WordClickInfo {
  word: string;
  sentence: string;
  x: number; // 视口坐标(popover 定位)
  y: number; // 单词底部
  yTop: number; // 单词顶部(空间不足时翻转到上方)
}

interface Props {
  doc: PDFDocumentProxy;
  pageNo: number;
  zoom: number;
  paragraphs: Paragraph[];
  hintWords: Set<string>; // 需要轻量标记的生词(已过滤"认识"的词)
  showHints: boolean;
  flashPage: number; // 引用跳转后闪烁提示的计数器
  onWordClick: (info: WordClickInfo) => void;
  onSelection: (text: string, sentence: string) => void;
  onPlayParagraph: (paraIndex: number) => void;
  ttsHighlight: { paraIndex: number; sentIndex: number } | null;
  onDamaged?: (damaged: boolean) => void; // 文本层坐标损坏时通知上层
}

export default function PdfViewer({
  doc,
  pageNo,
  zoom,
  paragraphs,
  hintWords,
  showHints,
  flashPage,
  onWordClick,
  onSelection,
  onPlayParagraph,
  ttsHighlight,
  onDamaged,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [flash, setFlash] = useState(false);
  const [damaged, setDamaged] = useState(false);

  // 渲染页面 canvas + 文本层
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNo);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: zoom });
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      if (!canvas || !textLayer) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ w: viewport.width, h: viewport.height });

      const ctx = canvas.getContext("2d")!;
      renderTaskRef.current?.cancel();
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch {
        return; // 渲染被取消
      }
      if (cancelled) return;

      // 文本层
      textLayer.innerHTML = "";
      textLayer.style.setProperty("--scale-factor", String(viewport.scale));
      const tl = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayer,
        viewport,
      });
      await tl.render();
      if (cancelled) return;
      wrapWords(textLayer);
      // 检测文本层坐标是否损坏(字体宽度表异常导致大量词飘到页面外)
      const dmg = detectDamage(textLayer, viewport.width);
      textLayer.classList.toggle("damaged", dmg);
      setDamaged(dmg);
      onDamaged?.(dmg);
      applyHints(textLayer, hintWords, showHints && !dmg);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageNo, zoom]);

  // 生词提示单独更新(不重渲染 PDF);文本层损坏时不标记
  useEffect(() => {
    if (textLayerRef.current) applyHints(textLayerRef.current, hintWords, showHints && !damaged);
  }, [hintWords, showHints, damaged]);

  // TTS 句子高亮
  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) return;
    layer.querySelectorAll(".tts-active").forEach((el) => el.classList.remove("tts-active"));
    if (!ttsHighlight) return;
    const para = paragraphs[ttsHighlight.paraIndex];
    const sentence = para?.sentences[ttsHighlight.sentIndex];
    if (!sentence) return;
    highlightSentence(layer, sentence);
  }, [ttsHighlight, paragraphs]);

  // 引用跳转闪烁
  useEffect(() => {
    if (flashPage <= 0) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [flashPage]);

  // 单词点击(事件委托);点在词附近也能命中,提升取词准确度
  const handleClick = (e: React.MouseEvent) => {
    const layer = textLayerRef.current;
    if (!layer || damaged) return; // 文本层坐标损坏时禁用取词(避免点到错位)
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 1) return; // 正在选择文本,不当作单词点击
    let target = e.target as HTMLElement;
    if (!target.classList.contains("w")) {
      const near = wordFromPoint(e.clientX, e.clientY, layer);
      if (!near) return;
      target = near;
    }
    const word = target.textContent?.trim() ?? "";
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) return;
    const sentence = findSentence(target, paragraphs, word);
    const rect = target.getBoundingClientRect();
    onWordClick({ word, sentence, x: rect.left + rect.width / 2, y: rect.bottom, yTop: rect.top });
  };

  const handleMouseUp = () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
      if (text && text.length > 1 && wrapRef.current?.contains(sel!.anchorNode)) {
        const sentence = paragraphs.flatMap((p) => p.sentences).find((s) => s.includes(text)) ?? text;
        onSelection(text, sentence);
      }
    }, 10);
  };

  return (
    <div
      ref={wrapRef}
      className={`pdf-page-wrap ${flash ? "flash" : ""}`}
      style={{ width: size.w, height: size.h }}
      onClick={handleClick}
      onMouseUp={handleMouseUp}
    >
      <canvas ref={canvasRef} />
      <div ref={textLayerRef} className="textLayer" />
      {/* 段落朗读按钮:放在每段首行文字的左侧;文本层损坏时隐藏(坐标不可靠) */}
      <div className="para-buttons">
        {!damaged && paragraphs.map((p, i) =>
          p.sentences.length > 0 && p.text.split(" ").length >= 5 ? (
            <button
              key={i}
              className={`para-play ${ttsHighlight?.paraIndex === i ? "playing" : ""}`}
              style={{
                top: (p.top + p.lineHeight / 2) * zoom - 12,
                left: Math.max(-30, p.left * zoom - 30),
              }}
              title="Read this paragraph aloud"
              onClick={(e) => {
                e.stopPropagation();
                onPlayParagraph(i);
              }}
            >
              {ttsHighlight?.paraIndex === i ? <Icon name="volume" size={12} /> : <Icon name="play" size={11} />}
            </button>
          ) : null
        )}
      </div>
    </div>
  );
}

/** 把文本层每个 span 的文本按单词拆成子 span,便于点击与标记 */
function wrapWords(layer: HTMLElement) {
  const spans = layer.querySelectorAll<HTMLElement>(":scope > span, :scope > p > span");
  spans.forEach((span) => {
    if (span.childElementCount > 0) return;
    const text = span.textContent;
    if (!text || !/[A-Za-z]/.test(text)) return;
    const frag = document.createDocumentFragment();
    const parts = text.split(/([A-Za-z][A-Za-z'-]*)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^[A-Za-z][A-Za-z'-]*$/.test(part)) {
        const w = document.createElement("span");
        w.className = "w";
        w.textContent = part;
        frag.appendChild(w);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    span.textContent = "";
    span.appendChild(frag);
  });
}

function normWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z'-]/g, "");
}

/** 检测文本层坐标是否损坏:大量词飘出页面(字体宽度表异常) */
function detectDamage(layer: HTMLElement, pageWidth: number): boolean {
  const ws = layer.querySelectorAll<HTMLElement>(".w");
  if (ws.length < 12) return false;
  const base = layer.getBoundingClientRect().left;
  let outside = 0;
  ws.forEach((w) => {
    if (w.getBoundingClientRect().left - base > pageWidth + 4) outside++;
  });
  return outside / ws.length > 0.18;
}

/** 用光标命中点找最近的词 span,点在词之间/标点上也能取到词 */
function wordFromPoint(x: number, y: number, layer: HTMLElement): HTMLElement | null {
  const range = document.caretRangeFromPoint?.(x, y);
  let node: Node | null = range?.startContainer ?? null;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (node instanceof HTMLElement && node.classList.contains("w")) return node;
  // 兜底:同一行内距离点击最近的词(<28px)
  let best: HTMLElement | null = null;
  let bestD = 28;
  layer.querySelectorAll<HTMLElement>(".w").forEach((w) => {
    const r = w.getBoundingClientRect();
    if (y < r.top - 4 || y > r.bottom + 4) return; // 只在同一行附近
    const cx = Math.max(r.left, Math.min(x, r.right));
    const d = Math.abs(x - cx) + Math.abs(y - (r.top + r.height / 2)) * 0.2;
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  });
  return best;
}

function applyHints(layer: HTMLElement, hints: Set<string>, show: boolean) {
  layer.querySelectorAll<HTMLElement>(".w").forEach((el) => {
    const on = show && hints.has(normWord(el.textContent ?? ""));
    el.classList.toggle("hint", on);
  });
}

/** 根据点击的单词与相邻词,从段落句子里找到所在句 */
function findSentence(target: HTMLElement, paragraphs: Paragraph[], word: string): string {
  const allWords = [...target.closest(".textLayer")!.querySelectorAll<HTMLElement>(".w")];
  const idx = allWords.indexOf(target);
  const neighbors = allWords
    .slice(Math.max(0, idx - 3), idx + 4)
    .map((el) => normWord(el.textContent ?? ""))
    .filter(Boolean);
  const candidates = paragraphs.flatMap((p) => p.sentences).filter((s) => new RegExp(`\\b${escapeReg(word)}\\b`, "i").test(s));
  if (candidates.length === 0) return neighbors.join(" ");
  if (candidates.length === 1) return candidates[0];
  let best = candidates[0];
  let bestScore = -1;
  for (const s of candidates) {
    const tokens = new Set(s.toLowerCase().match(/[a-z'-]+/g) ?? []);
    let score = 0;
    for (const n of neighbors) if (tokens.has(n)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 在文本层中按 token 序列匹配并高亮一句话 */
function highlightSentence(layer: HTMLElement, sentence: string) {
  const tokens = (sentence.toLowerCase().match(/[a-z'-]+/g) ?? []).filter(Boolean);
  if (tokens.length === 0) return;
  const spans = [...layer.querySelectorAll<HTMLElement>(".w")];
  const words = spans.map((el) => normWord(el.textContent ?? ""));
  // 滑动窗口找 token 序列起点(允许中间夹杂少量不匹配)
  for (let start = 0; start < words.length; start++) {
    if (words[start] !== tokens[0]) continue;
    let ti = 0;
    let misses = 0;
    let end = start;
    for (let i = start; i < words.length && ti < tokens.length; i++) {
      if (words[i] === tokens[ti]) {
        ti++;
        end = i;
      } else {
        misses++;
        if (misses > 3) break;
      }
    }
    if (ti >= Math.min(tokens.length, Math.max(2, tokens.length * 0.7))) {
      for (let i = start; i <= end; i++) spans[i].classList.add("tts-active");
      spans[start].scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
  }
}
