-- 二期:间隔重复(SM-2)、活动日志、用户词汇水平估计
ALTER TABLE vocab ADD COLUMN due_at INTEGER;          -- 下次复习时间(毫秒);NULL=新词立即可复习
ALTER TABLE vocab ADD COLUMN interval_days REAL NOT NULL DEFAULT 0;
ALTER TABLE vocab ADD COLUMN ease REAL NOT NULL DEFAULT 2.5;
ALTER TABLE vocab ADD COLUMN reps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vocab ADD COLUMN last_review INTEGER;

ALTER TABLE users ADD COLUMN vocab_rank REAL;         -- 估计词汇量(词频排名口径),NULL=按 english_level 初始化

-- 学习活动日志(阅读报告用)
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- page_view | lookup | vocab_add | review | recording | chat
  book_id TEXT,
  page_no INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_user_time ON activity(user_id, created_at);
