-- 查词时是否让模型「思考」(推理)。查词要的是快,默认关闭。
-- 关闭的落地方式见 worker/aiprovider.ts:gpt-5 用最低推理档,DeepSeek 的
-- 推理模型换成同一家的非推理模型(deepseek-chat)。
ALTER TABLE users ADD COLUMN ai_word_thinking INTEGER; -- 1 = 开;0 / NULL = 关(默认)
