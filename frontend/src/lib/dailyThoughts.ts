// 今日想法 —— 用户当日复盘随笔，按日期存本地，不上传。
// 注入每日复盘 AI 上下文，作为主观看法（与客观行情 / 纪律区分）。

const KEY = "vr-daily-thoughts";

export interface DayThought {
  text: string;
  updatedAt: number;
}

type Store = Record<string, DayThought>;

/** 本地日历日 YYYY-MM-DD（跟系统时区） */
export function todayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Store) : {};
  } catch {
    return {};
  }
}

export function loadThought(date = todayKey()): string {
  const t = loadAll()[date];
  return t && typeof t.text === "string" ? t.text : "";
}

export function saveThought(text: string, date = todayKey()): DayThought {
  const next: DayThought = { text, updatedAt: Date.now() };
  try {
    const all = loadAll();
    if (!text.trim()) delete all[date];
    else all[date] = next;
    // 只保留最近 90 天，避免 localStorage 无限涨
    const keys = Object.keys(all).sort();
    while (keys.length > 90) {
      const oldest = keys.shift();
      if (oldest) delete all[oldest];
    }
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式等 */
  }
  return next;
}

export function formatThought(text: string, date = todayKey()): string {
  const body = text.trim();
  if (!body) return `【今日想法 ${date}】（未填写）`;
  return `【今日想法 ${date} · 用户主观看法】\n${body}`;
}
