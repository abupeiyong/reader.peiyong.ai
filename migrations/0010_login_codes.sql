-- Telegram 一次性登录码(随机密码登录,替代 Google OAuth)
CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,       -- sha256(chat_id:code),不存明文
  ticket TEXT,                   -- 网页发起时绑定的浏览器票据;bot /login 发起为 NULL
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_login_codes_chat ON login_codes(chat_id, created_at);
