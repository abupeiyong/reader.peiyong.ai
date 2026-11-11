// Hadi 小程序端到端自测:在 Hadi 的本地沙箱里(和真机一样的 sandbox iframe、不带 CORS 头的静态托管)
// 走一遍 登录 → 书库 → 上传 → 阅读 → 查词。
//
// 沙箱自己发的是 alg=none 的假令牌,后端必须拒绝;所以这里另起一个假 hub(只提供 JWKS),
// 用它的私钥签一张真的 ES256 令牌,在浏览器把换会话的请求拦下来换上这张 —— 后端验签的代码路径
// 和线上完全一样,只是公钥来自本地。
//
// 准备(三个终端,或都放后台):
//   npm run dev                                         # 后端 :5173(wrangler.dev.jsonc 已指向假 hub :4174)
//   HADI_API_BASE=http://localhost:5173 npm run build:hadi
//   node ~/.claude/skills/hadi-miniapp/scripts/dev.mjs dist-hadi   # 沙箱 :4173
// 然后:
//   TEST_PDF=/path/to/book.pdf node scripts/hadi-e2e.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SANDBOX = process.env.SANDBOX_URL || "http://127.0.0.1:4173/__hadi/";
const API = process.env.API_URL || "http://localhost:5173";
const HUB_PORT = Number(process.env.MOCK_HUB_PORT || 4174);
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const APP_ID = process.env.HADI_APP_ID || "reader";
const PDF = process.env.TEST_PDF;
const OUT = process.env.SHOT_DIR || "e2e-shots-hadi";
const WORD = process.env.TEST_WORD || "";

mkdirSync(OUT, { recursive: true });

let failed = 0;
const ok = (name) => console.log("✅", name);
const fail = (name, err) => {
  failed++;
  console.log("❌", name, "—", err);
};

// ---------- 假 hub:一把 ES256 密钥 + JWKS ----------
// 密钥存在 .wrangler/ 下(不入库)跨次复用:后端会把 JWKS 缓存一小时,
// 每次都换新密钥的话,紧接着的第二次运行就会因为「公钥对不上」而全部 401。
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const KEY_FILE = ".wrangler/hadi-e2e-hub-key.json";
const EC = { name: "ECDSA", namedCurve: "P-256" };
let privateJwk;
if (existsSync(KEY_FILE)) {
  privateJwk = JSON.parse(readFileSync(KEY_FILE, "utf8"));
} else {
  const pair = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify(privateJwk));
}
const privateKey = await crypto.subtle.importKey("jwk", privateJwk, EC, false, ["sign"]);
const KID = `e2e-${privateJwk.x.slice(0, 8)}`;
const jwk = { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, kid: KID, use: "sig", alg: "ES256" };

async function signToken(overrides = {}, header = { alg: "ES256", typ: "at+jwt", kid: KID }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = { iss: HUB, sub: "owner", aud: APP_ID, iat: nowSec, exp: nowSec + 3600, scope: "miniapp", ...overrides };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, Buffer.from(body));
  return `${body}.${b64url(sig)}`;
}

