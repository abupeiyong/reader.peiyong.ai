-- 初始 schema:用户、会话、书籍、页面、进度、生词、聊天、录音、书签
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  google_sub TEXT UNIQUE,
  english_level TEXT DEFAULT 'intermediate', -- beginner | intermediate | advanced
  hints_enabled INTEGER NOT NULL DEFAULT 1,  -- 生词轻量提示开关(沉浸模式=0)
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded | processing | ready | failed
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_books_user ON books(user_id);

-- 每页提取的文本;analysis_json 缓存"本页解析"结果
CREATE TABLE pages (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  analysis_json TEXT,
  PRIMARY KEY (book_id, page_no)
);

CREATE TABLE reading_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL DEFAULT 1,
  zoom REAL NOT NULL DEFAULT 1.0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE vocab (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word TEXT NOT NULL,               -- 原样(可能是短语)
  normalized TEXT NOT NULL,         -- 小写归一化,用于去重
  context_sentence TEXT,
  book_id TEXT,
  page_no INTEGER,
  explanation_json TEXT,            -- 缓存 AI 解释
  status TEXT NOT NULL DEFAULT 'learning', -- learning | known | review
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, normalized)
);
CREATE INDEX idx_vocab_user ON vocab(user_id);

-- 单词行为日志,供后续个性化词汇模型使用
CREATE TABLE word_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  word TEXT NOT NULL,
  action TEXT NOT NULL, -- click | save | known | unknown
  book_id TEXT,
  page_no INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_word_events_user_word ON word_events(user_id, word);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  role TEXT NOT NULL,        -- user | assistant
  content TEXT NOT NULL,
  refs_json TEXT,            -- [{page, quote}]
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_book ON chat_messages(user_id, book_id, created_at);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT,
  page_no INTEGER,
  r2_key TEXT NOT NULL,
  ref_text TEXT NOT NULL,
  transcript TEXT,
  feedback_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_recordings_user ON recordings(user_id, created_at);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, book_id, page_no)
);
