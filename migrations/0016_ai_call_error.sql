-- 回退到「离线模拟」时的失败原因也要能在 AI 统计页看到(issue #58)。
-- 之前只有「提供商返回了错误」这一种失败会落 ai_calls,而「选中的提供商没有 key」
-- 和「Workers AI 兜底抛错」这两条路只写 Worker 日志,统计页里一行都没有,
-- 于是页面显示离线模拟、统计页却干干净净。
ALTER TABLE ai_calls ADD COLUMN error TEXT;  -- ok = 0 时的失败原因;成功为 NULL
