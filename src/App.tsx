import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { IS_HADI, HadiError, followHadiTheme, hadiReady, routeExternalLinksThroughHadi, setHadiTitle } from "./hadi";
import type { User } from "../shared/types";
import LoginPage from "./pages/LoginPage";
import LibraryPage from "./pages/LibraryPage";
import ReaderPage from "./pages/ReaderPage";
import SettingsPage from "./pages/SettingsPage";
import AiStatsPage from "./pages/AiStatsPage";
import PhoneticsPage from "./pages/PhoneticsPage";

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const fn = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  return hash;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [hadiError, setHadiError] = useState<{ code: string; message: string } | null>(null);
  const hash = useHashRoute();

  const refreshUser = useCallback(async () => {
    try {
      // 小程序里这一下会先连上 Hadi、换好本站会话(见 hadi.ts),不需要登录页
      const u = await api.get<User>("/api/me");
      setUser(u);
      setHadiError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      if (IS_HADI) {
        setHadiError(
          e instanceof HadiError
            ? { code: e.code, message: e.message }
            : { code: "error", message: (e as Error).message || "Something went wrong." }
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  // 小程序:主题跟随 Hadi,外链交给宿主打开
  useEffect(() => {
    if (!IS_HADI) return;
    routeExternalLinksThroughHadi();
    hadiReady().then(followHadiTheme).catch(() => {});
  }, []);

  // 小程序:Hadi 顶栏标题回到应用名(阅读页会换成书名,见 ReaderPage)
  const reading = /^#\/read\//.test(hash);
  useEffect(() => {
    if (!reading) setHadiTitle("沉浸阅读");
  }, [reading]);

  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (IS_HADI && (hadiError || !user)) {
    return (
      <HadiGate
        error={hadiError ?? { code: "sign_in_failed", message: "Sign-in failed." }}
        onRetry={() => {
          setLoading(true);
          void refreshUser();
        }}
      />
    );
  }

  if (!user) {
    return <LoginPage onLogin={refreshUser} />;
  }

  const readMatch = hash.match(/^#\/read\/([^/]+)/);
  if (readMatch) {
    return <ReaderPage key={readMatch[1]} bookId={readMatch[1]} user={user} onUserChange={setUser} />;
  }
  if (hash.startsWith("#/settings")) return <SettingsPage />;
  if (hash.startsWith("#/ai-stats")) return <AiStatsPage />;
  if (hash.startsWith("#/phonetics")) return <PhoneticsPage />;
  return <LibraryPage user={user} onUserChange={setUser} />;
}

/** 小程序进不去时的说明页:不在 Hadi 里打开、或者换不到本站会话 */
function HadiGate({ error, onRetry }: { error: { code: string; message: string }; onRetry: () => void }) {
  const outside = error.code === "not_in_hadi";
  return (
    <div className="center-screen login-bg">
      <div className="login-card">
        <h1>Immersive Reader</h1>
        {outside ? (
          <p className="login-sub">
            This is the Hadi mini-app build. Open it from Hadi → Apps, or use the website at{" "}
            <a href="https://reader.peiyong.ai">reader.peiyong.ai</a>.
          </p>
        ) : (
          <>
            <p className="login-sub">Could not sign in through Hadi.</p>
            <div className="error-text">{error.message}</div>
            <button className="btn btn-primary" onClick={onRetry}>Try again</button>
          </>
        )}
      </div>
    </div>
  );
}
