export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AI?: Ai; // 本地开发无此绑定(自动回退 mock),部署配置中存在
  VECTORIZE?: VectorizeIndex; // 本地开发无此绑定(回退关键词检索)
  ASSETS: Fetcher;
  APP_ENV: string;
  APP_ORIGIN: string;
  // OpenAI 兼容接入(查词/解析/对话优先用 gpt-5-nano,未配置则回退 Workers AI)
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;   // 默认 https://api.openai.com/v1;可指向兼容网关
  OPENAI_CHAT_MODEL?: string; // 默认 gpt-5-nano
  // ElevenLabs TTS(eleven_v3);未配置则回退 Workers AI melotts → 浏览器合成
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_MODEL_ID?: string;   // 默认 eleven_v3
  ELEVENLABS_VOICE_US?: string;
  ELEVENLABS_VOICE_UK?: string;
  // Telegram Bot(登录码 + 每日推送;未配置时登录不可用,仅本地 dev 直登)
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;   // 用于生成 t.me 深链;缺省时运行时 getMe
  TELEGRAM_WEBHOOK_SECRET?: string; // 校验 webhook 来源
  TELEGRAM_OWNER_CHAT_ID?: string;  // 唯一允许登录的 chat;留空则取库里已绑定的唯一账号
  APP_URL?: string;                 // 站点地址(推送里带链接),默认 APP_ORIGIN
}

export interface Vars {
  userId: string;
}
