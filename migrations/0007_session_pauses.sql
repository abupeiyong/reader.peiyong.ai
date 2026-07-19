-- 阅读会话中断次数(1分钟无活动暂停计时,恢复算一次中断)
ALTER TABLE reading_sessions ADD COLUMN pauses INTEGER NOT NULL DEFAULT 0;
