// Telegram Bot:登录码、消息处理、每日推送。
// 未配置 TELEGRAM_BOT_TOKEN 时全部功能优雅关闭。
import type { Env } from "./env";
import type { WordExplanation } from "../shared/types";
import { explainWord, llmChat } from "./ai";
import { now } from "./util";
import { issueLoginCode, chatAllowed } from "./logincode";
import { speechMp3 } from "./tts";
import { gradeVocab } from "./review";
import { fmtDay, fmtInterval, type ReviewGrade } from "../shared/srs";

const API = "https://api.telegram.org";
const DAILY_CARDS = 10; // 一天最多发几张卡,剩下的按到期顺序留到后面几天
const CARD_LIMIT = 700; // 卡片正文上限;Telegram caption 上限 1024,余量留给评分结果那一行
const CARD_GAP_MS = 400; // 连发多条时的间隔,避免触发群发限流

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function telegramEnabled(env: Env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

type TgResult = { ok: boolean; result?: unknown; parameters?: { retry_after?: number } };

/** 命中群发限流(429)时按 Telegram 给的秒数等一下,重试一次 */
async function request(env: Env, method: string, init: RequestInit): Promise<TgResult> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, init);
    const json = (await res.json()) as TgResult;
    if (res.status !== 429 || attempt >= 1) return json;
    await sleep(Math.min(json.parameters?.retry_after ?? 1, 5) * 1000);
  }
}

