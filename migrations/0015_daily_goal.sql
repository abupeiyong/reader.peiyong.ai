-- 每日阅读目标从写死的 3 小时改成可配置(issue #48):设置页里能自己选时长。
-- 单位分钟;NULL = 没设过,按默认 180 分钟(3 小时)算。
ALTER TABLE users ADD COLUMN daily_goal_min INTEGER;
