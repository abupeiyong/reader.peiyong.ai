-- 阅读笔记(日历回顾用)
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT,
  page_no INTEGER,
  quote TEXT,            -- 选中的原文(可空)
  note TEXT NOT NULL,    -- 用户笔记
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_user_time ON notes(user_id, created_at);
