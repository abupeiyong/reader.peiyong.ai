// AI 统计页:按提供商/模型对比每次调用的响应延迟。
// 流式对话记的是「到首个内容块」的延迟(TTFT),非流式记整次请求耗时。
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AiStats } from "../../shared/types";
import { Icon } from "../components/Icon";

const RANGES = [7, 30, 90];

const KIND_LABEL: Record<string, string> = {
  explain_word: "Word lookup",
  analyze_page: "Page analysis",
  chat: "Chat (to first token)",
  telegram: "Telegram",
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;
}

export default function AiStatsPage() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<AiStats | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setStats(null);
    api
      .get<AiStats>(`/api/ai/stats?days=${days}`)
      .then(setStats)
      .catch((e) => setErr((e as Error).message));
  }, [days]);

  const slowest = Math.max(...(stats?.by_model.map((m) => m.p95_ms) ?? [1]), 1);

  return (
    <div className="library">
      <header className="lib-header">
        <a className="lib-brand" href="#/">
          <Icon name="arrow-left" size={18} /> Library
        </a>
        <div className="lib-user">
          <a className="btn btn-ghost" href="#/settings">
            <Icon name="settings" /> Settings
          </a>
        </div>
      </header>

      <main className="lib-main">
        <div className="lib-toolbar">
          <h2>AI statistics</h2>
          <div className="lib-actions">
            {RANGES.map((d) => (
              <button key={d} className={`chip ${d === days ? "active" : ""}`} onClick={() => setDays(d)}>
                {d}d
              </button>
            ))}
          </div>
        </div>

        {err && <div className="error-text">{err}</div>}
        {!stats && !err && <div className="hint-text">Loading…</div>}

        {stats && stats.total_calls === 0 && (
          <div className="empty-state">
            <div className="empty-icon"><Icon name="activity" size={44} /></div>
            <p>No AI calls recorded in the last {stats.days} days.</p>
            <p className="hint-text">
              Look up a word, analyse a page or chat about a book — each call's latency is recorded here so you can
              compare providers.
            </p>
          </div>
        )}

        {stats && stats.total_calls > 0 && (
          <>
            <div className="stat-tiles">
              <div className="stat-tile">
                <div className="stat-num">{stats.total_calls}</div>
                <div className="stat-label">Calls · last {stats.days}d</div>
              </div>
              <div className="stat-tile">
                <div className="stat-num">{stats.by_model.length}</div>
                <div className="stat-label">Models used</div>
              </div>
              {stats.by_model.slice(0, 2).map((m) => (
                <div key={`${m.provider}-${m.model}`} className="stat-tile">
                  <div className="stat-num">{fmtMs(m.p50_ms)}</div>
                  <div className="stat-label">{m.model} · median</div>
                </div>
              ))}
            </div>

            <div className="chart-block">
              <div className="chart-title">Latency by model</div>
              <table className="ai-table">
                <thead>
                  <tr>
                    <th>Provider / model</th>
                    <th>Calls</th>
                    <th>Median</th>
                    <th>Avg</th>
                    <th>p95</th>
                    <th>Failed</th>
                    <th className="ai-bar-cell">p95 (relative)</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_model.map((m) => (
                    <tr key={`${m.provider}-${m.model}`}>
                      <td>
                        <b>{m.model}</b>
                        <span className="hint-text"> · {m.provider}</span>
                      </td>
                      <td>{m.calls}</td>
                      <td>{fmtMs(m.p50_ms)}</td>
                      <td>{fmtMs(m.avg_ms)}</td>
                      <td>{fmtMs(m.p95_ms)}</td>
                      <td>{m.calls - m.ok_calls || "—"}</td>
                      <td className="ai-bar-cell">
                        <span className="ai-bar" style={{ width: `${Math.max((m.p95_ms / slowest) * 100, 2)}%` }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint-text ai-note">
                Chat is streamed, so its latency is the time to the first token; other calls are the full request.
              </p>
            </div>

            <div className="chart-block">
              <div className="chart-title">By use case</div>
              <table className="ai-table">
                <thead>
                  <tr>
                    <th>Use case</th>
                    <th>Model</th>
                    <th>Calls</th>
                    <th>Median</th>
                    <th>Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_kind.map((g) => (
                    <tr key={`${g.kind}-${g.provider}-${g.model}`}>
                      <td>{KIND_LABEL[g.kind] ?? g.kind}</td>
                      <td>
                        {g.model}
                        <span className="hint-text"> · {g.provider}</span>
                      </td>
                      <td>{g.calls}</td>
                      <td>{fmtMs(g.p50_ms)}</td>
                      <td>{fmtMs(g.avg_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="chart-block">
              <div className="chart-title">Recent calls</div>
              <table className="ai-table">
                <tbody>
                  {stats.recent.map((r, i) => (
                    <tr key={`${r.created_at}-${i}`}>
                      <td>{new Date(r.created_at).toLocaleString()}</td>
                      <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                      <td>
                        {r.model}
                        <span className="hint-text"> · {r.provider}</span>
                      </td>
                      <td>{fmtMs(r.latency_ms)}</td>
                      <td>{r.ok ? "" : <span className="ai-failed">failed</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
