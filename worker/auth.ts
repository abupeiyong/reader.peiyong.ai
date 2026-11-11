// 登录:Telegram 一次性随机码(个人站点唯一正式登录方式)。
// 本地开发(APP_ENV != production)额外保留邮箱直登,便于 e2e。
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, Vars } from "./env";
import { uid, now } from "./util";
import { telegramEnabled, sendMessage, getBotUsername } from "./telegram";
import { issueLoginCode, verifyLoginCode, ownerChatId, chatAllowed, CODE_TTL } from "./logincode";
import { looksLikeJwt, signSessionJwt, verifySessionJwt } from "./jwt";
import { hadiEnabled, verifyHadiToken } from "./hadi";

const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 天
const RENEW_AFTER = SESSION_TTL / 2;       // 剩余不足一半时滑动续期
// Hadi 小程序换到的会话:只活在小程序的内存里,过期了它自己拿新的 Hadi 令牌再换,
// 所以不用给 30 天(签名令牌没法逐个撤销,短一点更稳妥)。
const HADI_SESSION_TTL = 12 * 3600 * 1000;
const COOKIE = "sid";
const TICKET_COOKIE = "lgt";

export const authRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function devLoginEnabled(env: Env): boolean {
  return env.APP_ENV !== "production";
}

/**
 * 会话 token。默认签一张 JWT:之后每次请求验签即可,不用查 sessions 表。
 * 没有签名密钥时(生产未配任何 secret)退回库里的随机会话,行为与改动前一致。
 */
async function createSession(env: Env, userId: string, ttl = SESSION_TTL): Promise<string> {
  const jwt = await signSessionJwt(env, userId, ttl);
  if (jwt) return jwt;
  const token = uid("sess");
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(token, userId, now() + ttl, now())
    .run();
  return token;
}

function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.env.APP_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

/** 与 setSessionCookie 等价的原始 Set-Cookie 串:给已生成的响应补 cookie 用 */
function sessionCookieHeader(c: Context, token: string): string {
  const parts = [`${COOKIE}=${token}`, `Max-Age=${SESSION_TTL / 1000}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (c.env.APP_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/** chat → 账号:已绑定则复用(保留原有书库),否则新建一个 Telegram 账号 */
async function userForChat(env: Env, chatId: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE telegram_chat_id = ?")
    .bind(chatId)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = uid("u");
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, telegram_chat_id, tg_daily_enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)"
  )
    .bind(id, `tg${chatId}@telegram.local`, "Reader", chatId, now())
    .run();
  return id;
}

/** 邮箱 → 账号(仅本地开发用):没有就建一个 */
async function userForEmail(env: Env, email: string, name: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (existing) return existing.id;
  const id = uid("u");
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, email, name, now())
    .run();
  return id;
}

// 前端据此决定展示 Telegram 登录还是本地 dev 登录
authRoutes.get("/config", async (c) => {
  const telegram = telegramEnabled(c.env);
  return c.json({
    telegram,
    devLogin: devLoginEnabled(c.env),
    bot: telegram ? await getBotUsername(c.env) : null,
  });
});

// 发码:生成随机 6 位码,只发到站长的 Telegram
authRoutes.post("/request-code", async (c) => {
  if (!telegramEnabled(c.env)) return c.json({ error: "Telegram is not configured." }, 400);
  const chatId = await ownerChatId(c.env);
  if (!chatId) {
    const bot = await getBotUsername(c.env);
    return c.json(
      { error: `No Telegram account linked yet. Send /login to ${bot ? "@" + bot : "the bot"} to get a code.` },
      400
    );
  }
  const ticket = uid("tk");
  const issued = await issueLoginCode(c.env, chatId, ticket);
  if ("error" in issued) return c.json({ error: issued.error }, 429);

  setCookie(c, TICKET_COOKIE, ticket, {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.env.APP_ENV === "production",
    path: "/",
    maxAge: CODE_TTL / 1000,
  });
  await sendMessage(
    c.env,
    chatId,
    `🔐 Sign-in code: <b>${issued.code}</b>\nValid for 5 minutes. If you didn't request it, ignore this message.`
  );
  return c.json({ ok: true, expires_in: CODE_TTL / 1000 });
});

// 验码:成功即建立会话
authRoutes.post("/verify-code", async (c) => {
  if (!telegramEnabled(c.env)) return c.json({ error: "Telegram is not configured." }, 400);
  const body: { code?: string } = await c.req.json().catch(() => ({}));
  const code = (body.code || "").replace(/\D/g, "");
  if (code.length !== 6) return c.json({ error: "Enter the 6-digit code." }, 400);

  const result = await verifyLoginCode(c.env, code, getCookie(c, TICKET_COOKIE) ?? null);
  if ("error" in result) return c.json({ error: result.error }, 401);
  if (!(await chatAllowed(c.env, result.chat_id))) return c.json({ error: "This account cannot sign in." }, 403);

  deleteCookie(c, TICKET_COOKIE, { path: "/" });
  const userId = await userForChat(c.env, result.chat_id);
  setSessionCookie(c, await createSession(c.env, userId));
  return c.json({ ok: true });
});

