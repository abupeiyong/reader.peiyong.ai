-- 词汇量每日快照(根据阅读行为记录词汇量趋势)
CREATE TABLE vocab_snapshots (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                         -- YYYY-MM-DD (UTC)
  vocab_rank REAL NOT NULL,                  -- 估计词汇量(词频排名口径)
  known_count INTEGER NOT NULL DEFAULT 0,    -- 已掌握词数
  saved_count INTEGER NOT NULL DEFAULT 0,    -- 收藏词数
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