async function call(env: Env, method: string, body: Record<string, unknown>): Promise<TgResult> {
  return request(env, method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 带文件的接口(sendAudio 等)走 multipart */
async function callForm(env: Env, method: string, form: FormData): Promise<TgResult> {
  return request(env, method, { method: "POST", body: form });
}

export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
  replyMarkup?: unknown
): Promise<void> {
  try {
    await call(env, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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

interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: {
    chat: { id: number };
    message_id: number;
    text?: string;
    caption?: string;
    entities?: unknown[];
    caption_entities?: unknown[];
  };
}

interface TgUpdate {
  message?: { chat: { id: number }; text?: string };
  callback_query?: TgCallbackQuery;
}

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  // /login:发一个一次性登录码(网页端输入即可登录)
  if (text === "/login" || text.startsWith("/login ")) {
    if (!(await chatAllowed(env, chatId))) {
      await sendMessage(env, chatId, "This is a private bot.");
      return;
    }
    const issued = await issueLoginCode(env, chatId, null);
    await sendMessage(
      env,
      chatId,
      "error" in issued
        ? issued.error
        : `🔐 Sign-in code: <b>${issued.code}</b>\nValid for 5 minutes. Enter it at ${appUrl(env)}`
    );
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
        ? "Send me an English word for a quick lookup, or ask any question about your reading.\n\n/login — sign-in code for the web app\n/review — today's review cards"
        : "Welcome to <b>Immersive Reader</b>. Send /login to get a sign-in code for the web app."
    );
    return;
  }

  if (!user) {
    await sendMessage(env, chatId, "Send /login to get a sign-in code for the web app.");
    return;
  }

  if (text === "/review") {
    await sendReviewCards(env, user.id, chatId);
    return;
  }

  // 普通消息 → 当前提供商回答(英语学习助手)
  const reply = await llmChat(
    env,
    user.id,
    "telegram",
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

// ---------- 复习卡片(一词一条:音频 + Hard / Good / Easy) ----------

type VocabRow = { id: string; word: string; context_sentence: string | null; explanation_json: string | null };

const GRADES: { grade: Exclude<ReviewGrade, "again">; label: string; button: string }[] = [
  { grade: "hard", label: "Hard", button: "😖 Hard" },
  { grade: "good", label: "Good", button: "🙂 Good" },
  { grade: "easy", label: "Easy", button: "😄 Easy" },
];

function gradeKeyboard(vocabId: string) {
  return {
    inline_keyboard: [GRADES.map((g) => ({ text: g.button, callback_data: `rv:${g.grade}:${vocabId}` }))],
  };
}

/** 取缓存释义,缺则按需 AI 生成并写回缓存(mock 不缓存) */
async function ensureExplanation(
  env: Env,
  userId: string,
  row: VocabRow,
  level: string
): Promise<WordExplanation | null> {
  if (row.explanation_json) {
    try {
      return JSON.parse(row.explanation_json) as WordExplanation;
    } catch {
      /* 缓存损坏则重新生成 */
    }
  }
  const generated = await explainWord(env, userId, row.word, row.context_sentence ?? "", level);
  if (generated.source === "mock") return null;
  await env.DB.prepare("UPDATE vocab SET explanation_json = ? WHERE id = ?")
    .bind(JSON.stringify(generated), row.id)
    .run()
    .catch(() => {});
  return generated;
}

/** 逐段拼卡片,超长就丢掉后面的段,避免在 HTML 标签中间截断 */
function joinWithin(parts: string[], limit: number): string {
  let out = "";
  for (const p of parts) {
    if (out && out.length + p.length + 1 > limit) break;
    out = out ? `${out}\n${p}` : p;
  }
  return out;
}

function wordCard(row: VocabRow, exp: WordExplanation | null, idx: number, total: number): string {
  const head = [`<b>${esc(row.word.slice(0, 80))}</b>`];
  if (exp?.phonetic) head.push(esc(exp.phonetic.slice(0, 60)));
  if (exp?.pos) head.push(`<i>${esc(exp.pos.slice(0, 30))}</i>`);
  const parts = [`🃏 ${head.join(" ")}  ${idx}/${total}`];

  const meaning = exp?.meaning_zh || exp?.meaning_in_context;
  if (meaning) parts.push(esc(meaning.slice(0, 200)));
  if (exp?.meaning_in_context && exp.meaning_in_context !== meaning) {
    parts.push(esc(exp.meaning_in_context.slice(0, 200)));
  }
  if (row.context_sentence) parts.push(`<i>“${esc(row.context_sentence.trim().slice(0, 200))}”</i>`);
  const example = exp?.examples?.[0];
  if (example) parts.push(`e.g. ${esc(example.trim().slice(0, 160))}`);
  if (exp?.collocations?.length) parts.push(`🔗 ${esc(exp.collocations.slice(0, 4).join(" · ").slice(0, 120))}`);
  if (exp?.forms?.length) parts.push(`↔ ${esc(exp.forms.slice(0, 4).join(" / ").slice(0, 120))}`);
  if (!exp && !row.context_sentence) parts.push("Recall what this word means, then rate it.");
  return joinWithin(parts, CARD_LIMIT);
}

function fileSafe(word: string): string {
  return word.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "word";
}

/** 一张卡 = 一条带发音音频的消息 + 三个评分按钮;没有 TTS 时退化成纯文本卡 */
async function sendWordCard(
  env: Env,
  chatId: string,
  row: VocabRow,
  exp: WordExplanation | null,
  idx: number,
  total: number
): Promise<void> {
  const caption = wordCard(row, exp, idx, total);
  const markup = gradeKeyboard(row.id);
  const audio = await speechMp3(env, row.word, "US").catch(() => null);
  if (audio) {
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
      form.append("title", row.word.slice(0, 64));
      form.append("performer", "Immersive Reader");
      form.append("reply_markup", JSON.stringify(markup));
      form.append("audio", new Blob([audio], { type: "audio/mpeg" }), `${fileSafe(row.word)}.mp3`);
      const r = await callForm(env, "sendAudio", form);
      if (r.ok) return;
      console.warn("Telegram sendAudio 返回失败,回退纯文本卡片");
    } catch (e) {
      console.warn("Telegram sendAudio 异常:", (e as Error).message);
    }
  }
  await sendMessage(env, chatId, caption, markup);
}

/** 到期的词(新词 due_at IS NULL 排最前),以及到期总数 */
async function dueCards(env: Env, userId: string, limit: number): Promise<{ rows: VocabRow[]; total: number }> {
  const ts = now();
  const { results } = await env.DB.prepare(
    `SELECT id, word, context_sentence, explanation_json FROM vocab
     WHERE user_id = ? AND status != 'known' AND (due_at IS NULL OR due_at <= ?)
     ORDER BY due_at IS NOT NULL, due_at ASC LIMIT ?`
  )
    .bind(userId, ts, limit)
    .all<VocabRow>();
  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM vocab WHERE user_id = ? AND status != 'known' AND (due_at IS NULL OR due_at <= ?)"
  )
    .bind(userId, ts)
    .first<{ n: number }>();
  return { rows: results, total: total?.n ?? results.length };
}

/**
 * 今天该复习的词逐个发出来:一词一卡,带发音,按 Hard / Good / Easy 评分。
 * 评分后按艾宾浩斯遗忘曲线(SM-2)排下一次到期日,所以每天只发当天到期的那批。
 */
async function sendReviewCards(env: Env, userId: string, chatId: string): Promise<number> {
  const { rows, total } = await dueCards(env, userId, DAILY_CARDS);
  if (rows.length === 0) {
    await sendMessage(env, chatId, "No words due for review right now. 🎉");
    return 0;
  }
  const level =
    (await env.DB.prepare("SELECT english_level FROM users WHERE id = ?").bind(userId).first<{ english_level: string | null }>())
      ?.english_level ?? "intermediate";

  const head =
    total > rows.length
      ? `📝 <b>${rows.length} of ${total} due word(s)</b> — the rest come back on the following days.`
      : `📝 <b>${rows.length} word(s) to review today</b>`;
  await sendMessage(env, chatId, `${head}\nPlay the audio, recall the meaning, then rate it: Hard / Good / Easy.`);

  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await sleep(CARD_GAP_MS);
    const exp = await ensureExplanation(env, userId, rows[i], level);
    await sendWordCard(env, chatId, rows[i], exp, i + 1, rows.length);
  }
  return rows.length;
}

