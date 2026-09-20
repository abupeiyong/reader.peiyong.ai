// 专注提醒:读着读着走神(切走页面 / 长时间没动作)时弹出,
// 告诉今天已经读了多久、离当日目标还差多少,催一句继续读。
import { Icon } from "./Icon";

export default function FocusNudge({
  todayMs,
  goalMs,
  onDismiss,
}: {
  todayMs: number;
  goalMs: number;
  onDismiss: () => void;
}) {
  const left = Math.max(0, goalMs - todayMs);
  const pct = goalMs > 0 ? Math.min(100, Math.round((todayMs / goalMs) * 100)) : 0;
  return (
    <div className="focus-nudge" role="status">
      <div className="fn-head">
        <Icon name="clock" size={15} />
        <b>Still with the book?</b>
        <button className="icon-btn" title="Dismiss" onClick={onDismiss}><Icon name="x" /></button>
      </div>
      <p className="fn-line">
        You've read <b>{fmtSpan(todayMs)}</b> today.
      </p>
      <p className="fn-line">
        {left > 0 ? (
          <>
            <b>{fmtSpan(left)}</b> left to your {fmtSpan(goalMs)} goal — keep going.
          </>
        ) : (
          <>Today's {fmtSpan(goalMs)} goal is done. Every extra page is a bonus.</>
        )}
      </p>
      <div className="fn-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <button className="btn btn-primary btn-sm fn-btn" onClick={onDismiss}>
        Back to reading
      </button>
    </div>
  );
}

/** 时长人话:1h 12m / 12m / <1m */
export function fmtSpan(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "<1m";
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
}
