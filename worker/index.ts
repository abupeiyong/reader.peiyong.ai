import { Hono } from "hono";
import type { Env, Vars } from "./env";
import { authRoutes, requireAuth } from "./auth";
import { uid, now, tokenizeWords, fnv1aHex, sha256Hex } from "./util";
import { explainWord, analyzePage, chatStream, transcribeAudio, embedTexts, ttsAudio, ocrImage } from "./ai";
import { elevenTts, voiceTag } from "./elevenlabs";
import { estimateVocabRank, hintsForText, applyReview, priorRank, type ReviewGrade } from "./vocabmodel";
import { wordRank } from "./wordfreq";
import { telegramEnabled, handleUpdate, runDailyPush } from "./telegram";
import { generateCover } from "./cover";
import { openaiProbe } from "./openai";
import {
  PROVIDERS,
  PROVIDER_IDS,
  RANDOM_PROVIDER,
  activeChoice,
  activeModel,
  envKey,
  envModel,
  isProviderChoice,
  isProviderId,
  loadAiSettings,
  modelColumn,
  providerConfig,
  providerModels,
  userKey,
  withAiSchema,
  wordThinking,
} from "./aiprovider";
import {
  DAILY_GOAL_MS,
  type AiCallKind,
  type AiCallLog,
  type AiLatencyGroup,
  type AiProviderTest,
  type AiSettings,
  type AiStats,
  type ChatScope,
  type ReadingToday,
} from "../shared/types";

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.route("/api/auth", authRoutes);

// Telegram webhook(无需登录;由 secret token 校验来源),挂在 requireAuth 之前
const tg = new Hono<{ Bindings: Env; Variables: Vars }>();
tg.post("/webhook", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!c.env.TELEGRAM_WEBHOOK_SECRET || secret !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ ok: false }, 403);
  }
  const update = await c.req.json().catch(() => ({}));
  c.executionCtx.waitUntil(handleUpdate(c.env, update));
  return c.json({ ok: true });
});
app.route("/api/tg", tg);

const api = new Hono<{ Bindings: Env; Variables: Vars }>();
api.use("*", requireAuth);

// ---------- 按用户本地日分桶 ----------
// tzoff:客户端 getTimezoneOffset() 传上来的分钟数(UTC 减本地,东八区是 -480)。
//
// 阅读会话的归属口径(/stats、/calendar、/reading-today 三处统一用这一套):
// 一次会话整段计入它「开始」的那个本地日。reading_sessions 里只有起止时间和 active_ms 总量,
// 没有逐段时间线,跨午夜的会话没法精确按午夜切开;按开始日归属的好处是写下就不再变,
// 不会因为会话还在继续而让昨天的统计往回改。
const DAY_MS = 86400000;
const tzShift = (tzoff: number) => (Number.isFinite(tzoff) ? tzoff : 0) * 60000;
/** 时间戳所属的本地日,YYYY-MM-DD */
const localDayKey = (ts: number, tzoff: number) => new Date(ts - tzShift(tzoff)).toISOString().slice(0, 10);
/** 时间戳所属本地日的零点(UTC 毫秒) */
const localDayStart = (ts: number, tzoff: number) =>
  Math.floor((ts - tzShift(tzoff)) / DAY_MS) * DAY_MS + tzShift(tzoff);
/** 一次阅读会话计入哪个本地日 */
const sessionDayKey = (s: { started_at: number }, tzoff: number) => localDayKey(s.started_at, tzoff);

/** 学习活动日志(阅读报告用),失败不影响主流程 */
function logActivity(env: Env, userId: string, kind: string, bookId?: string | null, pageNo?: number | null) {
  return env.DB.prepare("INSERT INTO activity (user_id, kind, book_id, page_no, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, kind, bookId ?? null, pageNo ?? null, now())
    .run()
    .catch((e) => console.warn("activity log 失败:", (e as Error).message));
}

/** 词汇量当日快照(趋势图用),同日多次调用取最新值 */
async function saveVocabSnapshot(env: Env, userId: string, vocabRank: number) {
  try {
    const day = new Date(now()).toISOString().slice(0, 10);
    const counts = await env.DB.prepare(
      "SELECT SUM(CASE WHEN status = 'known' THEN 1 ELSE 0 END) AS known, COUNT(*) AS saved FROM vocab WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ known: number | null; saved: number }>();
    await env.DB.prepare(
      `INSERT INTO vocab_snapshots (user_id, day, vocab_rank, known_count, saved_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         vocab_rank = excluded.vocab_rank, known_count = excluded.known_count,
         saved_count = excluded.saved_count, updated_at = excluded.updated_at`
    )
      .bind(userId, day, vocabRank, counts?.known ?? 0, counts?.saved ?? 0, now())
      .run();
  } catch (e) {
    console.warn("vocab snapshot 失败:", (e as Error).message);
  }
}

// ---------- 用户 ----------

api.get("/me", async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT id, email, name, avatar_url, english_level, hints_enabled FROM users WHERE id = ?"
  )
    .bind(c.get("userId"))
    .first();
  return c.json(user);
});

api.patch("/me", async (c) => {
  const body = await c.req.json<{ english_level?: string; hints_enabled?: number; name?: string }>();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.english_level && ["beginner", "intermediate", "advanced"].includes(body.english_level)) {
    sets.push("english_level = ?");
    vals.push(body.english_level);
  }
  if (body.hints_enabled !== undefined) {
    sets.push("hints_enabled = ?");
    vals.push(body.hints_enabled ? 1 : 0);
  }
  if (body.name) {
    sets.push("name = ?");
    vals.push(body.name);
  }
  if (sets.length) {
    vals.push(c.get("userId"));
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  }
  return c.json({ ok: true });
});

// ---------- 书库 ----------

