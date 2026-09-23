// 设置页:选 AI 提供商(OpenAI / DeepSeek)、模型,并填各家的 API key。
// key 保存后不再回显明文,只显示末 4 位;留空保存 = 清除,回退部署时配置的 secret。
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AiSettings } from "../../shared/types";
import { Icon } from "../components/Icon";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [err, setErr] = useState("");

  const load = () => {
    setErr("");
    return api
      .get<AiSettings>("/api/ai/settings")
      .then(setSettings)
      .catch((e) => setErr((e as Error).message || "加载设置失败"));
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (patch: Record<string, string>, note: string) => {
    setErr("");
    setBusy(true);
    try {
      await api.post("/api/ai/settings", patch);
      await load();
      setSaved(note);
      setTimeout(() => setSaved(""), 2500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const active = settings?.providers.find((p) => p.id === settings.provider);

  return (
    <div className="library">
      <header className="lib-header">
        <a className="lib-brand" href="#/">
          <Icon name="arrow-left" size={18} /> Library
        </a>
        <div className="lib-user">
          <a className="btn btn-ghost" href="#/ai-stats">
            <Icon name="activity" /> AI stats
          </a>
        </div>
      </header>

      <main className="lib-main">
        <div className="lib-toolbar">
          <h2>Settings</h2>
          {saved && <span className="settings-saved"><Icon name="check" /> {saved}</span>}
        </div>

        {err && (
          <div className="error-text">
            {err}{" "}
            {!settings && (
              <button className="btn btn-ghost" disabled={busy} onClick={() => void load()}>
                Retry
              </button>
            )}
          </div>
        )}
        {/* 加载失败时不要继续显示 Loading:否则页面看上去永远在转 */}
        {!settings && !err && <div className="hint-text">Loading…</div>}

        {settings && (
          <>
            <section className="settings-card">
              <div className="tg-head">
                <Icon name="sparkles" size={18} />
                <b>AI provider</b>
              </div>
              <p className="tg-desc">
                Which model answers lookups, page analysis and chat. Without a key the app falls back to Workers AI,
                then to offline mock replies.
              </p>

              <div className="settings-providers">
                {settings.providers.map((p) => (
                  <button
                    key={p.id}
                    className={`provider-pick ${p.id === settings.provider ? "active" : ""}`}
                    disabled={busy}
                    onClick={() => save({ provider: p.id }, `Switched to ${p.label}`)}
                  >
                    <span className="provider-name">{p.label}</span>
                    <span className={`provider-key ${p.key_set ? "ok" : "missing"}`}>
                      {p.key_set ? `Key ${p.key_hint} (${p.key_source === "env" ? "deployment" : "yours"})` : "No key"}
                    </span>
                  </button>
                ))}
              </div>

              {active && (
                <label className="tg-row">
                  <span>Model</span>
                  <select
                    value={settings.model}
                    disabled={busy}
                    onChange={(e) => save({ model: e.target.value }, "Model saved")}
                  >
                    {(active.models.includes(settings.model) ? active.models : [settings.model, ...active.models]).map(
                      (m) => (
                        <option key={m} value={m}>
                          {m}
                          {m === active.default_model ? " (default)" : ""}
                        </option>
                      )
                    )}
                  </select>
                </label>
              )}

              {active && !active.key_set && (
                <div className="settings-warn">
                  {active.label} has no API key yet — add one below, otherwise AI features stay on the fallback model.
                </div>
              )}
            </section>

            <section className="settings-card">
              <div className="tg-head">
                <Icon name="link" size={18} />
                <b>API keys</b>
              </div>
              <p className="tg-desc">
                Stored for your account only and never sent back to the browser. Leave a field empty and save to clear
                it and fall back to the key configured at deploy time.
              </p>
              {settings.providers.map((p) => (
                <div key={p.id} className="settings-key-row">
                  <label className="edit-label" htmlFor={`key-${p.id}`}>
                    {p.label} API key
                    {p.key_set && (
                      <span className="hint-text">
                        {" "}
                        · current {p.key_hint} ({p.key_source === "env" ? "from deployment secret" : "set here"})
                      </span>
                    )}
                  </label>
                  <div className="settings-key-input">
                    <input
                      id={`key-${p.id}`}
                      type="password"
                      autoComplete="off"
                      placeholder={p.id === "deepseek" ? "sk-…" : "sk-proj-…"}
                      value={keyDrafts[p.id] ?? ""}
                      onChange={(e) => setKeyDrafts({ ...keyDrafts, [p.id]: e.target.value })}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => {
                        void save({ [`${p.id}_api_key`]: keyDrafts[p.id] ?? "" }, `${p.label} key saved`);
                        setKeyDrafts({ ...keyDrafts, [p.id]: "" });
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ))}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
