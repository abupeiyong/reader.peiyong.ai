// Hadi 小程序模式(npm run build:hadi 打出来的包才会走到这里)。
//
// 小程序跑在 Hadi 的沙箱 iframe 里:opaque origin,没有 cookie / localStorage,
// 页面文件由 hub 托管(https://hadi.00ai.dev/apps/reader/),所以
//   - 后端接口要用绝对地址打到本站,靠 Authorization: Bearer 认证;
//   - 会话是拿 hadi.auth.token() 的令牌到 /api/auth/hadi 换来的,只放在内存里;
//   - public/ 下的静态资源(字体、音标录音、pdf.js 的 cmap)也从本站取,不进 hub 的包。
// 网页端(IS_HADI = false)下这里的函数全是直通,不改变原有行为。

interface HadiEnv {
  platform: "web" | "android";
  theme: "light" | "dark";
  appId: string;
  language: string;
}

interface HadiSdk {
  ready(): Promise<HadiEnv>;
  auth: { token(): Promise<{ token: string; expiresAt: number }> };
  ui: {
    setTitle(title: string): Promise<void>;
    openUrl(url: string): Promise<void>;
  };
  on(event: "theme", fn: (theme: "light" | "dark") => void): () => void;
  on(event: "visibility", fn: (state: "visible" | "hidden") => void): () => void;
}

declare global {
  interface Window {
    hadi?: HadiSdk;
  }
}

export const IS_HADI = import.meta.env.VITE_HADI === "1";

/** 本站地址:小程序里所有接口和静态资源都打到这里 */
const SITE = IS_HADI ? (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "") : "";

/** 接口地址:网页端同源相对路径,小程序里补成本站绝对地址 */
export function apiUrl(path: string): string {
  return SITE + path;
}

/** public/ 下静态资源的地址(同上) */
export function assetUrl(path: string): string {
  return SITE + path;
}

/** 带 code 的错误:App 据此显示「不在 Hadi 里」还是「登录失败」 */
export class HadiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function sdk(): HadiSdk {
  if (!window.hadi) throw new HadiError("not_in_hadi", "The Hadi SDK did not load.");
  return window.hadi;
}

let envPromise: Promise<HadiEnv> | null = null;

/** 连上 Hadi 宿主(结果缓存);页面被直接打开、不在 Hadi 里时以 not_in_hadi 拒绝 */
export function hadiReady(): Promise<HadiEnv> {
  envPromise ??= (async () => {
    try {
      return await sdk().ready();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      throw new HadiError(err.code ?? "error", err.message ?? "Cannot connect to Hadi.");
    }
  })();
  return envPromise;
}

// ---------- 会话 ----------

let session: { token: string; expiresAt: number } | null = null;
let exchanging: Promise<string> | null = null;
const REFRESH_BEFORE = 5 * 60 * 1000; // 离过期不到 5 分钟就提前换新的

/**
 * 本站会话令牌。没有或快过期时,拿一张新的 Hadi 令牌去换;并发的请求共用同一次交换。
 * rejected = 服务端刚用 401 拒掉的那张:还是它就重换,已经被别的请求换成新的了就直接用新的
 * (几个请求同时撞上过期时,只换一次)。
 */
export async function hadiSession(rejected?: string): Promise<string> {
  if (session && session.token !== rejected && session.expiresAt - Date.now() > REFRESH_BEFORE) return session.token;
  exchanging ??= (async () => {
    await hadiReady();
    let hadiToken: string;
    try {
      hadiToken = (await sdk().auth.token()).token;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      throw new HadiError(err.code ?? "error", err.message ?? "Hadi did not issue a token.");
    }
    let res: Response;
    try {
      res = await fetch(apiUrl("/api/auth/hadi"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: hadiToken }),
      });
    } catch {
      throw new HadiError("network", `Cannot reach ${SITE}.`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new HadiError("sign_in_failed", body.error ?? `Sign-in failed (${res.status}).`);
    }
    const next = (await res.json()) as { token: string; expires_at: number };
    session = { token: next.token, expiresAt: next.expires_at };
    return next.token;
  })().finally(() => {
    exchanging = null;
  });
  return exchanging;
}

// ---------- 宿主界面 ----------

/** 跟随 Hadi 的明暗主题(html[data-theme]),并在宿主切换时同步 */
export function followHadiTheme(env: HadiEnv): void {
  const apply = (theme: "light" | "dark") => {
    document.documentElement.dataset.theme = theme;
  };
  apply(env.theme);
  sdk().on("theme", apply);
}

/** 设置 Hadi 顶栏上的标题;不在 Hadi 里或宿主不支持时静默忽略 */
export function setHadiTitle(title: string): void {
  if (!IS_HADI) return;
  void hadiReady()
    .then(() => sdk().ui.setTitle(title.slice(0, 80)))
    .catch(() => {});
}

/**
 * 外链交给宿主打开:Android 的 WebView 里 target=_blank 不会自己开浏览器。
 * 宿主拒绝(老版本 / 非 http 链接)时不拦,留给浏览器默认行为。
 */
export function routeExternalLinksThroughHadi(): void {
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[target='_blank']") as HTMLAnchorElement | null;
    if (!a || !/^https?:/i.test(a.href)) return;
    e.preventDefault();
    sdk()
      .ui.openUrl(a.href)
      .catch(() => window.open(a.href, "_blank", "noopener"));
  });
}
