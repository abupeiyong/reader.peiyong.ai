// Telegram Bot:绑定、消息处理、每日推送。
// 未配置 TELEGRAM_BOT_TOKEN 时全部功能优雅关闭。
import type { Env } from "./env";
import { openaiChat } from "./openai";
import { now } from "./util";

const API = "https://api.telegram.org";

export function telegramEnabled(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

async function call(env: Env, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown }> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: unknown };
}

export async function sendMessage(env: Env, chatId: string | number, text: string): Promise<void> {
  try {
    await call(env, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.warn("Telegram sendMessage 失败:", (e as Error).message);
  }
}

export async function getBotUsername(env: Env): Promise<string | null> {
  if (env.TELEGRAM_BOT_USERNAME) return env.TELEGRAM_BOT_USERNAME;
  try {
    const r = await call(env, "getMe", {});
    return (r.result as { username?: string })?.username ?? null;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- webhook 消息处理 ----------

interface TgUpdate {
  message?: { chat: { id: number }; text?: string };
}

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  // /start <code> 绑定
  const startMatch = text.match(/^\/start\s+(\S+)/);
  if (startMatch) {
    const code = startMatch[1];
    const user = await env.DB.prepare("SELECT id FROM users WHERE telegram_link_code = ?").bind(code).first<{ id: string }>();
    if (user) {
      await env.DB.prepare(
        "UPDATE users SET telegram_chat_id = ?, telegram_link_code = NULL, tg_daily_enabled = 1 WHERE id = ?"
      )
        .bind(chatId, user.id)
        .run();
      await sendMessage(
        env,
        chatId,
        "✅ <b>Connected!</b>\nYou'll get a daily review reminder here. Send me any English word or question and I'll help.\n\nCommands: /review — today's words · /help"
      );
    } else {
      await sendMessage(env, chatId, "This link code is invalid or expired. Open the app → Telegram to reconnect.");
    }
    return;
  }

  const user = await env.DB.prepare("SELECT id, english_level FROM users WHERE telegram_chat_id = ?")
    .bind(chatId)
    .first<{ id: string; english_level: string }>();

  if (text === "/start" || text === "/help") {
    await sendMessage(
      env,
      chatId,
      user
        ? "Send me an English word for a quick lookup, or ask any question about your reading.\n\n/review — today's review words"
        : "Welcome to <b>Immersive Reader</b>. Open the app and go to Telegram to connect your account."
    );
    return;
  }

  if (!user) {
    await sendMessage(env, chatId, "Please connect your account first: open the app → Telegram → Connect.");
    return;
  }

  if (text === "/review") {
    await sendReviewList(env, user.id, chatId);
    return;
  }

  // 普通消息 → gpt-5-nano 回答(英语学习助手)
  const reply = await openaiChat(
    env,
    [
      {
        role: "system",
        content:
          "You are an English learning assistant for a native Chinese speaker. Answer concisely in Chinese. If the user sends a single English word or short phrase, give: phonetic, part of speech, Chinese meaning, and one short example sentence. For questions, explain clearly and briefly.",
      },
      { role: "user", content: text },
    ],
    { maxTokens: 600 }
  );
  await sendMessage(env, chatId, reply ? esc(reply) : "AI is unavailable right now, please try again later.");
}

async function sendReviewList(env: Env, userId: string, chatId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT word, context_sentence FROM vocab WHERE user_id = ? AND status != 'known' AND (due_at IS NULL OR due_at <= ?) ORDER BY due_at LIMIT 12"
  )
    .bind(userId, now())
    .all<{ word: string; context_sentence: string | null }>();
  if (results.length === 0) {
    await sendMessage(env, chatId, "No words due for review right now. 🎉");
    return;
  }
  const lines = results.map((r) => `• <b>${esc(r.word)}</b>${r.context_sentence ? `\n  <i>${esc(r.context_sentence.slice(0, 100))}</i>` : ""}`);
  await sendMessage(env, chatId, `📝 <b>${results.length} word(s) to review:</b>\n\n${lines.join("\n")}\n\nReview in the app to schedule them: ${appUrl(env)}`);
}

function appUrl(env: Env): string {
  return env.APP_URL || env.APP_ORIGIN || "https://reader.peiyong.ai";
}

// ---------- 每日推送(cron) ----------

export async function runDailyPush(env: Env): Promise<void> {
  if (!telegramEnabled(env)) return;
  const ts = now();
  const hour = new Date(ts).getUTCHours();
  const today = new Date(ts).toISOString().slice(0, 10);
  const { results: users } = await env.DB.prepare(
    `SELECT id, telegram_chat_id FROM users
     WHERE tg_daily_enabled = 1 AND telegram_chat_id IS NOT NULL
       AND tg_daily_hour = ? AND (tg_last_push IS NULL OR tg_last_push != ?)`
  )
    .bind(hour, today)
    .all<{ id: string; telegram_chat_id: string }>();

  for (const u of users) {
    try {
      await pushDaily(env, u.id, u.telegram_chat_id);
    } catch (e) {
      console.warn("每日推送失败:", u.id, (e as Error).message);
    }
    await env.DB.prepare("UPDATE users SET tg_last_push = ? WHERE id = ?").bind(today, u.id).run();
  }
}

async function pushDaily(env: Env, userId: string, chatId: string): Promise<void> {
  // 待复习词
  const { results: due } = await env.DB.prepare(
    "SELECT word FROM vocab WHERE user_id = ? AND status != 'known' AND (due_at IS NULL OR due_at <= ?) ORDER BY due_at LIMIT 8"
  )
    .bind(userId, now())
    .all<{ word: string }>();

  // 最近在读的书
  const reading = await env.DB.prepare(
    `SELECT b.id AS book_id, b.title, rp.page_no FROM reading_progress rp
     JOIN books b ON b.id = rp.book_id WHERE rp.user_id = ? ORDER BY rp.updated_at DESC LIMIT 1`
  )
    .bind(userId)
    .first<{ book_id: string; title: string; page_no: number }>();

  let msg = "📖 <b>Daily review</b>\n\n";
  if (due.length) {
    msg += `You have <b>${due.length}</b> word(s) to review today:\n`;
    msg += due.map((d) => `• ${esc(d.word)}`).join("\n");
    msg += "\n\n";
  } else {
    msg += "No words are due today — your queue is clear. 🎉\n\n";
  }

  if (reading) {
    msg += `Currently reading: <b>${esc(reading.title)}</b> (page ${reading.page_no}).\n`;
    // 用最近页文本生成一句中文回顾
    const page = await env.DB.prepare("SELECT text FROM pages WHERE book_id = ? AND page_no = ?")
      .bind(reading.book_id, reading.page_no)
      .first<{ text: string }>();
    if (page?.text && page.text.length > 60) {
      const recap = await openaiChat(
        env,
        [
          { role: "system", content: "用一句简洁的中文概括这段英文的主要内容,帮助读者回顾。只输出这句话。" },
          { role: "user", content: page.text.slice(0, 2500) },
        ],
        { maxTokens: 200 }
      );
      if (recap) msg += `Recap: ${esc(recap.trim())}\n`;
    }
    msg += "\n";
  }

  msg += `Open the app to continue: ${appUrl(env)}`;
  await sendMessage(env, chatId, msg);
}
