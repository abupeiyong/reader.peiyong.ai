-- Telegram 绑定与每日推送
ALTER TABLE users ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE users ADD COLUMN telegram_link_code TEXT;
ALTER TABLE users ADD COLUMN tg_daily_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN tg_daily_hour INTEGER NOT NULL DEFAULT 8;  -- UTC 小时
ALTER TABLE users ADD COLUMN tg_last_push TEXT;                          -- 上次推送日期(YYYY-MM-DD),防重复
CREATE INDEX idx_users_tg_chat ON users(telegram_chat_id);
CREATE INDEX idx_users_tg_code ON users(telegram_link_code);
