-- 查词的「思考」从开关升级成档位(issue #34 的追问:改不了思考深度)。
-- 取值 off / low / medium / high;NULL = 没设过,按默认 off 算。
-- 老数据仍在 ai_word_thinking(1 = 开)里,代码按 1 → low、0 → off 兜底读。
ALTER TABLE users ADD COLUMN ai_word_think_level TEXT;

UPDATE users SET ai_word_think_level = 'low' WHERE ai_word_thinking = 1;
UPDATE users SET ai_word_think_level = 'off' WHERE ai_word_thinking = 0;
