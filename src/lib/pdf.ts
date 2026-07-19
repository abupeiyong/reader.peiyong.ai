// PDF.js 全局配置
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// 标准字体 + cMap 数据(public/ 下静态资源)。
// 关键:非嵌入字体的 PDF 需要这些数据才能正确度量文本层字宽,
// 否则 textLayer 用 fallback 字体度量,scaleX 严重偏离 → 取词/标记错位。
export const PDF_DOC_OPTS = {
  cMapUrl: "/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/standard_fonts/",
  // 强制用 PDF 嵌入/标准字体建立 @font-face 度量文本层,
  // 否则回退系统 serif 字体度量,scaleX 严重失真 → 文本层错位。
  useSystemFonts: false,
  disableFontFace: false,
};

/** 统一入口:带上标准字体/cMap 配置加载 PDF */
export function loadPdf(src: { url: string } | { data: ArrayBuffer }) {
  return pdfjs.getDocument({ ...src, ...PDF_DOC_OPTS });
}

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
