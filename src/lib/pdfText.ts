// PDF 文本提取与段落识别(客户端,基于 PDF.js textContent)
import { Util } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

export interface Paragraph {
  text: string;
  /** 段落首行顶部在 scale=1 视口坐标下的 y(px) */
  top: number;
  /** 段落首行文字最左 x(scale=1),用于把朗读按钮放在段落开头左侧 */
  left: number;
  /** 段落首行行高(scale=1),用于按钮垂直居中 */
  lineHeight: number;
  sentences: string[];
}

export interface PageExtract {
  text: string;
  paragraphs: Paragraph[];
}

interface Line {
  y: number; // viewport 坐标(自上而下)
  x: number;
  height: number;
  text: string;
}

/** 词形归一:只留字母,让 don't/dont、co-operate/cooperate 等价 */
function wordKey(w: string): string {
  return w.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * 在文本层的词序列里定位一句话,返回闭区间下标 [start, end]。
 * 文本层的词和段落文本对不上是常态,所以做模糊匹配,容忍:
 * - 行末连字符拆词:文本层是 "co-" + "operate",段落文本已合并成 "cooperate"
 * - 句中插入页眉页脚/脚注号等文本层才有的词
 * - 个别词在文本层里取不到(取词失败、特殊字形)
 */
export function matchSentence(spanWords: string[], sentence: string): { start: number; end: number } | null {
  const tokens = (sentence.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []).map(wordKey).filter(Boolean);
  if (tokens.length === 0) return null;
  const keys = spanWords.map(wordKey);
  const need = Math.min(2, tokens.length);
  const budget = Math.max(3, Math.round(tokens.length * 0.35)); // 允许跳过的多余词数
  const leadCount = Math.min(3, tokens.length);                 // 句首前几个词都可以作为锚点

  /** span i 是否匹配 token ti;返回消耗的 span 数(0 = 不匹配) */
  const eq = (i: number, ti: number): number => {
    if (!keys[i]) return 0;
    if (keys[i] === tokens[ti]) return 1;
    if (i + 1 < keys.length && keys[i] + keys[i + 1] === tokens[ti]) return 2;
    return 0;
  };

  let best: { start: number; end: number; matched: number } | null = null;
  for (let start = 0; start < keys.length; start++) {
    let ti0 = -1;
    for (let k = 0; k < leadCount; k++) {
      if (eq(start, k)) {
        ti0 = k;
        break;
      }
    }
    if (ti0 === -1) continue;

    let i = start;
    let ti = ti0;
    let end = start;
    let matched = 0;
    let misses = 0;
    const limit = Math.min(keys.length, start + tokens.length * 3 + 12);
    while (i < limit && ti < tokens.length) {
      const consumed = eq(i, ti);
      if (consumed) {
        matched++;
        end = i + consumed - 1;
        i += consumed;
        ti++;
        continue;
      }
      if (ti + 1 < tokens.length && eq(i, ti + 1)) {
        ti++; // 这个词文本层里没有,跳过它
        continue;
      }
      i++;
      misses++;
      if (misses > budget) break;
    }
    if (matched >= need && matched / tokens.length >= 0.5 && (!best || matched > best.matched)) {
      best = { start, end, matched };
      if (matched === tokens.length) break;
    }
  }
  return best ? { start: best.start, end: best.end } : null;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=["'([]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function extractPage(page: PDFPageProxy): Promise<PageExtract> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  // 1) 按 y 坐标聚合成行
  const lines: Line[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const str = item.str;
    if (!str || !str.trim()) continue;
    // 用 viewport.transform 正确变换到视口坐标(处理 CropBox 偏移/旋转),
    // 与 PdfViewer 的 textLayer 坐标系一致
    const tx = Util.transform(viewport.transform, item.transform);
    const x = tx[4];
    const y = tx[5];
    const h = Math.hypot(tx[2], tx[3]) || Math.abs(item.height) || 10;
    const found = lines.find((l) => Math.abs(l.y - y) < h * 0.6);
    if (found) {
      found.text += (found.text.endsWith(" ") || str.startsWith(" ") ? "" : " ") + str;
    } else {
      lines.push({ y, x, height: h, text: str });
    }
  }
  lines.sort((a, b) => a.y - b.y);
  if (lines.length === 0) return { text: "", paragraphs: [] };

  // 2) 段落分界:大行间距 / 相对缩进 / 字号变化 / 句末后的绝对缩进。
  // 注意整块缩进的小字引文:块内各行 x 相同,不能按"绝对缩进"逐行切段。
  const median = (arr: number[], dft: number) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : dft;
  };
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
  const medianGap = median(gaps, 14);
  const bodyHeight = median(lines.map((l) => l.height), 10); // 正文字号(行高中位数)

  // 正文左边界 = 出现最多的行首 x(众数,4px 网格)
  const bucket = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.x / 4) * 4;
    bucket.set(k, (bucket.get(k) ?? 0) + 1);
  }
  let leftEdge = lines[0].x;
  let bestCount = 0;
  for (const [k, count] of bucket) {
    if (count > bestCount) {
      bestCount = count;
      leftEdge = k;
    }
  }
  const indentThreshold = Math.max(6, medianGap * 0.5); // 缩进量阈值

  const paragraphs: Paragraph[] = [];
  let cur: Line[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    const gap = line.y - prev.y;
    const bigGap = gap > Math.max(medianGap * 1.5, line.height * 1.8);
    // 比上一行更缩进 = 段落首行(引文块内各行 x 相同,不触发)
    const relIndent = line.x > prev.x + indentThreshold;
    // 字号变化 = 块边界(正文 ↔ 小字引文/标题)
    const fontChange = Math.abs(line.height - prev.height) > Math.max(line.height, prev.height) * 0.08;
    // 连续同缩进的段首(如小说对话逐段缩进):仅正文字号、且上一行以句末标点结尾时成立,
    // 避免把整块缩进的小字引文逐行切段
    const small = line.height < bodyHeight * 0.9 && prev.height < bodyHeight * 0.9;
    const prevEndsSentence = /[.!?…"”'’)\]]\s*\d*$/.test(prev.text.trim());
    const absIndent =
      line.x > leftEdge + indentThreshold && Math.abs(line.x - prev.x) <= indentThreshold && !small && prevEndsSentence;
    if (bigGap || relIndent || fontChange || absIndent) {
      paragraphs.push(buildParagraph(cur));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  paragraphs.push(buildParagraph(cur));

  const filtered = paragraphs.filter((p) => p.text.length > 0);
  return { text: filtered.map((p) => p.text).join("\n\n"), paragraphs: filtered };
}

function buildParagraph(ls: Line[]): Paragraph {
  const text = ls
    .map((l) => l.text.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    // 连字符换行合并:word- word → wordword
    .replace(/(\w)- (\w)/g, "$1$2")
    .trim();
  return {
    text,
    top: Math.max(0, ls[0].y - ls[0].height),
    left: Math.min(...ls.map((l) => l.x)),
    lineHeight: ls[0].height,
    sentences: splitSentences(text),
  };
}

export async function extractAllPages(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void
): Promise<PageExtract[]> {
  const out: PageExtract[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    out.push(await extractPage(page));
    onProgress?.(i, doc.numPages);
  }
  return out;
}
