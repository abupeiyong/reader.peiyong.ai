-- 查词结果缓存:同一 (单词, 原句, 水平) 的解释全局复用,重复查询免 AI 调用
CREATE TABLE word_exp_cache (
  word TEXT NOT NULL,              -- 小写归一化
  sentence_hash TEXT NOT NULL,     -- 原句归一化后的 FNV-1a 哈希(空句用 "-")
  level TEXT NOT NULL,             -- 生成时的用户水平(提示词随水平变化)
  explanation_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (word, sentence_hash, level)
);