api.get("/books", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.title, b.filename, b.size, b.page_count, b.status, b.created_at, b.cover_key,
            rp.page_no AS progress_page
     FROM books b
     LEFT JOIN reading_progress rp ON rp.book_id = b.id AND rp.user_id = b.user_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`
  )
    .bind(c.get("userId"))
    .all();
  return c.json(results);
});

api.post("/books", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "缺少文件" }, 400);
  if (!file.name.toLowerCase().endsWith(".pdf")) return c.json({ error: "仅支持 PDF 文件" }, 400);
  if (file.size > 80 * 1024 * 1024) return c.json({ error: "文件过大(上限 80MB)" }, 400);

  const id = uid("bk");
  const key = `pdfs/${c.get("userId")}/${id}.pdf`;
  await c.env.BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: "application/pdf" },
  });
  const title = file.name.replace(/\.pdf$/i, "");
  await c.env.DB.prepare(
    "INSERT INTO books (id, user_id, title, filename, r2_key, size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)"
  )
    .bind(id, c.get("userId"), title, file.name, key, file.size, now())
    .run();
  return c.json({ id, title, status: "processing" });
});

async function getBook(c: { env: Env }, userId: string, bookId: string) {
  return c.env.DB.prepare("SELECT * FROM books WHERE id = ? AND user_id = ?")
    .bind(bookId, userId)
    .first<{ id: string; title: string; r2_key: string; page_count: number; status: string; cover_key: string | null }>();
}

api.get("/books/:id", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  return c.json(book);
});

// 改书名
api.patch("/books/:id", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }));
  const title = (body.title ?? "").trim().slice(0, 200);
  if (!title) return c.json({ error: "书名不能为空" }, 400);
  await c.env.DB.prepare("UPDATE books SET title = ? WHERE id = ?").bind(title, book.id).run();
  return c.json({ ok: true, title });
});

// 生成/重新生成封面(上传完成后前端调用一次;编辑弹窗 Regenerate 也走这里)
api.post("/books/:id/cover", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const cover = await generateCover(c.env, book.title, now());
  const key = `covers/${c.get("userId")}/${book.id}-${now()}.${cover.ext}`;
  await c.env.BUCKET.put(key, cover.bytes, { httpMetadata: { contentType: cover.contentType } });
  if (book.cover_key) {
    const old = book.cover_key;
    c.executionCtx.waitUntil(c.env.BUCKET.delete(old).catch(() => {}));
  }
  await c.env.DB.prepare("UPDATE books SET cover_key = ? WHERE id = ?").bind(key, book.id).run();
  return c.json({ cover_key: key });
});

api.get("/books/:id/cover", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book?.cover_key) return c.json({ error: "no cover" }, 404);
  const obj = await c.env.BUCKET.get(book.cover_key);
  if (!obj) return c.json({ error: "cover missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/jpeg",
      // key 含时间戳,重新生成会换 URL,可长缓存
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});

api.delete("/books/:id", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  await c.env.BUCKET.delete(book.r2_key);
  if (book.cover_key) await c.env.BUCKET.delete(book.cover_key).catch(() => {});
  if (c.env.VECTORIZE && book.page_count > 0) {
    const ids = Array.from({ length: book.page_count }, (_, i) => `${book.id}:${i + 1}`);
    c.executionCtx.waitUntil(
      c.env.VECTORIZE.deleteByIds(ids).catch((e) => console.warn("Vectorize 删除失败:", (e as Error).message))
    );
  }
  await c.env.DB.prepare("DELETE FROM books WHERE id = ?").bind(book.id).run();
  return c.json({ ok: true });
});

api.get("/books/:id/file", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const obj = await c.env.BUCKET.get(book.r2_key);
  if (!obj) return c.json({ error: "file missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=3600",
    },
  });
});

/** 把书的页面嵌入 Vectorize(后台执行,失败静默降级为关键词检索) */
async function indexBookPages(env: Env, bookId: string, pages: { page_no: number; text: string }[]) {
  if (!env.VECTORIZE) return;
  const usable = pages.filter((p) => p.text.trim().length > 80);
  for (let i = 0; i < usable.length; i += 20) {
    const batch = usable.slice(i, i + 20);
    const vectors = await embedTexts(
      env,
      batch.map((p) => p.text.slice(0, 2500))
    );
    if (!vectors) return;
    await env.VECTORIZE.upsert(
      batch.map((p, j) => ({
        id: `${bookId}:${p.page_no}`,
        values: vectors[j],
        metadata: { book_id: bookId, page_no: p.page_no },
      }))
    ).catch((e) => console.warn("Vectorize upsert 失败:", (e as Error).message));
  }
}

// 客户端用 PDF.js 提取文本后批量上报(临时方案:避免 Worker 内解析 PDF 的 CPU 限制;
// 后续可换 Queues + 服务端解析)
api.post("/books/:id/pages", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ page_count: number; pages: { page_no: number; text: string }[] }>();
  if (!Array.isArray(body.pages)) return c.json({ error: "bad payload" }, 400);

  const pages = body.pages.map((p) => ({ page_no: p.page_no, text: (p.text || "").slice(0, 40000) }));
  const stmts = pages.map((p) =>
    c.env.DB.prepare(
      "INSERT INTO pages (book_id, page_no, text) VALUES (?, ?, ?) ON CONFLICT(book_id, page_no) DO UPDATE SET text = excluded.text"
    ).bind(book.id, p.page_no, p.text)
  );
  // D1 batch 一次最多不宜过大,分块
  for (let i = 0; i < stmts.length; i += 50) {
    await c.env.DB.batch(stmts.slice(i, i + 50));
  }
  await c.env.DB.prepare("UPDATE books SET page_count = ?, status = 'ready' WHERE id = ?")
    .bind(body.page_count, book.id)
    .run();
  // 后台向量化(不阻塞响应)
  c.executionCtx.waitUntil(indexBookPages(c.env, book.id, pages));
  return c.json({ ok: true });
});

api.get("/books/:id/pages/:no", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const row = await c.env.DB.prepare("SELECT text, analysis_json FROM pages WHERE book_id = ? AND page_no = ?")
    .bind(book.id, Number(c.req.param("no")))
    .first<{ text: string; analysis_json: string | null }>();
  return c.json({ text: row?.text ?? "", analysis: row?.analysis_json ? JSON.parse(row.analysis_json) : null });
});

// 本页解析(带缓存)
api.post("/books/:id/pages/:no/analysis", async (c) => {
  const userId = c.get("userId");
  const book = await getBook(c, userId, c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const pageNo = Number(c.req.param("no"));
  const row = await c.env.DB.prepare("SELECT text, analysis_json FROM pages WHERE book_id = ? AND page_no = ?")
    .bind(book.id, pageNo)
    .first<{ text: string; analysis_json: string | null }>();
  if (!row || !row.text.trim()) return c.json({ error: "本页没有可分析的文本" }, 400);

  const force = c.req.query("force") === "1";
  if (row.analysis_json && !force) {
    const cached = JSON.parse(row.analysis_json);
    if (cached.source !== "mock") return c.json(cached);
  }

  const user = await c.env.DB.prepare("SELECT english_level FROM users WHERE id = ?")
    .bind(userId)
    .first<{ english_level: string }>();
  const analysis = await analyzePage(c.env, userId, row.text, user?.english_level ?? "intermediate");
  await c.env.DB.prepare("UPDATE pages SET analysis_json = ? WHERE book_id = ? AND page_no = ?")
    .bind(JSON.stringify(analysis), book.id, pageNo)
    .run();
  return c.json(analysis);
});

// 章节目录启发式兜底(PDF 无 outline 时):扫页面文本找章节标题行
api.get("/books/:id/toc", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT page_no, text FROM pages WHERE book_id = ? AND length(text) > 0 ORDER BY page_no"
  )
    .bind(book.id)
    .all<{ page_no: number; text: string }>();
  const headRe = /^(chapter|part|section|book|prologue|epilogue|introduction|preface|appendix)\b/i;
  const toc: { title: string; page: number; level: number }[] = [];
  let lastTitle = "";
  for (const p of results) {
    const lines = (p.text || "")
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 5);
    for (const line of lines) {
      if (line.length <= 60 && headRe.test(line) && line !== lastTitle) {
        toc.push({ title: line, page: p.page_no, level: 0 });
        lastTitle = line;
        break;
      }
    }
  }
  return c.json(toc);
});

// 个性化生词提示:词频模型 + 用户行为估计,挑出本页可能不认识的词
api.get("/books/:id/pages/:no/hints", async (c) => {
  const userId = c.get("userId");
  const book = await getBook(c, userId, c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const row = await c.env.DB.prepare("SELECT text FROM pages WHERE book_id = ? AND page_no = ?")
    .bind(book.id, Number(c.req.param("no")))
    .first<{ text: string }>();
  if (!row?.text) return c.json({ words: [], vocab_rank: null });

  const user = await c.env.DB.prepare("SELECT english_level FROM users WHERE id = ?")
    .bind(userId)
    .first<{ english_level: string }>();

  // 行为观测:认识的词 vs 查询/收藏过的词
  const { results: events } = await c.env.DB.prepare(
    `SELECT word, action FROM word_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`
  )
    .bind(userId)
    .all<{ word: string; action: string }>();
  const knownWords = new Set<string>();
  const knownRanks: number[] = [];
  const unknownRanks: number[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.word)) continue; // 每个词只取最近一次行为
    seen.add(e.word);
    const rank = wordRank(e.word);
    if (e.action === "known") {
      knownWords.add(e.word);
      if (rank !== null) knownRanks.push(rank);
    } else if (rank !== null) {
      unknownRanks.push(rank);
    }
  }

  const vocabRank = estimateVocabRank(user?.english_level ?? "intermediate", { knownRanks, unknownRanks });
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE users SET vocab_rank = ? WHERE id = ?")
      .bind(vocabRank, userId)
      .run()
      .then(() => saveVocabSnapshot(c.env, userId, vocabRank))
  );

  const words = hintsForText(row.text, { userRank: vocabRank, knownWords });
  return c.json({ words, vocab_rank: vocabRank });
});

// ---------- 间隔重复复习(SM-2) ----------

api.get("/review/queue", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM vocab WHERE user_id = ? AND status != 'known' AND (due_at IS NULL OR due_at <= ?)
     ORDER BY due_at IS NOT NULL, due_at ASC LIMIT 20`
  )
    .bind(c.get("userId"), now())
    .all();
  const total = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM vocab WHERE user_id = ? AND status != 'known' AND (due_at IS NULL OR due_at <= ?)"
  )
    .bind(c.get("userId"), now())
    .first<{ n: number }>();
  return c.json({ items: results, due_count: total?.n ?? 0 });
});

