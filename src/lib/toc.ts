// 章节目录:优先用 PDF 内置书签(outline),解析为页码。
import type { PDFDocumentProxy } from "./pdf";

export interface TocItem {
  title: string;
  page: number;
  level: number;
}

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineNode[];
}

export async function extractToc(doc: PDFDocumentProxy): Promise<TocItem[]> {
  let outline: OutlineNode[] | null = null;
  try {
    outline = (await doc.getOutline()) as OutlineNode[] | null;
  } catch {
    outline = null;
  }
  if (!outline || outline.length === 0) return [];

  const out: TocItem[] = [];
  const walk = async (nodes: OutlineNode[], level: number) => {
    for (const node of nodes) {
      let page = 0;
      try {
        let dest = node.dest;
        if (typeof dest === "string") dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          page = (await doc.getPageIndex(dest[0] as never)) + 1;
        }
      } catch {
        /* 无法解析目标页,page 保持 0 */
      }
      const title = (node.title || "").replace(/\s+/g, " ").trim();
      if (title) out.push({ title, page, level });
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(outline, 0);
  return out;
}
