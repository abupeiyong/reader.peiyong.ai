-- AI 提供商可选(OpenAI / DeepSeek):设置页选提供商 + 模型 + 填 API key,
-- 并记录每次 LLM 调用的延迟,供 AI 统计页做对比。
ALTER TABLE users ADD COLUMN ai_provider TEXT;       -- openai | deepseek;NULL = 默认 openai
ALTER TABLE users ADD COLUMN ai_model TEXT;          -- 覆盖该提供商的默认模型;NULL = 用默认
ALTER TABLE users ADD COLUMN openai_api_key TEXT;    -- 设置页填写;为空时回退环境变量 OPENAI_API_KEY
ALTER TABLE users ADD COLUMN deepseek_api_key TEXT;  -- 设置页填写;为空时回退环境变量 DEEPSEEK_API_KEY

-- 每次 LLM 调用一行。latency_ms:非流式为整次请求耗时,流式为到首个内容块(TTFT)。
CREATE TABLE ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,           -- openai | deepseek | workers-ai
  model TEXT NOT NULL,
  kind TEXT NOT NULL,               -- explain_word | analyze_page | chat | telegram
  latency_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,    -- 0 = 该提供商失败(上层已回退)
  stream INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_calls_user ON ai_calls(user_id, created_at);
