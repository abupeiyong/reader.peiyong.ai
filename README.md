# 沉浸阅读 · Immersive Reader

面向英语学习者的 AI PDF 深度阅读工具。已上线 **https://reader.peiyong.ai**(Cloudflare Workers)。
学习闭环:阅读原文 → 理解重点 → 记录生词 → 听原文 → AI 对话深化理解。

## 功能

**阅读**
- Telegram 一次性随机码登录(个人站点,无 Google/密码):网页点「Send code」→ Bot 收码 → 输入 6 位码;
  也可直接给 Bot 发 `/login` 取码。码 5 分钟有效、一次性、网页发起的码绑定发起浏览器;
  只有站长的 chat 能取码(`TELEGRAM_OWNER_CHAT_ID`,留空则取库中唯一已绑定账号)
- PDF.js 阅读器:渲染、缩放、翻页、全文搜索、进度保存/恢复
- 章节目录(PDF outline + 启发式兜底),点击快速跳转
- 稳健文本层:点词/词旁间隙都能取词;`Util.transform` 正确坐标(处理 CropBox 偏移);
  为非嵌入字体配置标准字体数据;自动检测并优雅降级损坏的文本层
- 每段首行左侧的段落朗读按钮(基于首行缩进分段);朗读时句子同步高亮

**AI(OpenAI gpt-5-nano 或 DeepSeek,均走 OpenAI 兼容端点;不可用时回退 Workers AI → mock)**
- 设置页(`#/settings`)切换提供商与模型,并填 OpenAI / DeepSeek 的 API key
  (存在账号上,不回显明文;留空保存 = 清除并回退部署时的 secret)
  —— 可选模型不写死在代码里:两家都取自各自 `/models` 接口的实时清单(缓存 10 分钟,
  问不到时用内置清单;OpenAI 会滤掉语音/图像/嵌入这些不能对话的模型)
- 也可以选 Random:每次 AI 任务(查词 / 本页解析 / 对话)在填了 key 的提供商里随机挑一家,
  各家用自己那份已选模型(模型是按提供商分别记的,换来换去不会丢);Random 下设置页为每家各给一个模型下拉,
  改某家的模型不用先切过去再切回来;抽到谁都会记进 AI 统计页,可直接对比两家
- 每家 key 旁的 `Test` 按钮做连接自检:真发一条最短请求,把提供商返回的 HTTP 状态与
  错误原文显示出来(平时调用失败会静默回退 Workers AI → mock,看不出到底哪里不对);
  提供商返回 200 但内容为空(DeepSeek 的 JSON 模式偶发)同样算失败,照常回退并记为失败调用
- 查词的「思考」分四档(设置页 Word lookups → Thinking level:off / low / medium / high,默认 off):
  gpt-5 系列把档位直接当 `reasoning_effort`(off = 最低档),DeepSeek 只分思不思考 —— off 时把
  `deepseek-reasoner` 换成 `deepseek-chat`;只影响查词,本页解析与对话不变
- AI 统计页(`#/ai-stats`)按提供商/模型对比响应延迟(中位数/均值/p95;流式对话记首个 token 的延迟)
- 语境化查词:音标、词性、释义、语境含义、搭配、词形、例句 —— 全部保存供复习。
  这条链路上不读 D1:登录态验签名令牌(`worker/jwt.ts`),英语水平和 AI 设置按隔离实例缓存一周,
  解释不走缓存表每次现问;响应的 `Server-Timing` 里有 db / ai / total 分解
- 本页解析:生词、短语、长难句、背景知识
- 流式对话,范围可切(选中/本页/整本书),`[p.N]` 页码引用可点击跳回原文
- 整本书问答走 Vectorize(bge-m3,中文提问查英文原文)
- 语音提问(Whisper)、扫描页 OCR(视觉模型)

**词汇与复习**
- 个性化生词提示(google-10000 词频 + 行为模型)
- 生词按天分组,含所在句子 + 完整查词结果
- SM-2 间隔重复闪卡

**语音**
- 单词/逐句朗读用 ElevenLabs `eleven_v3`(melotts/浏览器兜底)
- 音频缓存在 R2(`tts/<口音>[-音色指纹]/<文本 sha256>.mp3`):同一句全局复用,
  命中约 10ms(未命中约 3-4s);换音色自动分桶,melotts 兜底结果不缓存

