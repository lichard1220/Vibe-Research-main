// 交易纪律 —— 用户自填规则，只存本地 localStorage，不上传、不进仓库。
// 供每日复盘「次日操作准备」注入 AI 上下文，对照执行，不做荐股。

export interface Discipline {
  text: string;
  maxPositionPct: number | null;
  maxDailyLossPct: number | null;
  noChaseLimitUp: boolean;
  respectTpSl: boolean;
  updatedAt: number;
}

const KEY = "vr-discipline";

const DEFAULT_TEXT =
  "1. 不加仓已触及止损带的标的\n" +
  "2. 不追涨停、不逆势重仓\n" +
  "3. 接近自设止盈区间时优先复盘是否减仓\n" +
  "4. 单日回撤触及警戒线后当日不再新开仓";

export function defaultDiscipline(): Discipline {
  return {
    text: DEFAULT_TEXT,
    maxPositionPct: 30,
    maxDailyLossPct: 3,
    noChaseLimitUp: true,
    respectTpSl: true,
    updatedAt: 0,
  };
}

export function loadDiscipline(): Discipline {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultDiscipline();
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return defaultDiscipline();
    const base = defaultDiscipline();
    return {
      text: typeof v.text === "string" && v.text.trim() ? v.text : base.text,
      maxPositionPct: typeof v.maxPositionPct === "number" ? v.maxPositionPct : v.maxPositionPct === null ? null : base.maxPositionPct,
      maxDailyLossPct: typeof v.maxDailyLossPct === "number" ? v.maxDailyLossPct : v.maxDailyLossPct === null ? null : base.maxDailyLossPct,
      noChaseLimitUp: typeof v.noChaseLimitUp === "boolean" ? v.noChaseLimitUp : base.noChaseLimitUp,
      respectTpSl: typeof v.respectTpSl === "boolean" ? v.respectTpSl : base.respectTpSl,
      updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
    };
  } catch {
    return defaultDiscipline();
  }
}

export function saveDiscipline(d: Discipline): Discipline {
  const next: Discipline = { ...d, updatedAt: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等 */
  }
  return next;
}

/** 压成一段注入 AI 的纪律摘要 */
export function formatDiscipline(d: Discipline): string {
  const lines = [
    "【我的交易纪律 · 本地用户自设】",
    d.text.trim() || "（未填写正文）",
  ];
  const structured: string[] = [];
  if (d.maxPositionPct != null) structured.push(`单票仓位上限 ${d.maxPositionPct}%`);
  if (d.maxDailyLossPct != null) structured.push(`单日总回撤警戒 ${d.maxDailyLossPct}%`);
  structured.push(d.noChaseLimitUp ? "不追涨停：是" : "不追涨停：否");
  structured.push(d.respectTpSl ? "严格执行已设止盈止损：是" : "严格执行已设止盈止损：否");
  lines.push(`结构化约束：${structured.join("；")}`);
  return lines.join("\n");
}