// ---------- 按钮评分回调 ----------

async function answerCallback(env: Env, id: string, text: string): Promise<void> {
  await call(env, "answerCallbackQuery", { callback_query_id: id, text }).catch(() => {});
}

async function handleCallback(env: Env, cq: TgCallbackQuery): Promise<void> {
  const msg = cq.message;
  const m = /^rv:(hard|good|easy):(.+)$/.exec(cq.data ?? "");
  if (!m || !msg) {
    await answerCallback(env, cq.id, "");
    return;
  }
  const chatId = String(msg.chat.id);
  const grade = m[1] as ReviewGrade;
  const user = await env.DB.prepare("SELECT id FROM users WHERE telegram_chat_id = ?")
    .bind(chatId)
    .first<{ id: string }>();
  if (!user) {
    await answerCallback(env, cq.id, "Send /login to link this chat first.");
    return;
  }
  const outcome = await gradeVocab(env, user.id, m[2], grade);
  if (!outcome) {
    await answerCallback(env, cq.id, "This word is no longer in your list.");
    return;
  }
  const label = GRADES.find((g) => g.grade === grade)?.label ?? grade;
  const result = outcome.graduated
    ? "mastered, leaving the review queue 🎓"
    : `next review in ${fmtInterval(outcome.interval_days)} (${fmtDay(outcome.due_at)})`;
  await answerCallback(env, cq.id, `${label} — ${outcome.graduated ? "mastered 🎓" : `back in ${fmtInterval(outcome.interval_days)}`}`);

  // 收起按钮并把结果写进卡片,避免同一张卡被重复评分。
  // Telegram 回传的 caption/text 已去掉 HTML 标记(格式在 *_entities 里),
  // 所以这里原样带上 entities、不再按 HTML 解析,只在末尾追加纯文本。
  const suffix = `\n\n✅ ${label} — ${result}`;
  const isCaption = typeof msg.caption === "string";
  const base = (isCaption ? msg.caption : msg.text) ?? "";
  const limit = isCaption ? 1024 : 4096;
  const fits = base.length + suffix.length <= limit;
  try {
    if (!fits) {
      await call(env, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } else if (isCaption) {
      await call(env, "editMessageCaption", {
        chat_id: chatId,
        message_id: msg.message_id,
        caption: `${base}${suffix}`,
        caption_entities: msg.caption_entities ?? [],
      });
    } else {
      await call(env, "editMessageText", {
        chat_id: chatId,
        message_id: msg.message_id,
        text: `${base}${suffix}`,
        entities: msg.entities ?? [],
      });
    }
  } catch (e) {
    console.warn("Telegram 卡片更新失败:", (e as Error).message);
  }
}

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
  // 最近在读的书
  const reading = await env.DB.prepare(
    `SELECT b.id AS book_id, b.title, rp.page_no FROM reading_progress rp
     JOIN books b ON b.id = rp.book_id WHERE rp.user_id = ? ORDER BY rp.updated_at DESC LIMIT 1`
  )
    .bind(userId)
    .first<{ book_id: string; title: string; page_no: number }>();

  // 过去 24 小时阅读时长(避开时区判日问题)
  const read = await env.DB.prepare(
    "SELECT SUM(active_ms) AS ms, COUNT(*) AS n FROM reading_sessions WHERE user_id = ? AND started_at >= ?"
  )
    .bind(userId, now() - 24 * 3600 * 1000)
    .first<{ ms: number | null; n: number }>();

  let msg = "📖 <b>Daily review</b>\n\n";
  const readMs = read?.ms ?? 0;
  if (readMs >= 60000) {
    msg += `⏱ You read for <b>${fmtDuration(readMs)}</b> in the last 24h (${read!.n} session${read!.n === 1 ? "" : "s"}). Keep it up!\n\n`;
  } else {
    msg += "⏱ No reading in the last 24h — even a few pages today counts. 📚\n\n";
  }

  if (reading) {
    msg += `Currently reading: <b>${esc(reading.title)}</b> (page ${reading.page_no}).\n`;
    // 用最近页文本生成一句中文回顾
    const page = await env.DB.prepare("SELECT text FROM pages WHERE book_id = ? AND page_no = ?")
      .bind(reading.book_id, reading.page_no)
      .first<{ text: string }>();
    if (page?.text && page.text.length > 60) {
      const recap = await llmChat(
        env,
        userId,
        "telegram",
        [
          { role: "system", content: "用一句简洁的中文概括这段英文的主要内容,帮助读者回顾。只输出这句话。" },
          { role: "user", content: page.text.slice(0, 2500) },
        ],
        { maxTokens: 200 }
      );
      if (recap) msg += `Recap: ${esc(recap.trim().slice(0, 800))}\n`;
    }
    msg += "\n";
  }

  msg += `Open the app to continue: ${appUrl(env)}`;
  await sendMessage(env, chatId, msg);

  // 复习词随后逐张发卡(带发音和评分按钮)
  await sendReviewCards(env, userId, chatId);
}
