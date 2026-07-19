import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";

export default function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [config, setConfig] = useState<{ google: boolean; devLogin: boolean } | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ google: boolean; devLogin: boolean }>("/api/auth/config").then(setConfig).catch(() => {
      setConfig({ google: false, devLogin: true });
    });
  }, []);

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

        {config?.google && (
          <a className="btn btn-google" href="/api/auth/google">
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.7 1.22 9.2 3.6l6.85-6.85C35.9 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.55 13.3l7.98 6.2C12.4 13.2 17.7 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.1 24.55c0-1.57-.15-3.1-.4-4.55H24v9.1h12.4c-.55 2.9-2.2 5.36-4.65 7l7.5 5.85C43.6 37.6 46.1 31.65 46.1 24.55z" />
              <path fill="#FBBC05" d="M10.53 28.5a14.4 14.4 0 0 1 0-9l-7.98-6.2a24 24 0 0 0 0 21.4l7.98-6.2z" />
              <path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.45-5.65l-7.5-5.85c-2.1 1.4-4.8 2.25-7.95 2.25-6.3 0-11.6-3.7-13.47-9L2.55 34.7C6.5 42.6 14.6 48 24 48z" />
            </svg>
            Sign in with Google
          </a>
        )}

        {config?.devLogin && (
          <div className="dev-login">
            <div className="dev-login-note">
              Temporary sign-in (Google OAuth not configured yet; will switch automatically once set up)
            </div>
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
