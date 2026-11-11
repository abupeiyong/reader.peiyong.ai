// pdf.js 的 worker 从哪来(网页端):同源的静态脚本,pdf.js 自己按地址 new Worker。
// Hadi 小程序的包里这个文件被换成 pdfWorker.hadi.ts(见 vite.hadi.config.ts 的 alias),
// 两个文件导出的名字和类型必须一致。
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** worker 脚本地址,交给 GlobalWorkerOptions.workerSrc */
export const workerSrc: string | null = workerUrl;

/** 自己建 worker 的工厂;网页端不需要,让 pdf.js 按 workerSrc 建 */
export const createWorker: (() => Worker) | null = null;
