// Hadi 小程序登录:校验 hub 签发的应用令牌(ES256 JWT)。
//
// 小程序跑在 Hadi 的沙箱 iframe 里(opaque origin),带不了本站的 cookie。它用
// hadi.auth.token() 向 hub 要一张令牌(aud = 小程序 id,有效期 1 小时),拿来换本站的会话
// (见 auth.ts 的 POST /api/auth/hadi),之后的请求都用 Authorization: Bearer。
//
// 公钥取自 hub 的 JWKS,验签全在内存里;只认配置的那一个 hub(iss)和那一个小程序(aud)。
import type { Env } from "./env";
import { fromB64url } from "./jwt";

export interface HadiClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  /** 秒(标准 JWT 口径) */
  exp: number;
  name?: string;
  email?: string;
  device?: string;
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const ALG = { name: "ECDSA", hash: "SHA-256" } as const;
const JWKS_TTL = 60 * 60 * 1000; // 公钥缓存 1 小时
const JWKS_RETRY = 60 * 1000;    // 遇到不认识的 kid 时,最快每分钟重拉一次(hub 轮换了密钥)
const CLOCK_SKEW = 60;           // 秒

/** hub 地址(去尾斜杠);没配就是没开 Hadi 登录 */
function hubUrl(env: Env): string | null {
  const v = env.HADI_HUB_URL?.trim().replace(/\/+$/, "");
  return v ? v : null;
}

export function hadiEnabled(env: Env): boolean {
  return Boolean(hubUrl(env) && env.HADI_APP_ID?.trim());
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface KeySet {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

// 按 hub 地址缓存;isolate 重启后重拉一次即可
const keySets = new Map<string, KeySet>();

async function fetchKeySet(hub: string): Promise<KeySet> {
  const res = await fetch(`${hub}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.kid) continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"]
        )
      );
    } catch {
      // 导不进来的 key 跳过,不影响其它 key
    }
  }
  const set = { keys, fetchedAt: Date.now() };
  keySets.set(hub, set);
  return set;
}

async function keyFor(hub: string, kid: string): Promise<CryptoKey | null> {
  let set = keySets.get(hub);
  if (!set || Date.now() - set.fetchedAt > JWKS_TTL) set = await fetchKeySet(hub);
  const hit = set.keys.get(kid);
  if (hit) return hit;
  if (Date.now() - set.fetchedAt < JWKS_RETRY) return null;
  return (await fetchKeySet(hub)).keys.get(kid) ?? null;
}

/** 验一张 Hadi 应用令牌;任何一处不对都返回 error(给调用方原样回 401) */
export async function verifyHadiToken(env: Env, token: string): Promise<HadiClaims | { error: string }> {
  const hub = hubUrl(env);
  const appId = env.HADI_APP_ID?.trim();
  if (!hub || !appId) return { error: "Hadi sign-in is not configured." };

  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return { error: "Malformed token." };

  let header: { alg?: string; kid?: string };
  let claims: HadiClaims;
  try {
    header = JSON.parse(dec.decode(fromB64url(h))) as { alg?: string; kid?: string };
    claims = JSON.parse(dec.decode(fromB64url(p))) as HadiClaims;
  } catch {
    return { error: "Malformed token." };
  }
  // 只认 ES256:本地沙箱发的是 alg=none 的假令牌,这里就挡掉
  if (header.alg !== "ES256" || !header.kid) return { error: "Unsupported token." };

  let key: CryptoKey | null;
  try {
    key = await keyFor(hub, header.kid);
  } catch (e) {
    console.warn("Hadi JWKS 拉取失败:", (e as Error).message);
    return { error: "Cannot reach the Hadi hub to verify the token." };
  }
  if (!key) return { error: "Unknown signing key." };

  let ok = false;
  try {
    ok = await crypto.subtle.verify(ALG, key, fromB64url(sig), enc.encode(`${h}.${p}`));
  } catch {
    ok = false;
  }
  if (!ok) return { error: "Bad signature." };

  const nowSec = Date.now() / 1000;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW < nowSec) return { error: "Token expired." };
  if (claims.iss !== hub) return { error: "Wrong issuer." };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(appId)) return { error: "Wrong audience." };
  // Hadi 是单用户的:sub 恒为 owner。别的主体一律不认。
  if (claims.sub !== "owner") return { error: "Wrong subject." };
  return claims;
}
