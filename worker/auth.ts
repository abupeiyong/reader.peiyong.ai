// 登录:Telegram 一次性随机码(个人站点唯一正式登录方式)。
// 本地开发(APP_ENV != production)额外保留邮箱直登,便于 e2e。
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, Vars } from "./env";
import { uid, now } from "./util";
import { telegramEnabled, sendMessage, getBotUsername } from "./telegram";
import { issueLoginCode, verifyLoginCode, ownerChatId, chatAllowed, CODE_TTL } from "./logincode";

const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 天
const RENEW_AFTER = SESSION_TTL / 2;       // 剩余不足一半时滑动续期
const COOKIE = "sid";
const TICKET_COOKIE = "lgt";

export const authRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function devLoginEnabled(env: Env): boolean {
  return env.APP_ENV !== "production";
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = uid("sess");
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(token, userId, now() + SESSION_TTL, now())
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
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  let userId = existing?.id;
  if (!userId) {
    userId = uid("u");
    await c.env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, email, body.name ?? email.split("@")[0], now())
      .run();
  }
  setSessionCookie(c, await createSession(c.env, userId));
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    deleteCookie(c, COOKIE, { path: "/" });
  }
  return c.json({ ok: true });
});

/** 认证中间件:解析 cookie → userId,未登录返回 401;活跃会话滑动续期 */
import { createMiddleware } from "hono/factory";

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
    .bind(token)
    .first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at < now()) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", row.user_id);
  await next();

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