**音标(`#/phonetics`)**
- 元音按舌位画在元音图(梯形)上,双元音与辅音(爆破 / 摩擦 / 塞擦 / 鼻音 / 近音)分组列出
- 点音标出声并展开例词,点例词逐词朗读;英音 / 美音一键切换(两边元音表不同,辅音共用)
- 点音标放的是 Wikimedia Commons 上的 IPA 标准录音(真人发音,CC BY-SA 3.0,页面上署名),
  不走 TTS —— IPA 交给 TTS 会被逐字念成「slash i colon slash」,用「puh」这类拼法提示
  念出来的也不是那个音;录音按英语实际音值挑(`/ʌ/` 用央元音 [ɐ]、`/r/` 用齿后 [ɹ̠])
- 37 段录音已拉下来入库放在 `public/phonetics/`(共约 1.2 MB,随静态资源发布),
  运行时不再请求 upload.wikimedia.org;署名清单在 `public/phonetics/CREDITS.txt`。
  清单以 `src/lib/phonetics.ts` 里的文件名为准,补录音后跑 `npm run fetch:ipa` 同步
- 没有标准录音的(双元音、美音 `/ɝ/`)和录音取不到时,回退 TTS 念代表词;例词一直走 TTS

**笔记、日历与报告(My Library)**
- 每页记笔记(可基于选中文字)
- 阅读日历:每天读的书、查/收藏的词和短语、笔记、读书总时长
- 阅读计时:打开书开始、离开停止、2 分钟无操作暂停、有操作恢复
- 专注提醒:页面失焦或长时间没动作就提示今天已读多久、距当日目标还差多久,
  卡片同时用语音念出来,之后每 10 分钟再提醒一次(听朗读时不打扰)
- 每日阅读目标:默认 3 小时,可在设置页改(15 分钟 ~ 12 小时)
- 报告:连续天数、收藏/掌握词数、估计词汇量、活动图

**集成**
- Telegram Bot @reader_peiyong_ai_bot:登录取码(`/login`)、读书要点回顾(cron)、双向对话
- 每日复习卡片:到期的词一词一条推给你,带发音音频和 Hard / Good / Easy 按钮;
  点按钮即按艾宾浩斯遗忘曲线(SM-2,与网页端同一套)排下一次到期日,每天只发当天到期的那批(上限 10 张)

## 技术栈
React + TS + Vite · Cloudflare Workers + Hono · D1 · R2 · Vectorize ·
Workers AI(嵌入/OCR/Whisper) · OpenAI gpt-5-nano / DeepSeek · ElevenLabs TTS

## 开发 / 部署
- 本地:`npm run dev`(用 `wrangler.dev.jsonc`,无 AI 绑定 → 离线 mock)
- 部署:`npm run deploy`;迁移 0001–0015(`npm run db:migrate:remote`)
  —— 0011 / 0012 / 0013 / 0014 / 0015 漏跑时 AI 设置/统计、每日目标接口会在首次报「列/表不存在」时自行补建,不至于整页打不开
- Secret:`SESSION_SECRET`(会话 JWT 的签名密钥;没配时复用 `TELEGRAM_WEBHOOK_SECRET` / `TELEGRAM_BOT_TOKEN`)、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`(可选,也可在设置页填)、`ELEVENLABS_API_KEY`、`TELEGRAM_BOT_TOKEN`、
  `TELEGRAM_WEBHOOK_SECRET`、`TELEGRAM_OWNER_CHAT_ID`(可选,限定唯一可登录的 chat)
- 本地开发(`APP_ENV != production`)保留邮箱直登,供 e2e 用;生产环境自动禁用
- Vectorize 索引 `reader-vec`(1024 维,cosine),部署前创建一次
- Cron `0 * * * *` 驱动 Telegram 每日推送,并自检 webhook 的 `allowed_updates`:
  显式设过却漏了 `callback_query` 会让评分按钮点了没反应,自检时在原 url 上补齐(不改 url)
- `OPENAI_BASE_URL` / `DEEPSEEK_BASE_URL` 可在直连与兼容网关间切换
- `public/standard_fonts` + `public/cmaps` 由 prebuild 钩子从 pdfjs-dist 同步
- `public/phonetics/*.mp3` 是入库的 IPA 录音,`npm run fetch:ipa` 重拉(不进 prebuild:构建不依赖外网)

## 目录结构
```
worker/    Hono API + auth.ts / jwt.ts / logincode.ts / ai.ts / aiprovider.ts / openai.ts / elevenlabs.ts / tts.ts / telegram.ts / vocabmodel.ts / review.ts
src/       React 前端(pages/ 页面,components/ 组件,lib/ PDF·TTS·录音·TOC·音标表)
shared/    前后端共享类型
migrations/ D1 迁移(0001 MVP … 0015 每日阅读目标)
scripts/   Playwright 端到端自测(e2e.mjs)、IPA 录音抓取(fetch-ipa-audio.mjs)
```
