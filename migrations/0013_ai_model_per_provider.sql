-- 模型选择改成「每家各记一份」。原来只有一列 ai_model:换提供商(切到 random 也算)
-- 时会被清空,于是选过的 deepseek-flash 又回到 deepseek-chat(issue #35)。
ALTER TABLE users ADD COLUMN ai_model_openai TEXT;   -- NULL = 用 OpenAI 的默认模型
ALTER TABLE users ADD COLUMN ai_model_deepseek TEXT; -- NULL = 用 DeepSeek 的默认模型

-- 旧的单列值按模型名归到对应的那一家;ai_model 保留不动,代码里只当老数据的兜底读。
UPDATE users SET ai_model_deepseek = ai_model WHERE ai_model LIKE 'deepseek%';
UPDATE users SET ai_model_openai = ai_model WHERE ai_model IS NOT NULL AND ai_model NOT LIKE 'deepseek%';
