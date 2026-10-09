// 会话令牌:HMAC-SHA256 签名的 JWT。验签全在内存里做,不查 sessions 表 ——
// 查词这类「用户盯着结果等」的接口上,requireAuth 原来那次 D1 往返是纯粹的等待,
// 而且 AI 统计页看不到它(只记提供商那一段),所以体感慢、统计全是快的。
//
// 代价是令牌不能在服务端逐个撤销:退出登录只删 cookie,令牌本身到 exp(30 天)才失效。
// 本站只有站长一个账号,这个取舍是明确接受的(见 issue #53 的讨论)。
import type { Env } from "./env";

export interface SessionClaims {
  sub: string;
  /** 过期时间,毫秒(和库里 sessions.expires_at 一个口径) */
  exp: number;
}

const ALG = { name: "HMAC", hash: "SHA-256" } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * 签名密钥:优先 SESSION_SECRET,否则复用已有的 Telegram secret(生产必配,
 * 不然 Telegram 登录本身就不可用)。两个都没有时只在本地开发用固定串,
 * 生产返回 null —— 调用方退回库里的随机会话,不会降级成可伪造的令牌。
 */
function secret(env: Env): string | null {
  const s = env.SESSION_SECRET || env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_BOT_TOKEN;
  if (s) return s;
  return env.APP_ENV === "production" ? null : "dev-session-secret";
}

// importKey 是异步的,按密钥缓存,避免每次请求都导一遍
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(s: string): Promise<CryptoKey> {
  let key = keys.get(s);
  if (!key) {
    key = crypto.subtle.importKey("raw", enc.encode(s), ALG, false, ["sign", "verify"]);
    keys.set(s, key);
  }
  return key;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(enc.encode(JSON.stringify(value)));
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

const HEADER = b64urlJson({ alg: "HS256", typ: "JWT" });

/** 是不是签名令牌:换成 JWT 之前签发的随机 token 里没有点 */
export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

/** 签一张令牌;没有可用密钥(生产未配任何 secret)返回 null */
export async function signSessionJwt(env: Env, userId: string, ttlMs: number): Promise<string | null> {
  const s = secret(env);
  if (!s) return null;
  const claims: SessionClaims = { sub: userId, exp: Date.now() + ttlMs };
  const body = `${HEADER}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign(ALG, await keyFor(s), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** 验签 + 查过期;任何一处不对返回 null */
export async function verifySessionJwt(env: Env, token: string): Promise<SessionClaims | null> {
  const s = secret(env);
  if (!s) return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(ALG, await keyFor(s), fromB64url(sig), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const header = JSON.parse(dec.decode(fromB64url(h))) as { alg?: string };
    if (header.alg !== "HS256") return null;
    const claims = JSON.parse(dec.decode(fromB64url(p))) as SessionClaims;
    if (!claims.sub || typeof claims.sub !== "string") return null;
    if (typeof claims.exp !== "number" || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
