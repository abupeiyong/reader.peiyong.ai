// 设置页:选 AI 提供商(OpenAI / DeepSeek / Random)、模型,填各家的 API key,
// 以及查词时要不要让模型「思考」(默认关,查词图的是快)。
// Random = 每次 AI 任务在「填了 key 的提供商」里随机挑一家,各家用自己那份已选模型。
// key 保存后不再回显明文,只显示末 4 位;留空保存 = 清除,回退部署时配置的 secret。
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AiProviderInfo, AiProviderTest, AiSettings } from "../../shared/types";
import { Icon } from "../components/Icon";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  // 每家最近一次「Test」的结果;"busy" = 正在自检
  const [tests, setTests] = useState<Record<string, AiProviderTest | "busy">>({});
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

  const save = async (patch: Record<string, string | boolean>, note: string) => {
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

  // 自检:真向这家发一条最短请求,把它返回的失败原因显示出来
  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "busy" }));
    try {
      const r = await api.post<AiProviderTest>("/api/ai/test", { provider: id });
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({
        ...t,
        [id]: { provider: id as AiProviderTest["provider"], model: "", ok: false, latency_ms: 0, error: (e as Error).message },
      }));
    }
  };

  const isRandom = settings?.provider === "random";
  const active = settings?.providers.find((p) => p.id === settings.provider);
  // 随机挑选只在有 key 的提供商里进行,没 key 的那家永远抽不到
  const inDraw = settings?.providers.filter((p) => p.key_set) ?? [];

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
                Which model answers lookups, page analysis and chat. Pick a provider, or let Random draw one for each
                request. Without a key the app falls back to Workers AI, then to offline mock replies.
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
                <button
                  className={`provider-pick ${isRandom ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => save({ provider: "random" }, "Switched to Random")}
                >
                  <span className="provider-name">Random</span>
                  <span className="provider-key">One provider per request</span>
                </button>
              </div>

              {isRandom && (
                <>
                  <p className="hint-text">
                    Each lookup, page analysis and chat draws one provider from the ones with a key, each keeping the
                    model you pick for it here.
                  </p>
                  {/* 每家一个下拉:random 下也能直接改某家的模型,不用先切过去再切回来 */}
                  {inDraw.map((p) => (
                    <label key={p.id} className="tg-row">
                      <span>{p.label} model</span>
                      <ModelSelect
                        provider={p}
                        value={p.model}
                        disabled={busy}
                        onPick={(m) => save({ [`${p.id}_model`]: m }, `${p.label} model saved`)}
                      />
                    </label>
                  ))}
                </>
              )}

              {!isRandom && active && (
                <label className="tg-row">
                  <span>Model</span>
                  <ModelSelect
                    provider={active}
                    value={settings.model}
                    disabled={busy}
                    onPick={(m) => save({ model: m }, "Model saved")}
                  />
                </label>
              )}

              {!isRandom && active && !active.key_set && (
                <div className="settings-warn">
                  {active.label} has no API key yet — add one below, otherwise AI features stay on the fallback model.
                </div>
              )}

              {isRandom && inDraw.length < 2 && (
                <div className="settings-warn">
                  {inDraw.length === 1
                    ? `Only ${inDraw[0].label} has an API key, so every request goes there. Add the other key below to make the draw a real coin flip.`
                    : "No provider has an API key yet — add one below, otherwise AI features stay on the fallback model."}
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
                    <button
                      className="btn btn-ghost"
                      disabled={busy || tests[p.id] === "busy"}
                      onClick={() => void test(p.id)}
                      title="Send one tiny request and show what the provider answers"
                    >
                      {tests[p.id] === "busy" ? "Testing…" : "Test"}
                    </button>
                  </div>
                  {tests[p.id] && tests[p.id] !== "busy" && <TestResult result={tests[p.id] as AiProviderTest} />}
                </div>
              ))}
            </section>

            <section className="settings-card">
              <div className="tg-head">
                <Icon name="sparkles" size={18} />
                <b>Word lookups</b>
              </div>
              <p className="tg-desc">
                Looking up a word skips the model's thinking step by default, so the popover comes back as fast as the
                model can write. Turn it on to trade that speed for a reasoning pass: gpt-5 models switch to low
                reasoning effort, and DeepSeek keeps deepseek-reasoner instead of falling back to deepseek-chat. Page
                analysis and chat are not affected.
              </p>
              <label className="tg-row">
                <input
                  type="checkbox"
                  checked={settings.word_thinking}
                  disabled={busy}
                  onChange={(e) =>
                    save(
                      { word_thinking: e.target.checked },
                      e.target.checked ? "Thinking on for lookups" : "Thinking off for lookups"
                    )
                  }
                />
                <span>Let the model think before explaining a word</span>
              </label>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/** 某一家的模型下拉;当前值不在清单里(比如提供商下线了它)时也照样列出来,免得下拉显示空白 */
function ModelSelect({
  provider,
  value,
  disabled,
  onPick,
}: {
  provider: AiProviderInfo;
  value: string;
  disabled: boolean;
  onPick: (model: string) => void;
}) {
  const models = provider.models.includes(value) ? provider.models : [value, ...provider.models];
  return (
    <select value={value} disabled={disabled} onChange={(e) => onPick(e.target.value)}>
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
          {m === provider.default_model ? " (default)" : ""}
        </option>
      ))}
    </select>
  );
}

/** 自检结果:成功显示模型 + 往返耗时,失败把提供商的原话照抄出来 */
function TestResult({ result }: { result: AiProviderTest }) {
  if (result.ok) {
    return (
      <p className="settings-test ok">
        <Icon name="check" /> {result.model} replied in {result.latency_ms} ms
      </p>
    );
  }
  return (
    <p className="settings-test bad">
      <Icon name="x" /> {result.error}
    </p>
  );
}
