import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";

interface AuthConfig {
  telegram: boolean;
  devLogin: boolean;
  bot: string | null;
}

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0); // 码剩余有效秒数
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<AuthConfig>("/api/auth/config")
      .then(setConfig)
      .catch(() => setConfig({ telegram: false, devLogin: true, bot: null }));
  }, []);

  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [left]);

  const requestCode = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await api.post<{ expires_in: number }>("/api/auth/request-code");
      setSent(true);
      setLeft(r.expires_in);
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    setError("");
    setBusy(true);
    try {
      await api.post("/api/auth/verify-code", { code: value });
      onLogin();
    } catch (e) {
      setError((e as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const onCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !busy) void verify(digits);
  };

  const devLogin = async () => {
    setError("");
    setBusy(true);
    try {
      await api.post("/api/auth/dev-login", { email });
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen login-bg">
      <div className="login-card">
        <div className="login-logo"><Icon name="book" size={40} /></div>
        <h1>Immersive Reader</h1>
        <p className="login-sub">English PDF deep reading · Lookup · Analysis · Chat · Read-along</p>

        {config?.telegram && (
          <div className="tg-login">
            {!sent ? (
              <>
                <p className="tg-login-desc">
                  Sign in with a one-time code sent to your Telegram
                  {config.bot ? <> (@{config.bot})</> : null}.
                </p>
                <button className="btn btn-primary btn-block" disabled={busy} onClick={requestCode}>
                  <Icon name="send" size={16} />
                  {busy ? "Sending…" : "Send code to Telegram"}
                </button>
              </>
            ) : (
              <>
                <p className="tg-login-desc">
                  Enter the 6-digit code from Telegram
                  {left > 0 ? <> · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</> : <> · expired</>}
                </p>
                <input
                  ref={codeRef}
                  className="code-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => onCodeChange(e.target.value)}
                />
                <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6} onClick={() => verify(code)}>
                  {busy ? "Signing in…" : "Sign in"}
                </button>
                <button className="link-btn" disabled={busy} onClick={requestCode}>
                  Send a new code
                </button>
              </>
            )}
            <p className="tg-login-hint">
              No message? Send <code>/login</code> to {config.bot ? `@${config.bot}` : "the bot"} and enter the code it replies with.
            </p>
          </div>
        )}

        {config?.devLogin && (
          <div className="dev-login">
            <div className="dev-login-note">Local dev sign-in (disabled in production)</div>
            <input
              type="email"
              placeholder="Enter email to sign in"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && email && devLogin()}
            />
            <button className="btn btn-primary" disabled={busy || !email} onClick={devLogin}>
              {busy ? "Signing in…" : "Sign in / Sign up"}
            </button>
          </div>
        )}

        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  );
}
