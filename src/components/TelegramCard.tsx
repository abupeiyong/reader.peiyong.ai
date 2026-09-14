import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";

interface Status {
  available: boolean;
  linked: boolean;      // Telegram 登录的账号天然已绑定
  daily_enabled: boolean;
  daily_hour: number;   // UTC
}

// UTC 小时 <-> 本地小时
const tzOffsetHours = -new Date().getTimezoneOffset() / 60;
const toLocalHour = (utc: number) => ((utc + tzOffsetHours) % 24 + 24) % 24;
const toUtcHour = (local: number) => ((local - tzOffsetHours) % 24 + 24) % 24;

export default function TelegramCard() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    void api.get<Status>("/api/telegram/status").then(setStatus).catch(() => {});
  }, []);

  if (!status || !status.available || !status.linked) return null;

  const saveSettings = async (patch: Partial<{ daily_enabled: boolean; daily_hour: number }>) => {
    setStatus({ ...status, ...patch });
    await api.post("/api/telegram/settings", patch);
  };

  const localHour = Math.round(toLocalHour(status.daily_hour));

  return (
    <div className="tg-card">
      <div className="tg-head">
        <Icon name="message" size={18} />
        <b>Telegram reminders</b>
        <span className="tg-badge">Connected</span>
      </div>
      <p className="tg-desc">
        A daily reminder with your due words and a recap of what you're reading — and you can chat with the AI
        assistant right in Telegram.
      </p>
      <label className="tg-row">
        <input
          type="checkbox"
          checked={status.daily_enabled}
          onChange={(e) => saveSettings({ daily_enabled: e.target.checked })}
        />
        <span>Daily reminder</span>
      </label>
      <label className="tg-row">
        <span>Time (your local)</span>
        <select
          value={localHour}
          disabled={!status.daily_enabled}
          onChange={(e) => saveSettings({ daily_hour: Math.round(toUtcHour(Number(e.target.value))) })}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
          ))}
        </select>
      </label>
    </div>
  );
}