// 本地开发直登(生产禁用)
authRoutes.post("/dev-login", async (c) => {
  if (!devLoginEnabled(c.env)) return c.json({ error: "dev login disabled" }, 403);
  const body: { email?: string; name?: string } = await c.req.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "请输入有效邮箱" }, 400);
  const userId = await userForEmail(c.env, email, body.name ?? email.split("@")[0]);
  setSessionCookie(c, await createSession(c.env, userId));
  return c.json({ ok: true });
});

// Hadi 小程序登录:拿 hub 签发的应用令牌换本站会话。
// 小程序在沙箱 iframe 里带不了 cookie,所以会话放在响应体里,由它之后用 Authorization: Bearer 带上。
// Hadi 是单用户的(令牌 sub 恒为 owner),本站也只有站长一个账号 —— 直接落到站长账号上,
// 和 Telegram 登录进的是同一个书库。
authRoutes.post("/hadi", async (c) => {
  if (!hadiEnabled(c.env)) return c.json({ error: "Hadi sign-in is not configured." }, 404);
  const body: { token?: unknown } = await c.req.json().catch(() => ({}));
  const claims = await verifyHadiToken(c.env, typeof body.token === "string" ? body.token : "");
  if ("error" in claims) return c.json({ error: claims.error }, 401);

  let userId: string;
  const chatId = await ownerChatId(c.env);
  if (chatId) {
    userId = await userForChat(c.env, chatId);
  } else if (devLoginEnabled(c.env)) {
    // 本地开发没有 Telegram 账号:落到一个固定的本地账号上,便于在沙箱里自测
    userId = await userForEmail(c.env, "hadi-owner@hadi.local", claims.name ?? "Hadi owner");
  } else {
    return c.json({ error: "No owner account yet. Sign in once on the website with Telegram first." }, 403);
  }
  const expiresAt = now() + HADI_SESSION_TTL;
  return c.json({ token: await createSession(c.env, userId, HADI_SESSION_TTL), expires_at: expiresAt });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) {
    // 签名令牌在库里没有行可删,删 cookie 即可(令牌本身到 exp 才失效,见 jwt.ts)
    if (!looksLikeJwt(token)) {
      await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    }
    deleteCookie(c, COOKIE, { path: "/" });
  }
  return c.json({ ok: true });
});

/** Authorization: Bearer <token>(Hadi 小程序用;浏览器里的网页端走 cookie) */
function bearerToken(c: Context): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
  return m ? m[1] : null;
}

/** 认证中间件:解析 cookie(或 Bearer)→ userId,未登录返回 401;cookie 会话滑动续期 */
import { createMiddleware } from "hono/factory";

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  // Bearer 只在开了 Hadi 登录时才认:没开的部署上,会话令牌仍然只能从 cookie 来
  const bearer = hadiEnabled(c.env) ? bearerToken(c) : null;
  const token = bearer ?? getCookie(c, COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);

  // 签名令牌:验签 + 看过期,一次 D1 都不用
  if (looksLikeJwt(token)) {
    const claims = await verifySessionJwt(c.env, token);
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", claims.sub);
    await next();

    // Bearer 会话不续期:续期靠 Set-Cookie,而小程序收不到 cookie —— 它过期后自己重新换
    if (bearer) return;
    // 剩余不足一半时换一张新令牌(同样不写库)
    if (claims.exp - now() >= RENEW_AFTER) return;
    const fresh = await signSessionJwt(c.env, claims.sub, SESSION_TTL);
    if (!fresh) return;
    try {
      c.res.headers.append("Set-Cookie", sessionCookieHeader(c, fresh));
    } catch {
      // 少数路由的响应头不可写(流式/文件),这次不续,下次请求再续
    }
    return;
  }

  // 换成 JWT 之前签发的随机 token:仍按库里查,30 天内自然过完
  const row = await c.env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
    .bind(token)
    .first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at < now()) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", row.user_id);
  await next();
  if (bearer) return; // 同上:Bearer 会话不靠 Set-Cookie 续期

  // 老会话直接换成签名令牌:下一个请求起就不用再查 sessions 了。
  // 签不出来(没有密钥)时保持原来的滑动续期逻辑。
  const upgraded = await signSessionJwt(c.env, row.user_id, SESSION_TTL);
  if (upgraded) {
    try {
      c.res.headers.append("Set-Cookie", sessionCookieHeader(c, upgraded));
    } catch {
      // 响应头不可写(流式/文件):这次不换,下次请求再换
    }
    return;
  }

  // 剩余不足一半时往后顺延 30 天。先补 Set-Cookie 再写库:
  // 少数路由返回的响应头不可写(流式/文件),那种情况下这次不续,下次请求再续,
  // 避免出现「库里续了、浏览器 cookie 没续」而被提前登出。
  if (row.expires_at - now() >= RENEW_AFTER) return;
  try {
    c.res.headers.append("Set-Cookie", sessionCookieHeader(c, token));
  } catch {
    return;
  }
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?")
      .bind(now() + SESSION_TTL, token)
      .run()
      .then(() => undefined)
      .catch((e: Error) => console.warn("会话续期失败:", e.message))
  );
});
