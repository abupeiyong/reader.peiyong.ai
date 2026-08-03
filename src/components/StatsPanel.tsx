import { useEffect, useState } from "react";
import { api } from "../api";
import type { DayStat, Stats, VocabSnapshot } from "../../shared/types";

function dayTotal(d: DayStat): number {
  return (d.page_view ?? 0) + (d.lookup ?? 0) + (d.vocab_add ?? 0) + (d.review ?? 0) + (d.recording ?? 0) + (d.chat ?? 0);
}

export default function StatsPanel({ refreshNonce }: { refreshNonce: number }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.get<Stats>(`/api/stats?tzoff=${new Date().getTimezoneOffset()}`).then(setStats).catch(() => {});
  }, [refreshNonce]);

  if (!stats) return null;

  const totals = stats.days.map(dayTotal);
  const max = Math.max(...totals, 1);
  const maxIdx = totals.indexOf(Math.max(...totals));
  const vocabTotal = Object.values(stats.vocab).reduce((a, b) => a + b, 0);
  const readDays = stats.read_days ?? [];
  const todayMs = readDays[readDays.length - 1]?.ms ?? 0;
  const readMax = Math.max(...readDays.map((d) => d.ms), 1);
  const readMaxIdx = readDays.findIndex((d) => d.ms === readMax);

  return (
    <div className="stats-panel">
      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="stat-num">{stats.streak}</div>
          <div className="stat-label">Day streak</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{vocabTotal}</div>
          <div className="stat-label">Saved words</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{stats.vocab.known ?? 0}</div>
          <div className="stat-label">Mastered</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{fmtDur(todayMs)}</div>
          <div className="stat-label">Read today</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">≈{formatRank(stats.vocab_rank)}</div>
          <div className="stat-label">Est. vocabulary</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{stats.recording_count}</div>
          <div className="stat-label">Speaking drills</div>
        </div>
      </div>

      <div className="chart-block">
        <div className="chart-title">Activity — last 30 days</div>
        <div className="bar-chart" role="img" aria-label="Daily learning activity over the last 30 days">
          {stats.days.map((d, i) => {
            const t = totals[i];
            return (
              <div key={d.date} className="bar-col">
                {i === maxIdx && t > 0 && <div className="bar-peak-label">{t}</div>}
                <div
                  className={`bar ${t === 0 ? "empty" : ""}`}
                  style={{ height: `${Math.max((t / max) * 72, t > 0 ? 4 : 2)}px` }}
                />
                <div className="bar-tip">
                  {d.date.slice(5)} · {t} actions
                  {t > 0 && (
                    <span className="bar-tip-detail">
                      {[
                        d.page_view ? `Read ${d.page_view}` : "",
                        d.lookup ? `Lookups ${d.lookup}` : "",
                        d.review ? `Review ${d.review}` : "",
                        d.recording ? `Speaking ${d.recording}` : "",
                        d.chat ? `Chat ${d.chat}` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="bar-axis">
          <span>{stats.days[0]?.date.slice(5)}</span>
          <span>Today</span>
        </div>
      </div>

      {readDays.some((d) => d.ms > 0) && (
        <div className="chart-block">
          <div className="chart-title">Reading time — last 30 days</div>
          <div className="bar-chart" role="img" aria-label="Daily reading time over the last 30 days">
            {readDays.map((d, i) => (
              <div key={d.date} className="bar-col">
                {i === readMaxIdx && d.ms > 0 && <div className="bar-peak-label">{fmtDur(d.ms)}</div>}
                <div
                  className={`bar read ${d.ms === 0 ? "empty" : ""}`}
                  style={{ height: `${Math.max((d.ms / readMax) * 72, d.ms > 0 ? 4 : 2)}px` }}
                />
                <div className="bar-tip">{d.date.slice(5)} · {d.ms > 0 ? fmtDur(d.ms) : "No reading"}</div>
              </div>
            ))}
          </div>
          <div className="bar-axis">
            <span>{readDays[0]?.date.slice(5)}</span>
            <span>Today</span>
          </div>
        </div>
      )}

      {stats.vocab_trend.length >= 2 && (
        <div className="chart-block">
          <div className="chart-title">Estimated vocabulary — trend</div>
          <VocabTrendChart data={stats.vocab_trend} />
        </div>
      )}
    </div>
  );
}

/** 词汇量快照折线图(SVG,无依赖) */
function VocabTrendChart({ data }: { data: VocabSnapshot[] }) {
  const W = 600;
  const H = 130;
  const PAD = { l: 8, r: 95, t: 14, b: 8 };
  const ranks = data.map((d) => d.vocab_rank);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  const span = Math.max(max - min, 200); // 变化很小时避免曲线夸张抖动
  const mid = (max + min) / 2;
  const lo = mid - span / 2;
  const xOf = (i: number) =>
    data.length === 1 ? W / 2 : PAD.l + (i / (data.length - 1)) * (W - PAD.l - PAD.r);
  const yOf = (r: number) => PAD.t + (1 - (r - lo) / span) * (H - PAD.t - PAD.b);
  const pts = data.map((d, i) => `${xOf(i).toFixed(1)},${yOf(d.vocab_rank).toFixed(1)}`);
  const last = data[data.length - 1];
  const lastX = xOf(data.length - 1);
  const lastY = yOf(last.vocab_rank);
  const area = `${pts.join(" ")} ${lastX.toFixed(1)},${H} ${xOf(0).toFixed(1)},${H}`;

  return (
    <>
      <svg
        className="trend-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Estimated vocabulary trend, currently about ${Math.round(last.vocab_rank)} words`}
      >
        <polygon points={area} className="trend-area" />
        <polyline points={pts.join(" ")} className="trend-line" fill="none" />
        {data.map((d, i) => (
          <circle key={d.day} cx={xOf(i)} cy={yOf(d.vocab_rank)} r="3" className="trend-dot">
            <title>{`${d.day} · ≈${formatRank(d.vocab_rank)} · ${d.known_count} mastered / ${d.saved_count} saved`}</title>
          </circle>
        ))}
        <text x={lastX + 8} y={lastY + 4} className="trend-label">
          ≈{formatRank(last.vocab_rank)}
        </text>
      </svg>
      <div className="bar-axis">
        <span>{data[0].day.slice(5)}</span>
        <span>{last.day.slice(5)}</span>
      </div>
    </>
  );
}

function formatRank(rank: number): string {
  if (rank >= 1000) return `${(rank / 1000).toFixed(1)}k words`;
  return `${Math.round(rank)} words`;
}

function fmtDur(ms: number): string {
  const m = Math.round(ms / 60000);
  if (ms > 0 && m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
