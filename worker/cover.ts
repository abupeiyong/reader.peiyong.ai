// 书籍封面生成:优先 Workers AI 文生图(flux-1-schnell,按书名生成插画),
// 不可用时(本地开发无 AI 绑定/模型失败)回退确定性 SVG 封面(书名哈希+seed 选配色与装饰),
// 保证任何环境下"生成封面"都能成功。
import type { Env } from "./env";

const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export interface CoverImage {
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}

export async function generateCover(env: Env, title: string, seed: number): Promise<CoverImage> {
  const ai = await aiCover(env, title);
  return ai ?? svgCover(title, seed);
}

async function aiCover(env: Env, title: string): Promise<CoverImage | null> {
  try {
    if (!env.AI) throw new Error("本地开发无 AI 绑定");
    const prompt =
      `Minimalist book cover illustration evoking the theme of a book titled "${title.slice(0, 120)}". ` +
      "Flat vector art on warm paper texture, muted earthy palette of ochre, terracotta, pine green and cream, " +
      "elegant abstract composition, subtle grain. No text, no letters, no words, no typography.";
    const res = (await env.AI.run(IMAGE_MODEL as Parameters<Ai["run"]>[0], {
      prompt,
      steps: 8,
    })) as { image?: string };
    if (!res?.image) return null;
    const bin = atob(res.image);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, contentType: "image/jpeg", ext: "jpg" };
  } catch (e) {
    console.warn("封面文生图不可用,回退 SVG:", (e as Error).message);
    return null;
  }
}

// ---------- SVG 回退封面 ----------

// 与 Paper & Ink 主题协调的配色:[深, 浅, 文字]
const PALETTES: [string, string, string][] = [
  ["#7c5b3b", "#9c7a52", "#f7f2e6"],
  ["#4f6b5a", "#728c74", "#f2f0e4"],
  ["#8a5a44", "#b07d5e", "#f6efe2"],
  ["#5a5f7c", "#7d84a4", "#eef0f6"],
  ["#6b4f6b", "#8f6f8f", "#f4eef4"],
  ["#3f6470", "#5f8894", "#eaf2f2"],
];

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 按视觉宽度折行(CJK 算 2 个单位),最多 4 行 */
function wrapTitle(title: string, maxUnits = 16): string[] {
  const width = (s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const lines: string[] = [];
  let cur = "";
  for (let w of title.trim().split(/\s+/)) {
    while (width(w) > maxUnits) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      let piece = "";
      for (const ch of w) {
        if (width(piece + ch) > maxUnits) break;
        piece += ch;
      }
      lines.push(piece);
      w = w.slice(piece.length);
    }
    if (!w) continue;
    if (!cur) cur = w;
    else if (width(cur + " " + w) <= maxUnits) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 4) {
    lines.length = 4;
    lines[3] = [...lines[3]].slice(0, 14).join("") + "…";
  }
  return lines.length ? lines : ["Untitled"];
}

export function svgCover(title: string, seed: number): CoverImage {
  const h = fnv1a(`${title}:${seed}`);
  const rnd = mulberry32(h);
  const [dark, light, ink] = PALETTES[h % PALETTES.length];
  const lines = wrapTitle(title);

  // 装饰:若干半透明圆与细线,位置由 seed 决定,regenerate 会变化
  let deco = "";
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const cx = Math.round(rnd() * 600);
    const cy = Math.round(rnd() * 800);
    const r = Math.round(60 + rnd() * 180);
    deco += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ink}" opacity="${(0.04 + rnd() * 0.08).toFixed(3)}"/>`;
  }

  const longest = Math.max(...lines.map((l) => [...l].reduce((x, ch) => x + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));
  const fontSize = Math.max(30, Math.min(52, Math.floor((520 / longest) * 1.55)));
  const lineH = Math.round(fontSize * 1.3);
  const startY = Math.round(400 - ((lines.length - 1) * lineH) / 2);
  const text = lines
    .map((l, i) => `<text x="300" y="${startY + i * lineH}" text-anchor="middle" font-size="${fontSize}">${escapeXml(l)}</text>`)
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${light}"/>` +
    `</linearGradient></defs>` +
    `<rect width="600" height="800" fill="url(#g)"/>` +
    deco +
    `<rect x="26" y="26" width="548" height="748" fill="none" stroke="${ink}" stroke-width="2" opacity="0.55" rx="6"/>` +
    `<g fill="${ink}" font-family="Georgia, 'Songti SC', serif" font-weight="600">${text}</g>` +
    `<line x1="220" y1="${startY + lines.length * lineH + 8}" x2="380" y2="${startY + lines.length * lineH + 8}" stroke="${ink}" stroke-width="2" opacity="0.7"/>` +
    `</svg>`;
  return { bytes: new TextEncoder().encode(svg), contentType: "image/svg+xml", ext: "svg" };
}