api.post("/review/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ grade: ReviewGrade }>();
  if (!["again", "hard", "good", "easy"].includes(body.grade)) return c.json({ error: "bad grade" }, 400);
  const item = await c.env.DB.prepare("SELECT interval_days, ease, reps FROM vocab WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), userId)
    .first<{ interval_days: number; ease: number; reps: number }>();
  if (!item) return c.json({ error: "not found" }, 404);
  const next = applyReview(item, body.grade, now());
  // 长间隔视为已掌握
  const newStatus = next.interval_days >= 30 ? "known" : undefined;
  await c.env.DB.prepare(
    `UPDATE vocab SET interval_days = ?, ease = ?, reps = ?, due_at = ?, last_review = ?, updated_at = ?
     ${newStatus ? ", status = 'known'" : ""} WHERE id = ? AND user_id = ?`
  )
    .bind(next.interval_days, next.ease, next.reps, next.due_at, now(), now(), c.req.param("id"), userId)
    .run();
  void logActivity(c.env, userId, "review");
  return c.json({ ok: true, due_at: next.due_at, interval_days: next.interval_days, graduated: Boolean(newStatus) });
});

// 复习卡缺完整释义时按需生成并缓存(不写 word_events,避免干扰词汇模型)
api.post("/review/:id/explanation", async (c) => {
  const userId = c.get("userId");
  const item = await c.env.DB.prepare(
    "SELECT id, word, context_sentence, explanation_json FROM vocab WHERE id = ? AND user_id = ?"
  )
    .bind(c.req.param("id"), userId)
    .first<{ id: string; word: string; context_sentence: string | null; explanation_json: string | null }>();
  if (!item) return c.json({ error: "not found" }, 404);

  if (item.explanation_json) {
    try {
      const cached = JSON.parse(item.explanation_json);
      if (cached.source !== "mock") return c.json(cached);
    } catch {
      /* 缓存损坏则重新生成 */
    }
  }

  const user = await c.env.DB.prepare("SELECT english_level FROM users WHERE id = ?")
    .bind(userId)
    .first<{ english_level: string }>();
  const exp = await explainWord(c.env, userId, item.word, item.context_sentence ?? "", user?.english_level ?? "intermediate");
  if (exp.source !== "mock") {
    await c.env.DB.prepare("UPDATE vocab SET explanation_json = ? WHERE id = ? AND user_id = ?")
      .bind(JSON.stringify(exp), item.id, userId)
      .run();
  }
  return c.json(exp);
});

// ---------- 学习报告 ----------

