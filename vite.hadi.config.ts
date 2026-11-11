// Hadi 小程序的包(npm run build:hadi → dist-hadi/,再 hadi app publish dist-hadi)。
// 和网页端是同一份前端代码,差别只在打包方式:
//
// - hub 托管的文件不带 CORS 头,而沙箱 iframe 是 opaque origin —— <script type="module">
//   和 crossorigin 的样式表都会被拦。所以打成一个普通脚本(iife),并去掉 crossorigin。
// - pdf.js 的 worker 同理加载不了,打成 classic 脚本内联进主包(src/lib/pdfWorker.hadi.ts)。
// - 接口和 public/ 下的静态资源都留在本站(HADI_API_BASE),包里只有页面、脚本、样式和清单。
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const SITE = (process.env.HADI_API_BASE ?? "https://reader.peiyong.ai").replace(/\/+$/, "");

function hadiBundle(): Plugin {
  return {
    name: "hadi-bundle",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const out = html
          // SDK 只能从 hub 取(/hadi-sdk.js),先于应用脚本同步加载;应用脚本改成 defer 的普通脚本
          .replace(
            /<script type="module" crossorigin src="([^"]+)"><\/script>/,
            '<script src="/hadi-sdk.js"></script>\n    <script defer src="$1"></script>'
          )
          .replace(/<link rel="stylesheet" crossorigin href=/g, '<link rel="stylesheet" href=')
          .replace(
            'content="width=device-width, initial-scale=1.0"',
            'content="width=device-width, initial-scale=1, viewport-fit=cover"'
          );
        if (/type="module"|crossorigin/.test(out)) {
          throw new Error("hadi-bundle: index.html 里还有 module / crossorigin 标签,沙箱里会加载失败");
        }
        return out;
      },
    },
    generateBundle() {
      for (const file of ["hadi-app.json", "icon.svg"]) {
        this.emitFile({ type: "asset", fileName: file, source: readFileSync(`hadi/${file}`) });
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), hadiBundle()],
  define: {
    "import.meta.env.VITE_HADI": JSON.stringify("1"),
    "import.meta.env.VITE_API_BASE": JSON.stringify(SITE),
  },
  resolve: {
    alias: [{ find: /^\.\/pdfWorker$/, replacement: "./pdfWorker.hadi" }],
  },
  experimental: {
    // 样式表里引用的 public/ 资源(音标字体)指回本站;其余产物保持相对路径
    renderBuiltUrl(filename, { type }) {
      return type === "public" ? `${SITE}/${filename}` : { relative: true };
    },
  },
  // 内联的 pdf.js worker 必须是 classic 脚本:沙箱里 module worker 起不来
  worker: { format: "iife" },
  build: {
    outDir: "dist-hadi",
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
      },
    },
  },
});
