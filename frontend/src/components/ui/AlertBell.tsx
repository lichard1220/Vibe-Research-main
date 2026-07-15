import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, CheckCheck, X } from "lucide-react";
import { toast } from "sonner";
import { api, type PortfolioAlert } from "@/lib/api";
import { cn } from "@/lib/utils";

const SEEN_KEY = "vr-alert-seen-ids";
const POLL_MS = 45_000;

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(ids: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* ignore */
  }
}

function notifyBrowser(alert: PortfolioAlert) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("持仓止盈/止损提醒", {
      body: alert.message,
      tag: alert.id,
    });
  } catch {
    /* ignore */
  }
}

function toastAlert(alert: PortfolioAlert) {
  const isSl = alert.kind === "near_sl" || alert.kind === "in_sl_zone";
  const fn = isSl ? toast.error : toast.warning;
  fn(alert.message, { duration: 8000 });
}

/** 顶栏铃铛：轮询后端告警，站内 toast + 可选浏览器通知。 */
export function AlertBell({ collapsed }: { collapsed?: boolean }) {
  const [unread, setUnread] = useState(0);
  const [alerts, setAlerts] = useState<PortfolioAlert[]>([]);
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const seenRef = useRef<Set<string>>(loadSeen());
  const firstPoll = useRef(true);

  const poll = useCallback(async () => {
    try {
      const data = await api.portfolioAlerts();
      setUnread(data.unread);
      setAlerts(data.alerts.slice(0, 20));
      const fresh = data.alerts.filter((a) => !a.read && !seenRef.current.has(a.id));
      if (!firstPoll.current) {
        for (const a of fresh) {
          toastAlert(a);
          notifyBrowser(a);
          seenRef.current.add(a.id);
        }
        if (fresh.length) saveSeen(seenRef.current);
      } else {
        // 首屏：只记已见，不刷屏历史未读
        for (const a of data.alerts) seenRef.current.add(a.id);
        saveSeen(seenRef.current);
        firstPoll.current = false;
      }
    } catch {
      /* 后端未起时静默 */
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  const enableNotify = async () => {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setPerm(p);
    if (p === "granted") toast.success("已开启浏览器通知：触及止盈/止损时会弹出系统气泡");
    else toast.error("未获得通知权限");
  };

  const ackAll = async () => {
    try {
      const data = await api.ackPortfolioAlerts({ all: true });
      setUnread(data.unread);
      setAlerts(data.alerts.slice(0, 20));
      toast.success("已全部标为已读");
    } catch {
      toast.error("标记已读失败");
    }
  };

  return (
    <div className={cn("relative", collapsed && "")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="持仓止盈/止损告警"
        className={cn(
          "relative rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground",
          open && "text-primary",
        )}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" aria-label="关闭" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">止盈/止损告警</p>
              <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              交易时段后台约每分钟检查；关掉看板则无法弹窗。也可在「接入 AI」开浏览器通知。
            </p>
            {perm === "default" && (
              <button
                type="button"
                onClick={enableNotify}
                className="mb-2 w-full rounded-lg border border-primary/30 bg-primary/10 px-2 py-1.5 text-xs text-primary hover:bg-primary/20"
              >
                开启浏览器系统通知
              </button>
            )}
            {unread > 0 && (
              <button
                type="button"
                onClick={ackAll}
                className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                <CheckCheck className="h-3.5 w-3.5" /> 全部标为已读
              </button>
            )}
            <div className="max-h-64 space-y-1.5 overflow-auto">
              {alerts.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground/60">暂无告警</p>
              ) : (
                alerts.map((a) => (
                  <Link
                    key={a.id}
                    to="/portfolio"
                    onClick={() => setOpen(false)}
                    className={cn(
                      "block rounded-lg border px-2.5 py-2 text-xs transition-colors hover:bg-muted/40",
                      a.read ? "border-border/40 opacity-70" : "border-primary/25 bg-primary/5",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span>{a.ts}</span>
                      {!a.read && <span className="text-primary">未读</span>}
                    </div>
                    <p className="mt-0.5 leading-snug text-foreground">{a.message}</p>
                  </Link>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
