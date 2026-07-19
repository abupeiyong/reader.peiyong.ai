import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { CalendarData, CalendarDay } from "../../shared/types";
import { Icon } from "./Icon";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDur(ms: number): string {
  if (ms <= 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function CalendarPanel({ refreshNonce }: { refreshNonce: number }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() }; // month 0-11
  });
  const [data, setData] = useState<CalendarData["days"]>({});
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    // 该月本地起止 → UTC ms
    const start = new Date(cursor.year, cursor.month, 1, 0, 0, 0, 0).getTime();
    const end = new Date(cursor.year, cursor.month + 1, 1, 0, 0, 0, 0).getTime() - 1;
    const tzoff = new Date().getTimezoneOffset();
    api
      .get<CalendarData>(`/api/calendar?start=${start}&end=${end}&tzoff=${tzoff}`)
      .then((r) => setData(r.days))
      .catch(() => setData({}));
    // 当前月默认选中今天,其他月清空选择
    const today = new Date();
    setSelected(cursor.year === today.getFullYear() && cursor.month === today.getMonth() ? ymd(today) : null);
  }, [cursor, refreshNonce]);

  // 网格:该月第一天所在周日 → 覆盖到月末
  const cells = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    const startDay = first.getDay(); // 0=Sun
    const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < startDay; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(cursor.year, cursor.month, d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cursor]);

  const todayKey = ymd(new Date());
  const detail: CalendarDay | null = selected ? data[selected] ?? { read_ms: 0, books: [], words: [], notes: [], sessions: [] } : null;

  const shift = (delta: number) => {
    const m = cursor.month + delta;
    setCursor({ year: cursor.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 });
  };

  return (
    <div className="cal-panel">
      <div className="cal-head">
        <div className="cal-title">Reading calendar</div>
        <div className="cal-nav">
          <button className="icon-btn" onClick={() => shift(-1)}><Icon name="chevron-left" /></button>
          <span className="cal-month">{MONTHS[cursor.month]} {cursor.year}</span>
          <button className="icon-btn" onClick={() => shift(1)}><Icon name="chevron-right" /></button>
        </div>
      </div>

      <div className="cal-body">
        <div className="cal-left">
          <div className="cal-grid">
            {WEEKDAYS.map((w) => (
              <div key={w} className="cal-wd">{w}</div>
            ))}
            {cells.map((d, i) => {
              if (!d) return <div key={i} className="cal-cell empty" />;
              const key = ymd(d);
              const day = data[key];
              const has = day && (day.books.length || day.words.length || day.notes.length || day.read_ms > 0);
              return (
                <button
                  key={i}
                  className={`cal-cell ${key === todayKey ? "today" : ""} ${selected === key ? "sel" : ""} ${has ? "has" : ""}`}
                  onClick={() => setSelected(key)}
                >
                  <span className="cal-num">{d.getDate()}</span>
                  {has && (
                    <span className="cal-dots">
                      {day!.books.length > 0 && <i className="dot book" title={`${day!.books.length} book(s)`} />}
                      {day!.words.length > 0 && <i className="dot word" title={`${day!.words.length} word(s)`} />}
                      {day!.notes.length > 0 && <i className="dot note" title={`${day!.notes.length} note(s)`} />}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="cal-legend">
            <span><i className="dot book" /> Books</span>
            <span><i className="dot word" /> Words</span>
            <span><i className="dot note" /> Notes</span>
          </div>
        </div>

        <div className="cal-detail">
          {!detail && <div className="cal-empty">Select a day to see its activity.</div>}
          {detail && (
            <>
              <div className="cal-detail-date">{new Date(selected! + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
              <div className="cal-summary">
                <span><Icon name="clock" size={13} /> {detail.read_ms > 0 ? fmtDur(detail.read_ms) + " reading" : "No reading time"}</span>
                <span><Icon name="bookmark" size={13} /> {detail.words.length} word{detail.words.length === 1 ? "" : "s"}</span>
              </div>
              {detail.books.length === 0 && detail.words.length === 0 && detail.notes.length === 0 && detail.read_ms === 0 && (
                <div className="cal-empty">Nothing recorded this day.</div>
              )}
              {detail.sessions.length > 0 && (
                <div className="cal-sec">
                  <h5><Icon name="clock" size={14} /> Reading sessions ({detail.sessions.length})</h5>
                  {detail.sessions.map((s, j) => (
                    <div key={j} className="cal-session">
                      <span className="cal-sess-time">
                        {fmtTime(s.started_at)} – {s.ended_at ? fmtTime(s.ended_at) : "…"}
                      </span>
                      <span className="cal-sess-dur">{fmtDur(s.active_ms)}</span>
                      <span className="cal-sess-pauses">
                        {s.pauses > 0 ? `${s.pauses} pause${s.pauses === 1 ? "" : "s"}` : "no pauses"}
                      </span>
                      {s.book_title && (
                        <span className="cal-sess-book" onClick={() => (location.hash = `#/read/${s.book_id}`)}>
                          {s.book_title}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {detail.books.length > 0 && (
                <div className="cal-sec">
                  <h5><Icon name="book" size={14} /> Read</h5>
                  {detail.books.map((b) => (
                    <div key={b.id} className="cal-book" onClick={() => (location.hash = `#/read/${b.id}`)}>{b.title}</div>
                  ))}
                </div>
              )}
              {detail.words.length > 0 && (
                <div className="cal-sec">
                  <h5><Icon name="bookmark" size={14} /> Words &amp; phrases ({detail.words.length})</h5>
                  {detail.words.map((w, j) => (
                    <div key={j} className="cal-word">
                      <b>{w.word}</b>{w.meaning && <span> — {w.meaning}</span>}
                      {w.sentence && <div className="cal-word-sent">“{w.sentence}”</div>}
                    </div>
                  ))}
                </div>
              )}
              {detail.notes.length > 0 && (
                <div className="cal-sec">
                  <h5><Icon name="message" size={14} /> Notes ({detail.notes.length})</h5>
                  {detail.notes.map((n, j) => (
                    <div key={j} className="cal-note">
                      {n.quote && <div className="cal-note-quote">“{n.quote}”</div>}
                      <div className="cal-note-body">{n.note}{n.page_no != null && <span className="wp-small"> · p.{n.page_no}</span>}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
