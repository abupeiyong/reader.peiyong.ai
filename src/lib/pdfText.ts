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
