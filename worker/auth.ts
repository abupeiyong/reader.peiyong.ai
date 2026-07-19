import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, Vars } from "./env";
import { uid, now } from "./util";

const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 天
const COOKIE = "sid";

export const authRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function googleEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = uid("sess");
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(token, userId, now() + SESSION_TTL, now())
    .run();
  return token;
}

async function upsertUser(
  env: Env,
  email: string,
  name: string | null,
  avatar: string | null,
  googleSub: string | null
): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (existing) {
    if (googleSub) {
      await env.DB.prepare("UPDATE users SET google_sub = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?")
        .bind(googleSub, name, avatar, existing.id)
        .run();
    }
    return existing.id;
  }
  const id = uid("u");
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, avatar_url, google_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, email, name, avatar, googleSub, now())
    .run();
  return id;
}

function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

// 前端用来决定展示 Google 登录还是临时 dev 登录
authRoutes.get("/config", (c) => {
  return c.json({ google: googleEnabled(c.env), devLogin: !googleEnabled(c.env) });
});

// 临时方案:未配置 Google OAuth 时,允许邮箱直接登录(仅本地/过渡用)
authRoutes.post("/dev-login", async (c) => {
  if (googleEnabled(c.env)) return c.json({ error: "dev login disabled" }, 403);
  const body: { email?: string; name?: string } = await c.req.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: "请输入有效邮箱" }, 400);
  const userId = await upsertUser(c.env, email, body.name ?? email.split("@")[0], null, null);
  const token = await createSession(c.env, userId);
  setSessionCookie(c, token);
  return c.json({ ok: true });
});

// Google OAuth 跳转
authRoutes.get("/google", (c) => {
  if (!googleEnabled(c.env)) return c.text("Google OAuth 未配置", 400);
  const redirectUri = `${c.env.APP_ORIGIN}/api/auth/google/callback`;
  const state = uid("st");
  setCookie(c, "oauth_state", state, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 600 });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

function loginErrorPage(c: Context, title: string, detail: string): Response {
  console.error("Google 登录失败:", title, detail);
  return c.html(
    `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;max-width:640px;margin:auto">
    <h2>Google 登录失败</h2><p><b>${title}</b></p>
    <pre style="background:#f4f4f4;padding:12px;border-radius:8px;white-space:pre-wrap">${detail
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")}</pre>
    <p><a href="/">← 返回重试</a></p></body>`,
    400
  );
}

authRoutes.get("/google/callback", async (c) => {
  if (!googleEnabled(c.env)) return loginErrorPage(c, "Google OAuth 未配置", "");
  const err = c.req.query("error");
  if (err) return loginErrorPage(c, "Google 返回错误", err);
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c, "oauth_state");
  if (!code || !state || state !== cookieState) {
    return loginErrorPage(
      c,
      "state 校验失败",
      `code=${Boolean(code)}, state=${state ?? "无"}, cookie_state=${cookieState ?? "无"}(浏览器可能拦截了 Cookie,请重试)`
    );
  }
  deleteCookie(c, "oauth_state", { path: "/" });

  const redirectUri = `${c.env.APP_ORIGIN}/api/auth/google/callback`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenBody = await tokenRes.text();
  if (!tokenRes.ok) return loginErrorPage(c, `获取 Google token 失败 (${tokenRes.status})`, tokenBody.slice(0, 800));
  let tokenJson: { access_token?: string };
  try {
    tokenJson = JSON.parse(tokenBody) as { access_token?: string };
  } catch {
    return loginErrorPage(c, "Google token 响应无法解析", tokenBody.slice(0, 800));
  }
  if (!tokenJson.access_token) return loginErrorPage(c, "Google token 无效", tokenBody.slice(0, 800));

  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!userRes.ok) return loginErrorPage(c, `获取 Google 用户信息失败 (${userRes.status})`, (await userRes.text()).slice(0, 500));
  const info = (await userRes.json()) as { sub: string; email: string; name?: string; picture?: string };

  const userId = await upsertUser(c.env, info.email.toLowerCase(), info.name ?? null, info.picture ?? null, info.sub);
  const token = await createSession(c.env, userId);
  setSessionCookie(c, token);
  return c.redirect("/");
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    deleteCookie(c, COOKIE, { path: "/" });
  }
  return c.json({ ok: true });
});

/** 认证中间件:解析 cookie → userId,未登录返回 401 */
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
});
