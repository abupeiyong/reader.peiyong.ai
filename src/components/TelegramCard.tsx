import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";

interface Status {
  available: boolean;
  linked: boolean;
  daily_enabled: boolean;
  daily_hour: number; // UTC
}

// UTC 小时 <-> 本地小时
const tzOffsetHours = -new Date().getTimezoneOffset() / 60;
const toLocalHour = (utc: number) => ((utc + tzOffsetHours) % 24 + 24) % 24;
const toUtcHour = (local: number) => ((local - tzOffsetHours) % 24 + 24) % 24;

export default function TelegramCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<{ deep_link: string; bot: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    void api.get<Status>("/api/telegram/status").then(setStatus).catch(() => {});
  };
  useEffect(load, []);

  if (!status || !status.available) return null;

  const connect = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ deep_link: string; bot: string }>("/api/telegram/link");
      setLink(r);
      window.open(r.deep_link, "_blank");
      // 轮询绑定状态
      const started = Date.now();
      const timer = setInterval(async () => {
        const s = await api.get<Status>("/api/telegram/status");
        if (s.linked || Date.now() - started > 120000) {
          clearInterval(timer);
          setStatus(s);
          if (s.linked) setLink(null);
        }
      }, 3000);
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (patch: Partial<{ daily_enabled: boolean; daily_hour: number }>) => {
    const next = { ...status, ...patch };
    setStatus(next);
    await api.post("/api/telegram/settings", patch);
  };

  const unlink = async () => {
    if (!confirm("Disconnect Telegram? You'll stop receiving daily reminders.")) return;
    await api.post("/api/telegram/unlink");
    load();
  };

  const localHour = Math.round(toLocalHour(status.daily_hour));

  return (
    <div className="tg-card">
      <div className="tg-head">
        <Icon name="message" size={18} />
        <b>Telegram reminders</b>
        {status.linked && <span className="tg-badge">Connected</span>}
      </div>

      {!status.linked ? (
        <>
          <p className="tg-desc">
            Connect Telegram to get a daily review reminder with your due words and a recap of what you're reading —
            and chat with the AI assistant right in Telegram.
          </p>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={connect}>
            {busy ? "Opening…" : "Connect Telegram"}
          </button>
          {link && (
            <p className="tg-desc">
              If Telegram didn't open,{" "}
              <a href={link.deep_link} target="_blank" rel="noreferrer">tap here</a> and press Start in @{link.bot}.
            </p>
          )}
        </>
      ) : (
        <>
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
          <button className="link-btn danger tg-unlink" onClick={unlink}>Disconnect</button>
        </>
      )}
    </div>
  );
}
