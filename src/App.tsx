import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { User } from "../shared/types";
import LoginPage from "./pages/LoginPage";
import LibraryPage from "./pages/LibraryPage";
import ReaderPage from "./pages/ReaderPage";

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
  const hash = useHashRoute();

  const refreshUser = useCallback(async () => {
    try {
      const u = await api.get<User>("/api/me");
      setUser(u);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={refreshUser} />;
  }

  const readMatch = hash.match(/^#\/read\/([^/]+)/);
  if (readMatch) {
    return <ReaderPage key={readMatch[1]} bookId={readMatch[1]} user={user} onUserChange={setUser} />;
  }
  return <LibraryPage user={user} onUserChange={setUser} />;
}
