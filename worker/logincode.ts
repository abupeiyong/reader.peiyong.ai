// Telegram 一次性登录码(随机密码登录)。
// 个人站点:只有「站长的 Telegram chat」能拿到码,码只在 Telegram 里出现,网页端输入验证。
import type { Env } from "./env";
import { uid, now, sha256Hex } from "./util";

export const CODE_TTL = 5 * 60 * 1000;      // 码有效期 5 分钟
const RESEND_COOLDOWN = 60 * 1000;          // 同一 chat 两次发码最小间隔
const MAX_PER_HOUR = 8;                     // 同一 chat 每小时发码上限(防被人刷屏)
const MAX_ATTEMPTS = 5;                     // 单个码最多试错次数

function codeHash(chatId: string, code: string): Promise<string> {
  return sha256Hex(`${chatId}:${code}`);
}

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}

function envOwner(env: Env): string | null {
  const v = env.TELEGRAM_OWNER_CHAT_ID?.trim();
  return v ? v : null;
}

/** 网页端发码的目标 chat:优先 env 指定,其次库里唯一已绑定的账号 */
export async function ownerChatId(env: Env): Promise<string | null> {
  const fromEnv = envOwner(env);
  if (fromEnv) return fromEnv;
  const { results } = await env.DB.prepare(
    "SELECT telegram_chat_id AS chat FROM users WHERE telegram_chat_id IS NOT NULL LIMIT 2"
  ).all<{ chat: string }>();
  return results.length === 1 ? results[0].chat : null;
}

/** 该 chat 是否有权登录:env 指定 / 已绑定账号 / 库里尚无任何绑定时首次认领(TOFU) */
export async function chatAllowed(env: Env, chatId: string): Promise<boolean> {
  const fromEnv = envOwner(env);
  if (fromEnv) return fromEnv === chatId;
  const bound = await env.DB.prepare("SELECT id FROM users WHERE telegram_chat_id = ?").bind(chatId).first();
  if (bound) return true;
  const anyBound = await env.DB.prepare("SELECT id FROM users WHERE telegram_chat_id IS NOT NULL LIMIT 1").first();
  return !anyBound;
}

export type IssueResult = { code: string } | { error: string; retry_after?: number };

/** 生成并落库一个新码(旧码立即作废);返回明文码供调用方通过 Telegram 发送 */
export async function issueLoginCode(env: Env, chatId: string, ticket: string | null): Promise<IssueResult> {
  const ts = now();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM login_codes WHERE chat_id = ? AND created_at > ?"
  )
    .bind(chatId, ts - 3600 * 1000)
    .first<{ n: number; last: number | null }>();
  if (recent?.last && ts - recent.last < RESEND_COOLDOWN) {
    const wait = Math.ceil((RESEND_COOLDOWN - (ts - recent.last)) / 1000);
    return { error: `A code was just sent. Try again in ${wait}s.`, retry_after: wait };
  }
  if ((recent?.n ?? 0) >= MAX_PER_HOUR) return { error: "Too many code requests. Try again in an hour." };

  const code = randomCode();
  await env.DB.prepare("UPDATE login_codes SET used = 1 WHERE chat_id = ? AND used = 0").bind(chatId).run();
  await env.DB.prepare(
    "INSERT INTO login_codes (id, chat_id, code_hash, ticket, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(uid("lc"), chatId, await codeHash(chatId, code), ticket, ts + CODE_TTL, ts)
    .run();
  // 顺手清理一天前的记录
  await env.DB.prepare("DELETE FROM login_codes WHERE created_at < ?")
    .bind(ts - 24 * 3600 * 1000)
    .run()
    .catch(() => {});
  return { code };
}

/** 校验网页端输入的码;成功返回对应 chat 并作废该码 */
export async function verifyLoginCode(
  env: Env,
  code: string,
  ticket: string | null
): Promise<{ chat_id: string } | { error: string }> {
  const ts = now();
  const { results } = await env.DB.prepare(
    "SELECT id, chat_id, code_hash, ticket, attempts FROM login_codes WHERE used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 20"
  )
    .bind(ts)
    .all<{ id: string; chat_id: string; code_hash: string; ticket: string | null; attempts: number }>();

  for (const row of results) {
    if (row.attempts >= MAX_ATTEMPTS) continue;
    // 网页发起的码只认当初那台浏览器;bot /login 发起的码(ticket 为空)不限
    if (row.ticket && row.ticket !== ticket) continue;
    if ((await codeHash(row.chat_id, code)) !== row.code_hash) continue;
    await env.DB.prepare("UPDATE login_codes SET used = 1 WHERE id = ?").bind(row.id).run();
    return { chat_id: row.chat_id };
  }

  await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE used = 0 AND expires_at > ?")
    .bind(ts)
    .run();
  return { error: "Invalid or expired code." };
}
