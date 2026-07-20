// 端到端自测脚本:登录 → 上传 → 阅读 → 查词 → 解析 → 聊天 → 收藏 → 朗读栏
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5173";
const PDF = process.env.TEST_PDF;
const OUT = process.env.SHOT_DIR || "e2e-shots";
const WORD = process.env.TEST_WORD || "skiff";
const SEARCH = process.env.TEST_SEARCH || "harpoon";
const email = process.env.TEST_EMAIL || `e2e+${Date.now()}@test.com`;

const results = [];
function ok(name) {
  results.push(["✅", name]);
  console.log("✅", name);
}
function fail(name, err) {
  results.push(["❌", name + " — " + err]);
  console.log("❌", name, "—", err);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200));
});

const shot = (name) => page.screenshot({ path: path.join(OUT, name + ".png") });

try {
  // 1. 登录
  await page.goto(BASE);
  await page.waitForSelector(".login-card", { timeout: 10000 });
  await page.fill('input[type="email"]', email);
  await page.click("text=Sign in / Sign up");
  await page.waitForSelector(".lib-toolbar", { timeout: 10000 });
  ok("dev 登录进入书库");
  await shot("01-library-empty");

  // 2. 上传 PDF
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("text=Upload PDF")]);
  await chooser.setFiles(PDF);
  await page.waitForSelector(".book-card", { timeout: 30000 });
  ok("上传 PDF 并出现书卡片");
  await shot("02-library-book");

  // 2b. 上传时生成封面
  await page.waitForSelector(".book-cover-img", { timeout: 20000 });
  ok("上传后自动生成封面");

  // 2c. 编辑:改书名 + 重新生成封面
  await page.hover(".book-card");
  await page.click(".book-edit");
  await page.waitForSelector(".book-edit-modal", { timeout: 5000 });
  const newTitle = "E2E Renamed Book";
  await page.fill(".edit-title-input", newTitle);
  const oldSrc = await page.getAttribute(".edit-cover img", "src");
  await page.click(".book-edit-modal >> text=Regenerate cover");
  await page.waitForFunction(
    (old) => {
      const img = document.querySelector(".edit-cover img");
      return !!img && img.getAttribute("src") !== old;
    },
    oldSrc,
    { timeout: 30000 }
  );
  ok("重新生成封面(封面已更新)");
  await page.click(".book-edit-modal .btn-primary");
  await page.waitForSelector(".book-edit-modal", { state: "detached", timeout: 5000 });
  await page.waitForFunction(
    (t) => document.querySelector(".book-title")?.textContent?.includes(t),
    newTitle,
    { timeout: 8000 }
  );
  ok("编辑书名生效");
  await shot("02c-edit-book");

  // 3. 打开阅读器
  await page.click(".book-card");
  await page.waitForSelector(".pdf-page-wrap canvas", { timeout: 20000 });
  await page.waitForSelector(".textLayer .w", { timeout: 20000 });
  ok("阅读器渲染 PDF + 文本层单词");
  await shot("03-reader");

  // 4. 点击单词 → 弹窗
  const word = page.locator(".textLayer .w", { hasText: new RegExp(`^${WORD}$`) }).first();
  await word.click();
  await page.waitForSelector(".word-popover", { timeout: 10000 });
  await page.waitForSelector(".word-popover .wp-body", { timeout: 15000 });
  const popText = await page.locator(".word-popover").innerText();
  if (!popText.includes(WORD)) throw new Error("弹窗中没有单词");
  ok("单词点击弹出语境解释");
  await shot("04-word-popover");

  // 5. 收藏单词
  await page.click(".word-popover >> text=Save");
  await page.waitForSelector(".word-popover >> text=Saved", { timeout: 10000 });
  ok("收藏单词");
  await page.click(".word-popover .wp-close");

  // 6. 本页解析
  await page.click(".analysis-empty button");
  await page.waitForSelector(".ana-section", { timeout: 30000 });
  ok("生成本页解析");
  await shot("05-analysis");

  // 7. 生词轻量标记(解析后 hint 下划线)
  const hintCount = await page.locator(".textLayer .w.hint").count();
  if (hintCount > 0) ok(`生词轻量标记 (${hintCount} 处)`);
  else fail("生词轻量标记", "没有出现 hint 标记");

  // 8. AI 聊天(流式 + 引用跳转)
  await page.click(".tab >> text=AI Chat");
  await page.fill(".chat-input-row textarea", "Summarize this page");
  await page.click(".chat-input-row .btn-primary");
  await page.waitForSelector(".chat-msg.assistant .chat-bubble", { timeout: 20000 });
  await page.waitForFunction(
    () => !document.querySelector(".cursor-blink"),
    { timeout: 30000 }
  );
  const reply = await page.locator(".chat-msg.assistant .chat-bubble").last().innerText();
  if (reply.length < 10) throw new Error("回复过短");
  ok("AI 聊天流式回复");
  await shot("06-chat");

  const refBtn = page.locator(".chat-msg.assistant .page-ref").first();
  if ((await refBtn.count()) > 0) {
    await refBtn.click();
    ok("回答中的页码引用可点击");
  } else {
    fail("页码引用", "回复中没有 [p.N] 引用按钮");
  }

  // 9. 学习记录:生词出现
  await page.click(".tab >> text=Learning");
  await page.waitForSelector(".vocab-item", { timeout: 10000 });
  const vocabText = await page.locator(".tab-content:visible").innerText();
  if (!vocabText.toLowerCase().includes(WORD.toLowerCase())) throw new Error("生词本中没有 " + WORD);
  ok("学习记录展示收藏的生词");
  await shot("07-vocab");

  // 10. 朗读栏
  await page.click("text=Read aloud");
  await page.waitForSelector(".tts-bar", { timeout: 10000 });
  ok("朗读栏出现");
  await shot("08-tts-bar");

  // 11. 翻页 + 进度保存
  await page.click(".reader-nav .icon-btn:last-child");
  await page.waitForTimeout(1500);
  const pageVal = await page.inputValue(".page-input");
  if (pageVal !== "2") throw new Error("页码没有变成 2,而是 " + pageVal);
  ok("翻页到第 2 页");
  await shot("09-page2");

  // 12. 全文搜索
  await page.fill(".reader-search input", SEARCH);
  await page.press(".reader-search input", "Enter");
  await page.waitForSelector(".search-result", { timeout: 10000 });
  ok("全文搜索出结果");
  await shot("10-search");

  // 13. 回书库,进度显示
  await page.click(".reader-header >> text=Library");
  await page.waitForSelector(".book-card", { timeout: 10000 });
  const meta = await page.locator(".book-meta").innerText();
  if (!meta.includes("on page")) fail("书库显示进度", "meta=" + meta);
  else ok("书库显示阅读进度");
  await shot("11-library-progress");

  // 14. 学习报告面板(二期)
  await page.waitForSelector(".stats-panel .stat-tile", { timeout: 10000 });
  const tiles = await page.locator(".stat-tile").count();
  const bars = await page.locator(".bar-chart .bar-col").count();
  if (tiles >= 4 && bars >= 28) ok(`学习报告(${tiles} 个指标卡,${bars} 天活动图)`);
  else fail("学习报告", `tiles=${tiles}, bars=${bars}`);
  await shot("12-stats");

  // 15. 生词复习闪卡(二期,之前收藏过 1 个词)
  await page.click("text=Review");
  await page.waitForSelector(".review-modal", { timeout: 10000 });
  await page.waitForSelector(".review-word", { timeout: 10000 });
  await page.click("text=Show answer");
  await page.waitForSelector(".review-grades", { timeout: 5000 });
  const answerText = await page.locator(".review-answer .review-meaning").innerText();
  if (answerText.trim().length > 0 && !answerText.includes("no definition")) ok("复习卡展示完整查词释义");
  else fail("复习卡释义", "answer=" + answerText);
  await page.click(".review-grade.g-good");
  await page.waitForSelector(".review-done", { timeout: 10000 });
  ok("复习闪卡完整流程(出题→答案→评分→完成)");
  await shot("13-review");
  await page.click(".review-modal >> text=Done");
} catch (e) {
  fail("流程中断", e.message);
  await shot("99-error");
} finally {
  await browser.close();
}

const failed = results.filter(([s]) => s === "❌").length;
console.log(`\n=== E2E 结果: ${results.length - failed}/${results.length} 通过 ===`);
process.exit(failed ? 1 : 0);