const hub = createServer((req, res) => {
  if (req.url === "/.well-known/jwks.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => hub.listen(HUB_PORT, "127.0.0.1", r));

const exchange = (token) =>
  fetch(`${API}/api/auth/hadi`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "null" },
    body: JSON.stringify({ token }),
  });

let browser;
try {
  // ---------- 1. 后端:只认对的令牌 ----------
  const unsigned = `${b64url(JSON.stringify({ alg: "none", kid: "sandbox" }))}.${b64url(
    JSON.stringify({ iss: HUB, sub: "owner", aud: APP_ID, exp: Math.floor(Date.now() / 1000) + 3600 })
  )}.`;
  const rejects = [
    ["沙箱的 alg=none 假令牌", unsigned],
    ["别的小程序的令牌(aud 不对)", await signToken({ aud: "tasks" })],
    ["别的 hub 签的令牌(iss 不对)", await signToken({ iss: "https://evil.example" })],
    ["过期的令牌", await signToken({ exp: Math.floor(Date.now() / 1000) - 600 })],
    ["sub 不是 owner", await signToken({ sub: "guest" })],
    ["签名被改过", (await signToken()).replace(/.$/, (ch) => (ch === "A" ? "B" : "A"))],
  ];
  for (const [name, token] of rejects) {
    const res = await exchange(token);
    if (res.status === 401) ok(`拒绝:${name}`);
    else fail(`拒绝:${name}`, `status=${res.status}`);
  }

  const good = await exchange(await signToken());
  const session = good.ok ? await good.json() : null;
  if (session?.token && good.headers.get("access-control-allow-origin") === "*") ok("真令牌换到会话,响应带 CORS 头");
  else fail("真令牌换会话", `status=${good.status} acao=${good.headers.get("access-control-allow-origin")}`);

  const me = await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${session?.token}`, Origin: "null" } });
  if (me.ok && me.headers.get("set-cookie") === null) ok("Bearer 会话能访问 /api/me,且不下发 cookie");
  else fail("Bearer 访问 /api/me", `status=${me.status} set-cookie=${me.headers.get("set-cookie")}`);

  const anon = await fetch(`${API}/api/me`, { headers: { Origin: "null" } });
  if (anon.status === 401 && anon.headers.get("access-control-allow-origin") === "*") ok("未登录 401 也带 CORS 头(小程序读得到状态码)");
  else fail("未登录 401", `status=${anon.status}`);

  const preflight = await fetch(`${API}/api/me`, {
    method: "OPTIONS",
    headers: { Origin: "null", "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "authorization,content-type" },
  });
  const allowHeaders = (preflight.headers.get("access-control-allow-headers") || "").toLowerCase();
  if (preflight.status === 204 && allowHeaders.includes("authorization")) ok("预检请求放行 Authorization");
  else fail("预检请求", `status=${preflight.status} allow-headers=${allowHeaders}`);

  // ---------- 2. 沙箱里的小程序 ----------
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 240));
  });
  // 把沙箱的假令牌换成假 hub 签的真令牌
  let exchanges = 0;
  await context.route("**/api/auth/hadi", async (route) => {
    exchanges++;
    await route.continue({ postData: JSON.stringify({ token: await signToken() }) });
  });
  const shot = (name) => page.screenshot({ path: path.join(OUT, name + ".png") });

  await page.goto(SANDBOX);
  const app = page.frameLocator("#frame");
  await app.locator(".lib-toolbar").waitFor({ timeout: 20000 });
  ok("沙箱里自动登录进书库(无登录页)");
  if (exchanges === 1) ok("并发的首屏请求只换了一次会话");
  else fail("换会话次数", `exchanges=${exchanges}`);
  if ((await app.locator("text=Sign out").count()) === 0) ok("小程序里不显示 Sign out");
  else fail("Sign out", "仍然显示");
  await shot("01-library");

  if (PDF) {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), app.locator("text=Upload PDF").click()]);
    await chooser.setFiles(PDF);
    await app.locator(".book-card").first().waitFor({ timeout: 60000 });
    ok("上传 PDF(pdf.js 在沙箱里解析出文本)");
    await app.locator(".book-cover-img").first().waitFor({ timeout: 30000 });
    const coverSrc = await app.locator(".book-cover-img").first().getAttribute("src");
    if (coverSrc?.startsWith("blob:")) ok("封面经 Bearer 取成 blob 显示");
    else fail("封面", `src=${coverSrc}`);
    await shot("02-library-book");
  }

  if ((await app.locator(".book-card").count()) > 0) {
    await app.locator(".book-card").first().click();
    await app.locator(".pdf-page-wrap canvas").waitFor({ timeout: 30000 });
    await app.locator(".textLayer .w").first().waitFor({ timeout: 30000 });
    ok("阅读器渲染 PDF + 文本层");
    const workers = page.workers().map((w) => w.url());
    if (workers.some((u) => u.startsWith("blob:"))) ok("pdf.js 跑在 blob worker 里(没有退回主线程)");
    else fail("pdf.js worker", `workers=${JSON.stringify(workers)}`);
    await shot("03-reader");

    const target = WORD
      ? app.locator(".textLayer .w", { hasText: new RegExp(`^${WORD}$`) }).first()
      : app.locator(".textLayer .w").filter({ hasText: /^[a-z]{6,}$/ }).first();
    await target.click();
    await app.locator(".word-popover .wp-body").waitFor({ timeout: 20000 });
    ok("点词弹出解释");
    await shot("04-word-popover");
    await app.locator(".word-popover .wp-close").click();

    await app.locator(".reader-header .btn").first().click();
    await app.locator(".lib-toolbar").waitFor({ timeout: 10000 });
    ok("返回书库(hash 路由在沙箱里可用)");
  }

  // 主题跟随宿主
  const before = await app.locator("html").getAttribute("data-theme");
  await page.click("#theme");
  await page.waitForTimeout(300);
  const after = await app.locator("html").getAttribute("data-theme");
  // 只验证 html[data-theme] 跟着宿主变;暗色配色本身还没做(站点目前只有纸墨这一套)
  if (before && after && before !== after) ok(`html[data-theme] 跟随宿主切换(${before} → ${after})`);
  else fail("data-theme 跟随", `before=${before} after=${after}`);
  await shot("05-theme-" + after);

  // 沙箱日志:第一条是 ready,且没有桥接错误
  const log = await page.evaluate(() => window.__sandbox.log.map((e) => ({ kind: e.kind, text: e.text })));
  const errs = log.filter((e) => e.kind === "err");
  const firstCall = log.find((e) => e.kind !== "note");
  if (firstCall?.text?.includes("ready") && errs.length === 0) ok("沙箱日志:第一个桥接调用是 ready,且无错误");
  else fail("沙箱日志", JSON.stringify({ firstCall, errs }));
  if (pageErrors.length === 0) ok("没有未捕获的页面错误");
  else fail("页面错误", pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail("流程中断", e.message);
} finally {
  await browser?.close();
  hub.close();
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