api.get("/stats", async (c) => {
  const userId = c.get("userId");
  const since = now() - 30 * 24 * 3600 * 1000;
  const tzoff = Number(c.req.query("tzoff") ?? 0); // 分钟(getTimezoneOffset),按用户本地日分桶
  const { results: acts } = await c.env.DB.prepare(
    "SELECT kind, created_at FROM activity WHERE user_id = ? AND created_at >= ? ORDER BY created_at ASC"
  )
    .bind(userId, since)
    .all<{ kind: string; created_at: number }>();

  const dayKey = (ts: number) => localDayKey(ts, tzoff);
  const days: Record<string, Record<string, number>> = {};
  for (let i = 29; i >= 0; i--) {
    days[dayKey(now() - i * 24 * 3600 * 1000)] = {};
  }
  for (const a of acts) {
    const k = dayKey(a.created_at);
    if (!days[k]) days[k] = {};
    days[k][a.kind] = (days[k][a.kind] ?? 0) + 1;
  }

  // 连续学习天数(从今天往回数)
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const k = dayKey(now() - i * 24 * 3600 * 1000);
    const has = days[k] && Object.keys(days[k]).length > 0;
    if (has) streak++;
    else if (i > 0) break; // 今天还没学不打断连续
    else if (i === 0 && !has) continue;
  }

  // 每日阅读时长(近 30 天,active_ms 按会话开始的本地日聚合,见 sessionDayKey)
  const { results: sessions } = await c.env.DB.prepare(
    "SELECT started_at, active_ms FROM reading_sessions WHERE user_id = ? AND started_at >= ?"
  )
    .bind(userId, since)
    .all<{ started_at: number; active_ms: number }>();
  const readMs: Record<string, number> = {};
  for (const k of Object.keys(days)) readMs[k] = 0;
  for (const s of sessions) {
    const k = sessionDayKey(s, tzoff);
    if (k in readMs) readMs[k] += s.active_ms;
  }

  const vocabCounts = await c.env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM vocab WHERE user_id = ? GROUP BY status"
  )
    .bind(userId)
    .all<{ status: string; n: number }>();
  const dueCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM vocab WHERE user_id = ? AND status != 'known' AND (due_at IS NULL OR due_at <= ?)"
  )
    .bind(userId, now())
    .first<{ n: number }>();
  const bookCount = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM books WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  const user = await c.env.DB.prepare("SELECT english_level, vocab_rank FROM users WHERE id = ?")
    .bind(userId)
    .first<{ english_level: string; vocab_rank: number | null }>();
  const vocabRank = user?.vocab_rank ?? priorRank(user?.english_level ?? "intermediate");

  // 补记当日快照(即使当天没触发 hints 估算,趋势也不断档),再取近 90 天
  await saveVocabSnapshot(c.env, userId, vocabRank);
  const { results: trend } = await c.env.DB.prepare(
    `SELECT day, vocab_rank, known_count, saved_count FROM vocab_snapshots
     WHERE user_id = ? ORDER BY day DESC LIMIT 90`
  )
    .bind(userId)
    .all<{ day: string; vocab_rank: number; known_count: number; saved_count: number }>();
  trend.reverse();

  return c.json({
    days: Object.entries(days).map(([date, kinds]) => ({ date, ...kinds })),
    read_days: Object.entries(readMs).map(([date, ms]) => ({ date, ms })),
    streak,
    vocab: Object.fromEntries(vocabCounts.results.map((r) => [r.status, r.n])),
    due_count: dueCount?.n ?? 0,
    book_count: bookCount?.n ?? 0,
    vocab_rank: vocabRank,
    vocab_trend: trend,
  });
});

// ---------- AI 提供商设置(OpenAI / DeepSeek)----------

// key 只回显末 4 位:填过之后前端也拿不到明文
function keyHint(key: string): string {
  return key.length > 4 ? `…${key.slice(-4)}` : key ? "…" : "";
}

api.get("/ai/settings", async (c) => {
  const row = await loadAiSettings(c.env, c.get("userId"));
  const provider = activeChoice(row);
  // 模型清单可能要问提供商的 /models(DeepSeek),几家并行问
  const models = await Promise.all(PROVIDER_IDS.map((id) => providerModels(c.env, row, id)));
  const body: AiSettings = {
    provider,
    // random 没有单一的「当前模型」:抽到哪家就用哪家的 model
    model: provider === RANDOM_PROVIDER ? "" : activeModel(c.env, row, provider),
    providers: PROVIDER_IDS.map((id, i) => {
      const fromUser = userKey(row, id);
      const fromEnv = envKey(c.env, id);
      const key = fromUser || fromEnv;
      return {
        id,
        label: PROVIDERS[id].label,
        models: models[i],
        model: activeModel(c.env, row, id),
        default_model: envModel(c.env, id),
        key_set: Boolean(key),
        key_source: fromUser ? "user" : fromEnv ? "env" : null,
        key_hint: keyHint(key),
      };
    }),
    word_thinking: wordThinking(row),
  };
  return c.json(body);
});

// 提供商 / 模型 / API key / 查词是否思考。key 传空串 = 清除(回退环境变量的 secret),不传 = 不动。
api.post("/ai/settings", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    provider?: string;
    model?: string;
    openai_api_key?: string;
    deepseek_api_key?: string;
    word_thinking?: boolean;
  }>();
  const row = await loadAiSettings(c.env, userId);
  if (body.provider !== undefined && !isProviderChoice(body.provider)) {
    return c.json({ error: "未知的 provider" }, 400);
  }
  if (body.word_thinking !== undefined && typeof body.word_thinking !== "boolean") {
    return c.json({ error: "word_thinking 必须是布尔值" }, 400);
  }
  const target = isProviderChoice(body.provider) ? body.provider : activeChoice(row);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.provider !== undefined) {
    sets.push("ai_provider = ?");
    vals.push(target);
  }
  // 模型记在这家自己的列上:换提供商(含切到 random)不会弄丢已选的模型
  if (body.model !== undefined) {
    if (target === RANDOM_PROVIDER) {
      return c.json({ error: "随机模式下抽到哪家就用哪家已选的模型,不能在这里指定模型" }, 400);
    }
    if (!(await providerModels(c.env, row, target)).includes(body.model)) {
      return c.json({ error: `${PROVIDERS[target].label} 不支持模型 ${body.model}` }, 400);
    }
    sets.push(`${modelColumn(target)} = ?`);
    vals.push(body.model);
  }
  if (body.word_thinking !== undefined) {
    sets.push("ai_word_thinking = ?");
    vals.push(body.word_thinking ? 1 : 0);
  }
  for (const id of PROVIDER_IDS) {
    const raw = id === "deepseek" ? body.deepseek_api_key : body.openai_api_key;
    if (raw === undefined) continue;
    sets.push(`${id === "deepseek" ? "deepseek_api_key" : "openai_api_key"} = ?`);
    vals.push(raw.trim() || null);
  }
  if (sets.length) {
    vals.push(userId);
    await withAiSchema(c.env, () =>
      c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run()
    );
  }
  return c.json({ ok: true });
});

// 连接自检:用这家当前生效的 key/模型真发一条最短请求,把失败原因原样带回页面。
// 平时调用失败会静默回退 Workers AI → mock,原因只留在 Worker 日志里,
// 页面上只能看到「AI 好像没用我选的这家」,查不出到底是 key 错了还是余额不足。
api.post("/ai/test", async (c) => {
  const body = await c.req.json<{ provider?: string }>().catch(() => ({}) as { provider?: string });
  if (!isProviderId(body.provider)) return c.json({ error: "未知的 provider" }, 400);
  const provider = body.provider;
  const row = await loadAiSettings(c.env, c.get("userId"));
  const cfg = providerConfig(c.env, row, provider);
  if (!cfg) {
    const noKey: AiProviderTest = {
      provider,
      model: envModel(c.env, provider),
      ok: false,
      latency_ms: 0,
      error: `${PROVIDERS[provider].label} 还没有 API key(设置页填一个,或部署时配 secret)`,
    };
    return c.json(noKey);
  }
  const t0 = Date.now();
  const error = await openaiProbe(cfg);
  const result: AiProviderTest = {
    provider: cfg.provider,
    model: cfg.model,
    ok: error === null,
    latency_ms: Date.now() - t0,
    error,
  };
  return c.json(result);
});

// ---------- AI 调用延迟统计(提供商对比)----------

