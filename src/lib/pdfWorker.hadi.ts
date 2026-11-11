// pdf.js 的 worker 从哪来(Hadi 小程序)。
//
// 沙箱 iframe 是 opaque origin,pdf.js 默认的 new Worker(地址, { type: "module" }) 走不通:
//   - 同站地址被当成跨源拒绝,hub 托管的文件也不带 CORS 头;
//   - 换成 blob: 地址也不行 —— 实测 opaque origin 里 module worker 起不来(classic 的可以)。
// 起不来时 pdf.js 会悄悄退回主线程解析(fake worker),大一点的 PDF 就会卡住界面。
// 所以把 worker 打成 classic 脚本内联进主包(vite 的 ?worker&inline + worker.format = iife),
// 每个文档建一个,交给 pdf.js 当端口用(见 pdf.ts 的 loadPdf)。
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker&inline";

export const workerSrc: string | null = null;

export const createWorker: (() => Worker) | null = () => new PdfWorker();
