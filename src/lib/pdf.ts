// PDF.js 全局配置
import * as pdfjs from "pdfjs-dist";
import { workerSrc, createWorker } from "./pdfWorker";
import { assetUrl } from "../hadi";

if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

// 标准字体 + cMap 数据(public/ 下静态资源;Hadi 小程序里跨源从本站取,见 public/_headers)。
// 关键:非嵌入字体的 PDF 需要这些数据才能正确度量文本层字宽,
// 否则 textLayer 用 fallback 字体度量,scaleX 严重偏离 → 取词/标记错位。
export const PDF_DOC_OPTS = {
  cMapUrl: assetUrl("/cmaps/"),
  cMapPacked: true,
  standardFontDataUrl: assetUrl("/standard_fonts/"),
  // 强制用 PDF 嵌入/标准字体建立 @font-face 度量文本层,
  // 否则回退系统 serif 字体度量,scaleX 严重失真 → 文本层错位。
  useSystemFonts: false,
  disableFontFace: false,
};

/** 统一入口:带上标准字体/cMap 配置加载 PDF */
export function loadPdf(src: { url: string; httpHeaders?: Record<string, string> } | { data: ArrayBuffer }) {
  if (!createWorker) return pdfjs.getDocument({ ...src, ...PDF_DOC_OPTS });

  // Hadi 小程序:worker 是我们自己建的(见 pdfWorker.hadi.ts),pdf.js 不会替我们回收 ——
  // 文档销毁(doc.destroy() 最终走到 loadingTask.destroy())时跟着关掉,不然每开一本书漏一个线程。
  const port = createWorker();
  const worker = pdfjs.PDFWorker.fromPort({ port });
  const task = pdfjs.getDocument({ ...src, ...PDF_DOC_OPTS, worker });
  const destroy = task.destroy.bind(task);
  task.destroy = async () => {
    try {
      await destroy();
    } finally {
      worker.destroy();
      port.terminate();
    }
  };
  // 打不开(文件坏了 / 网络断了)时调用方拿不到 doc,也就不会来销毁 —— 这里自己收掉
  task.promise.catch(() => void task.destroy().catch(() => {}));
  return task;
}

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