function summarize(rows: { latency_ms: number; ok: number; created_at: number }[]): Omit<AiLatencyGroup, "provider" | "model" | "kind"> {
  const sorted = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    calls: rows.length,
    ok_calls: rows.filter((r) => r.ok === 1).length,
    avg_ms: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
    last_at: Math.max(...rows.map((r) => r.created_at)),
  };
}

api.get("/ai/stats", async (c) => {
  const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 30) || 30));
  // 行数不多(一次调用一行),直接取回来在 JS 里算分位数:SQLite 没有 percentile 函数
  const { results } = await withAiSchema(c.env, () =>
    c.env.DB.prepare(
      `SELECT provider, model, kind, latency_ms, ok, stream, created_at FROM ai_calls
       WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 5000`
    )
      .bind(c.get("userId"), now() - days * 24 * 3600 * 1000)
      .all<AiCallLog>()
  );

  const group = (keyOf: (r: AiCallLog) => string) => {
    const buckets = new Map<string, AiCallLog[]>();
    for (const r of results) {
      const k = keyOf(r);
      const list = buckets.get(k);
      if (list) list.push(r);
      else buckets.set(k, [r]);
    }
    return [...buckets.values()];
  };

  const byModel: AiLatencyGroup[] = group((r) => `${r.provider}|${r.model}`)
    .map((rows) => ({ provider: rows[0].provider, model: rows[0].model, kind: "all" as const, ...summarize(rows) }))
    .sort((a, b) => b.calls - a.calls);
  const byKind: AiLatencyGroup[] = group((r) => `${r.provider}|${r.model}|${r.kind}`)
    .map((rows) => ({
      provider: rows[0].provider,
      model: rows[0].model,
      kind: rows[0].kind as AiCallKind,
      ...summarize(rows),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.avg_ms - b.avg_ms : a.kind < b.kind ? -1 : 1));

  const body: AiStats = { days, total_calls: results.length, by_model: byModel, by_kind: byKind, recent: results.slice(0, 20) };
  return c.json(body);
});

// ---------- 云端 TTS / STT ----------

api.get("/tts", async (c) => {
  const text = (c.req.query("text") ?? "").slice(0, 800);
  if (!text.trim()) return c.json({ error: "缺少文本" }, 400);
  const accent = c.req.query("accent") === "GB" ? "GB" : "US";
  const headers = { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" };

  // R2 持久缓存:同一 (口音, 文本) 的音频全局复用,省 ElevenLabs 配额且 ~50ms 返回
  const key = `tts/${accent}${voiceTag(c.env, accent)}/${await sha256Hex(text.trim().replace(/\s+/g, " ").toLowerCase())}.mp3`;
  const cached = await c.env.BUCKET.get(key);
  if (cached) return new Response(cached.body, { headers });

  // 优先 ElevenLabs(eleven_v3)→ 回退 Workers AI melotts
  const eleven = await elevenTts(c.env, text, accent);
  if (eleven) {
    // 只缓存 ElevenLabs 结果;melotts 兜底不缓存,恢复后自动升级音质
    c.executionCtx.waitUntil(
      c.env.BUCKET.put(key, eleven, { httpMetadata: { contentType: "audio/mpeg" } }).catch((e) =>
        console.warn("TTS 缓存写入失败:", (e as Error).message)
      )
    );
    return new Response(eleven as unknown as BodyInit, { headers });
  }
  const audio = await ttsAudio(c.env, text);
  if (!audio) return c.json({ error: "TTS 不可用" }, 503);
  return new Response(audio as unknown as BodyInit, { headers });
});

api.post("/speech/stt", async (c) => {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > 10 * 1024 * 1024) return c.json({ error: "音频无效" }, 400);
  const text = await transcribeAudio(c.env, buf);
  if (text === null) return c.json({ error: "转写服务不可用" }, 503);
  return c.json({ text });
});

// ---------- 扫描版 OCR ----------

api.post("/books/:id/pages/:no/ocr", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const pageNo = Number(c.req.param("no"));
  const image = await c.req.arrayBuffer();
  if (image.byteLength === 0 || image.byteLength > 4 * 1024 * 1024) return c.json({ error: "图片无效(上限 4MB)" }, 400);
  const text = await ocrImage(c.env, image);
  if (text === null) return c.json({ error: "OCR 服务不可用" }, 503);
  await c.env.DB.prepare(
    "INSERT INTO pages (book_id, page_no, text) VALUES (?, ?, ?) ON CONFLICT(book_id, page_no) DO UPDATE SET text = excluded.text, analysis_json = NULL"
  )
    .bind(book.id, pageNo, text.slice(0, 40000))
    .run();
  c.executionCtx.waitUntil(indexBookPages(c.env, book.id, [{ page_no: pageNo, text }]));
  return c.json({ text });
});

// 全文搜索(SQL LIKE,MVP 够用;后续可换 FTS5/Vectorize)
api.get("/books/:id/search", async (c) => {
  const book = await getBook(c, c.get("userId"), c.req.param("id"));
  if (!book) return c.json({ error: "not found" }, 404);
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json([]);
  const { results } = await c.env.DB.prepare(
    "SELECT page_no, text FROM pages WHERE book_id = ? AND text LIKE ? ORDER BY page_no LIMIT 50"
  )
    .bind(book.id, `%${q}%`)
    .all<{ page_no: number; text: string }>();
  const out = results.map((r) => {
    const idx = r.text.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, idx - 60);
    const snippet = r.text.slice(start, idx + q.length + 60).replace(/\s+/g, " ");
    return { page_no: r.page_no, snippet: (start > 0 ? "…" : "") + snippet + "…" };
  });
  return c.json(out);
});

// ---------- 阅读进度 ----------

api.get("/books/:id/progress", async (c) => {
  const row = await c.env.DB.prepare("SELECT page_no, zoom FROM reading_progress WHERE user_id = ? AND book_id = ?")
    .bind(c.get("userId"), c.req.param("id"))
    .first();
  return c.json(row ?? { page_no: 1, zoom: null });
});

api.put("/books/:id/progress", async (c) => {
  const body = await c.req.json<{ page_no: number; zoom?: number }>();
  await c.env.DB.prepare(
    `INSERT INTO reading_progress (user_id, book_id, page_no, zoom, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, book_id) DO UPDATE SET page_no = excluded.page_no, zoom = excluded.zoom, updated_at = excluded.updated_at`
  )
    .bind(c.get("userId"), c.req.param("id"), body.page_no ?? 1, body.zoom ?? 1.0, now())
    .run();
  void logActivity(c.env, c.get("userId"), "page_view", c.req.param("id"), body.page_no ?? 1);
  return c.json({ ok: true });
});

// ---------- 单词解释 ----------

