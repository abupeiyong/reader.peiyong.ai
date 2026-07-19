-- 阅读计时会话
CREATE TABLE reading_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                       -- 最后一次心跳/结束时间
  active_ms INTEGER NOT NULL DEFAULT 0,   -- 实际阅读毫秒(有操作)
  idle_ms INTEGER NOT NULL DEFAULT 0      -- 中断毫秒(>2分钟无操作)
);
CREATE INDEX idx_rsessions_user_time ON reading_sessions(user_id, started_at);