api.post("/ai/explain-word", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ word: string; sentence: string; book_id?: string; page_no?: number }>();
  if (!body.word) return c.json({ error: "缺少单词" }, 400);
  const user = await c.env.DB.prepare("SELECT english_level FROM users WHERE id = ?")
    .bind(userId)
    .first<{ english_level: string }>();
  const level = user?.english_level ?? "intermediate";

  // 点击行为(词汇模型观测)与活动日志照常记录,不阻塞响应
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "INSERT INTO word_events (user_id, word, action, book_id, page_no, created_at) VALUES (?, ?, 'click', ?, ?, ?)"
    )
      .bind(userId, body.word.toLowerCase(), body.book_id ?? null, body.page_no ?? null, now())
      .run()
      .catch((e) => console.warn("word_events 记录失败:", (e as Error).message))
  );
  void logActivity(c.env, userId, "lookup", body.book_id ?? null, body.page_no ?? null);

  // 缓存:同一 (单词, 原句, 水平) 直接复用,重复查询免 AI 调用
  const cacheWord = body.word.trim().toLowerCase();
  const sentenceNorm = (body.sentence ?? "").trim().replace(/\s+/g, " ");
  const sentenceHash = sentenceNorm ? fnv1aHex(sentenceNorm) : "-";
  const cached = await c.env.DB.prepare(
    "SELECT explanation_json FROM word_exp_cache WHERE word = ? AND sentence_hash = ? AND level = ?"
  )
    .bind(cacheWord, sentenceHash, level)
    .first<{ explanation_json: string }>();
  if (cached) {
    try {
      return c.json(JSON.parse(cached.explanation_json));
    } catch {
      /* 缓存损坏则重新生成 */
    }
  }

  const exp = await explainWord(c.env, userId, body.word, body.sentence ?? "", level);
  if (exp.source !== "mock") {
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        `INSERT INTO word_exp_cache (word, sentence_hash, level, explanation_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(word, sentence_hash, level) DO UPDATE SET explanation_json = excluded.explanation_json, created_at = excluded.created_at`
      )
        .bind(cacheWord, sentenceHash, level, JSON.stringify(exp), now())
        .run()
        .catch((e) => console.warn("查词缓存写入失败:", (e as Error).message))
    );
  }
  return c.json(exp);
});

// ---------- 生词本 ----------

api.get("/vocab", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM vocab WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500"
  )
    .bind(c.get("userId"))
    .all();
  return c.json(results);
});

api.post("/vocab", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    word: string;
    context_sentence?: string;
    book_id?: string;
    page_no?: number;
    explanation?: unknown;
    status?: string;
  }>();
  if (!body.word) return c.json({ error: "缺少单词" }, 400);
  const normalized = body.word.trim().toLowerCase();
  const id = uid("v");
  const status = ["learning", "known", "review"].includes(body.status ?? "") ? body.status : "learning";
  await c.env.DB.prepare(
    `INSERT INTO vocab (id, user_id, word, normalized, context_sentence, book_id, page_no, explanation_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, normalized) DO UPDATE SET
       context_sentence = COALESCE(excluded.context_sentence, vocab.context_sentence),
       explanation_json = COALESCE(excluded.explanation_json, vocab.explanation_json),
       status = excluded.status,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      userId,
      body.word.trim(),
      normalized,
      body.context_sentence ?? null,
      body.book_id ?? null,
      body.page_no ?? null,
      body.explanation ? JSON.stringify(body.explanation) : null,
      status,
      now(),
      now()
    )
    .run();
  await c.env.DB.prepare(
    "INSERT INTO word_events (user_id, word, action, book_id, page_no, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(userId, normalized, status === "known" ? "known" : "save", body.book_id ?? null, body.page_no ?? null, now())
    .run();
  void logActivity(c.env, userId, "vocab_add", body.book_id ?? null, body.page_no ?? null);
  const item = await c.env.DB.prepare("SELECT * FROM vocab WHERE user_id = ? AND normalized = ?")
    .bind(userId, normalized)
    .first();
  return c.json(item);
});

api.patch("/vocab/:id", async (c) => {
  const body = await c.req.json<{ status?: string }>();
  if (!body.status || !["learning", "known", "review"].includes(body.status)) {
    return c.json({ error: "bad status" }, 400);
  }
  await c.env.DB.prepare("UPDATE vocab SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(body.status, now(), c.req.param("id"), c.get("userId"))
    .run();
  return c.json({ ok: true });
});

api.delete("/vocab/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM vocab WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  return c.json({ ok: true });
});

// 「这个词我认识」:降低后续提示
api.post("/word-events", async (c) => {
  const body = await c.req.json<{ word: string; action: string; book_id?: string; page_no?: number }>();
  if (!body.word || !["click", "save", "known", "unknown"].includes(body.action)) {
    return c.json({ error: "bad payload" }, 400);
  }
  await c.env.DB.prepare(
    "INSERT INTO word_events (user_id, word, action, book_id, page_no, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(c.get("userId"), body.word.toLowerCase(), body.action, body.book_id ?? null, body.page_no ?? null, now())
    .run();
  return c.json({ ok: true });
});

// 用户已标记"认识"的词(阅读页用来过滤生词提示)
api.get("/known-words", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT word FROM word_events WHERE user_id = ? AND action = 'known'
     UNION SELECT normalized FROM vocab WHERE user_id = ? AND status = 'known'`
  )
    .bind(c.get("userId"), c.get("userId"))
    .all<{ word: string }>();
  return c.json(results.map((r) => r.word));
});

// ---------- AI 聊天(SSE 流式) ----------

api.get("/books/:id/chat", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, role, content, refs_json, created_at FROM chat_messages WHERE user_id = ? AND book_id = ? ORDER BY created_at ASC LIMIT 200"
  )
    .bind(c.get("userId"), c.req.param("id"))
    .all();
  return c.json(results);
});

api.delete("/books/:id/chat", async (c) => {
  await c.env.DB.prepare("DELETE FROM chat_messages WHERE user_id = ? AND book_id = ?")
    .bind(c.get("userId"), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

api.post("/ai/chat", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{
    book_id: string;
    page_no: number;
    scope: ChatScope;
    selection?: string;
    message: string;
  }>();
  const book = await getBook(c, userId, body.book_id);
  if (!book) return c.json({ error: "not found" }, 404);
  if (!body.message?.trim()) return c.json({ error: "缺少内容" }, 400);

  // 组装上下文
  const contextParts: string[] = [];
  const pageRow = await c.env.DB.prepare("SELECT text FROM pages WHERE book_id = ? AND page_no = ?")
    .bind(book.id, body.page_no)
    .first<{ text: string }>();
  if (body.scope === "selection" && body.selection) {
    contextParts.push(`【用户选中的原文(第 ${body.page_no} 页)】\n${body.selection.slice(0, 2000)}`);
    if (pageRow?.text) contextParts.push(`【第 ${body.page_no} 页全文(供参考)】\n${pageRow.text.slice(0, 3000)}`);
  } else if (body.scope === "document") {
    if (pageRow?.text) contextParts.push(`【当前第 ${body.page_no} 页】\n${pageRow.text.slice(0, 2500)}`);
    let retrievedPages: number[] = [];
    // 优先 Vectorize 向量检索(支持中文提问查英文原文)
    if (c.env.VECTORIZE) {
      const qVec = await embedTexts(c.env, [body.message]);
      if (qVec) {
        try {
          const matches = await c.env.VECTORIZE.query(qVec[0], {
            topK: 4,
            filter: { book_id: book.id },
            returnMetadata: "all",
          });
          retrievedPages = matches.matches
            .filter((m) => m.score > 0.3)
            .map((m) => Number(m.metadata?.page_no))
            .filter((p) => Number.isFinite(p));
        } catch (e) {
          console.warn("Vectorize 查询失败,回退关键词:", (e as Error).message);
        }
      }
    }
    if (retrievedPages.length === 0) {
      // 回退:关键词重合度检索
      const qWords = new Set(tokenizeWords(body.message));
      const { results: allPages } = await c.env.DB.prepare(
        "SELECT page_no, text FROM pages WHERE book_id = ? AND length(text) > 50"
      )
        .bind(book.id)
        .all<{ page_no: number; text: string }>();
      retrievedPages = allPages
        .map((p) => {
          const words = tokenizeWords(p.text);
          let score = 0;
          for (const w of words) if (qWords.has(w) && w.length > 3) score++;
          return { page_no: p.page_no, score };
        })
        .filter((p) => p.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((p) => p.page_no);
    }
    for (const pn of retrievedPages) {
      if (pn === body.page_no) continue;
      const row = await c.env.DB.prepare("SELECT text FROM pages WHERE book_id = ? AND page_no = ?")
        .bind(book.id, pn)
        .first<{ text: string }>();
      if (row?.text) contextParts.push(`【第 ${pn} 页(检索相关)】\n${row.text.slice(0, 2000)}`);
    }
  } else {
    if (pageRow?.text) contextParts.push(`【当前第 ${body.page_no} 页】\n${pageRow.text.slice(0, 4000)}`);
  }

  const system = `你是一名沉浸式英语阅读助手,帮助中文母语用户深入理解英文原著《${book.title}》。用户当前在第 ${body.page_no} 页。
规则:
1. 用中文回答(涉及英文原文时引用英文并解释)。
2. 回答要具体、结合提供的原文上下文,不要泛泛而谈。
3. 引用原文时必须标注页码,格式严格为 [p.页码],例如 [p.${body.page_no}]。用户可以点击页码跳回原文。
4. 若上下文不足以回答,坦率说明,并建议用户切换提问范围。
以下是可用的原文上下文:
${contextParts.join("\n\n") || "(本页暂无文本)"}`;

  // 最近历史
  const { results: history } = await c.env.DB.prepare(
    "SELECT role, content FROM chat_messages WHERE user_id = ? AND book_id = ? ORDER BY created_at DESC LIMIT 10"
  )
    .bind(userId, book.id)
    .all<{ role: "user" | "assistant"; content: string }>();
  history.reverse();

  const userMsgId = uid("m");
  await c.env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, book_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)"
  )
    .bind(userMsgId, userId, book.id, body.message, now())
    .run();

  void logActivity(c.env, userId, "chat", book.id, body.page_no);
  const messages = [
    { role: "system" as const, content: system },
    ...history.map((h) => ({ role: h.role, content: h.content.slice(0, 2000) })),
    { role: "user" as const, content: body.message },
  ];

  const { stream, source } = await chatStream(c.env, userId, messages);

  const encoder = new TextEncoder();
  const db = c.env.DB;
  const bookId = book.id;
  let full = "";
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ start: true, source })}\n\n`));
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          full += value;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: value })}\n\n`));
        }
        // 提取引用页码
        const refs = [...new Set([...full.matchAll(/\[p\.?\s*(\d+)\]/gi)].map((m) => Number(m[1])))];
        const asstId = uid("m");
        await db
          .prepare(
            "INSERT INTO chat_messages (id, user_id, book_id, role, content, refs_json, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)"
          )
          .bind(asstId, userId, bookId, full, JSON.stringify(refs.map((p) => ({ page: p }))), now())
          .run();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, refs })}\n\n`));
      } catch (e) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: (e as Error).message })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ---------- Telegram 每日推送设置(需登录) ----------

api.get("/telegram/status", async (c) => {
  const user = await c.env.DB.prepare(
    "SELECT telegram_chat_id, tg_daily_enabled, tg_daily_hour FROM users WHERE id = ?"
  )
    .bind(c.get("userId"))
    .first<{ telegram_chat_id: string | null; tg_daily_enabled: number; tg_daily_hour: number }>();
  return c.json({
    available: telegramEnabled(c.env),
    linked: Boolean(user?.telegram_chat_id),
    daily_enabled: (user?.tg_daily_enabled ?? 0) === 1,
    daily_hour: user?.tg_daily_hour ?? 8,
  });
});

api.post("/telegram/settings", async (c) => {
  const body = await c.req.json<{ daily_enabled?: boolean; daily_hour?: number }>();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.daily_enabled !== undefined) {
    sets.push("tg_daily_enabled = ?");
    vals.push(body.daily_enabled ? 1 : 0);
  }
  if (body.daily_hour !== undefined && body.daily_hour >= 0 && body.daily_hour <= 23) {
    sets.push("tg_daily_hour = ?");
    vals.push(Math.floor(body.daily_hour));
  }
  if (sets.length) {
    vals.push(c.get("userId"));
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  }
  return c.json({ ok: true });
});

// ---------- 笔记 ----------

api.post("/notes", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ book_id?: string; page_no?: number; quote?: string; note: string }>();
  if (!body.note?.trim()) return c.json({ error: "笔记内容为空" }, 400);
  const id = uid("nt");
  await c.env.DB.prepare(
    "INSERT INTO notes (id, user_id, book_id, page_no, quote, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, userId, body.book_id ?? null, body.page_no ?? null, body.quote?.slice(0, 800) ?? null, body.note.slice(0, 4000), now())
    .run();
  void logActivity(c.env, userId, "note", body.book_id ?? null, body.page_no ?? null);
  return c.json({ id, ok: true });
});

api.get("/notes", async (c) => {
  const bookId = c.req.query("book_id");
  const rows = bookId
    ? await c.env.DB.prepare("SELECT * FROM notes WHERE user_id = ? AND book_id = ? ORDER BY created_at DESC")
        .bind(c.get("userId"), bookId)
        .all()
    : await c.env.DB.prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 200")
        .bind(c.get("userId"))
        .all();
  return c.json(rows.results);
});

api.delete("/notes/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  return c.json({ ok: true });
});

// ---------- 阅读计时会话 ----------

api.post("/reading-sessions", async (c) => {
  const body = await c.req.json<{ book_id: string }>();
  if (!body.book_id) return c.json({ error: "缺少 book_id" }, 400);
  const id = uid("rs");
  await c.env.DB.prepare(
    "INSERT INTO reading_sessions (id, user_id, book_id, started_at, ended_at, active_ms, idle_ms) VALUES (?, ?, ?, ?, ?, 0, 0)"
  )
    .bind(id, c.get("userId"), body.book_id, now(), now())
    .run();
  return c.json({ id });
});

api.patch("/reading-sessions/:id", async (c) => {
  const body: { active_ms?: number; idle_ms?: number; pauses?: number } = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare(
    "UPDATE reading_sessions SET active_ms = ?, idle_ms = ?, pauses = ?, ended_at = ? WHERE id = ? AND user_id = ?"
  )
    .bind(
      Math.max(0, Math.floor(body.active_ms ?? 0)),
      Math.max(0, Math.floor(body.idle_ms ?? 0)),
      Math.max(0, Math.floor(body.pauses ?? 0)),
      now(),
      c.req.param("id"),
      c.get("userId")
    )
    .run();
  return c.json({ ok: true });
});

// 今天(用户本地日)已读总时长 + 当日目标,供阅读页的专注提醒用。
// exclude=<session id>:排除正在进行的这次会话,调用方自己把还没落库的实时时长加上,
// 这样卡片上的数字不依赖心跳是否刚好落过库。
// 会话整段归它开始的那天(见 sessionDayKey),所以跨午夜时本次会话的实时时长可能不属于今天,
// live_counts_today 告诉前端该不该把它加上 —— 不然提醒和日历/统计会对不上。
api.get("/reading-today", async (c) => {
  const userId = c.get("userId");
  const tzoff = Number(c.req.query("tzoff") ?? 0); // 分钟(getTimezoneOffset)
  const dayStart = localDayStart(now(), tzoff);
  const excludeId = c.req.query("exclude") ?? "";
  const row = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(active_ms), 0) AS ms FROM reading_sessions WHERE user_id = ? AND started_at >= ? AND id <> ?"
  )
    .bind(userId, dayStart, excludeId)
    .first<{ ms: number }>();
  let liveCountsToday = true; // 没传 exclude(或那条会话查不到)时维持旧行为:实时时长算今天
  if (excludeId) {
    const live = await c.env.DB.prepare("SELECT started_at FROM reading_sessions WHERE id = ? AND user_id = ?")
      .bind(excludeId, userId)
      .first<{ started_at: number }>();
    if (live) liveCountsToday = live.started_at >= dayStart;
  }
  const body: ReadingToday = { ms: row?.ms ?? 0, goal_ms: DAILY_GOAL_MS, live_counts_today: liveCountsToday };
  return c.json(body);
});

// ---------- 日历回顾:按本地日聚合 书 / 词 / 笔记 ----------

api.get("/calendar", async (c) => {
  const userId = c.get("userId");
  const start = Number(c.req.query("start") ?? 0);
  const end = Number(c.req.query("end") ?? now());
  const tzoff = Number(c.req.query("tzoff") ?? 0); // 分钟(getTimezoneOffset)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return c.json({ error: "bad range" }, 400);
  const localDay = (ts: number) => localDayKey(ts, tzoff);

  // 阅读的书(按天去重)
  const { results: reads } = await c.env.DB.prepare(
    `SELECT DISTINCT a.book_id, b.title, a.created_at FROM activity a JOIN books b ON b.id = a.book_id
     WHERE a.user_id = ? AND a.kind = 'page_view' AND a.created_at BETWEEN ? AND ?`
  )
    .bind(userId, start, end)
    .all<{ book_id: string; title: string; created_at: number }>();

  // 收藏/查过的词与短语
  const { results: words } = await c.env.DB.prepare(
    `SELECT word, explanation_json, context_sentence, created_at FROM vocab
     WHERE user_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at`
  )
    .bind(userId, start, end)
    .all<{ word: string; explanation_json: string | null; context_sentence: string | null; created_at: number }>();

  // 笔记
  const { results: notes } = await c.env.DB.prepare(
    `SELECT note, quote, book_id, page_no, created_at FROM notes
     WHERE user_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at`
  )
    .bind(userId, start, end)
    .all<{ note: string; quote: string | null; book_id: string | null; page_no: number | null; created_at: number }>();

  // 阅读时长 + 会话明细(起止/时长/中断)
  const { results: sessions } = await c.env.DB.prepare(
    `SELECT s.book_id, b.title AS book_title, s.active_ms, s.pauses, s.started_at, s.ended_at
     FROM reading_sessions s LEFT JOIN books b ON b.id = s.book_id
     WHERE s.user_id = ? AND s.started_at BETWEEN ? AND ? ORDER BY s.started_at`
  )
    .bind(userId, start, end)
    .all<{ book_id: string; book_title: string | null; active_ms: number; pauses: number; started_at: number; ended_at: number | null }>();

  const days: Record<string, { read_ms: number; books: { id: string; title: string }[]; words: { word: string; meaning: string; sentence: string | null }[]; notes: { note: string; quote: string | null; page_no: number | null }[]; sessions: { book_id: string; book_title: string | null; started_at: number; ended_at: number | null; active_ms: number; pauses: number }[] }> = {};
  const dayBucket = (key: string) => (days[key] ??= { read_ms: 0, books: [], words: [], notes: [], sessions: [] });
  const dayOf = (ts: number) => dayBucket(localDay(ts));

  for (const r of reads) {
    const d = dayOf(r.created_at);
    if (!d.books.some((b) => b.id === r.book_id)) d.books.push({ id: r.book_id, title: r.title });
  }
  for (const w of words) {
    let meaning = "";
    if (w.explanation_json) {
      try {
        meaning = (JSON.parse(w.explanation_json) as { meaning_zh?: string }).meaning_zh ?? "";
      } catch {
        /* ignore */
      }
    }
    dayOf(w.created_at).words.push({ word: w.word, meaning, sentence: w.context_sentence });
  }
  for (const n of notes) {
    dayOf(n.created_at).notes.push({ note: n.note, quote: n.quote, page_no: n.page_no });
  }
  for (const s of sessions) {
    // 整段归会话开始的那天,和 /stats、/reading-today 一致
    const d = dayBucket(sessionDayKey(s, tzoff));
    d.read_ms += s.active_ms;
    // 过短的会话(打开即离开)不进明细,只计入总时长
    if (s.active_ms >= 30_000) {
      d.sessions.push({
        book_id: s.book_id,
        book_title: s.book_title,
        started_at: s.started_at,
        ended_at: s.ended_at,
        active_ms: s.active_ms,
        pauses: s.pauses,
      });
    }
  }

  return c.json({ days });
});

app.route("/api", api);

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Cron:每小时触发,按用户设定的 UTC 小时推送每日复习提醒
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDailyPush(env));
  },
} satisfies ExportedHandler<Env>;
