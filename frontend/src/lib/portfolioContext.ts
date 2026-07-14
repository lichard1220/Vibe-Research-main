// 持仓 → AI 上下文摘要（Portfolio / DailyReview 共用）

import type { Holding, PortfolioData } from "@/lib/api";

export const FLAG_LABEL: Record<string, string> = {
  near_tp: "近止盈",
  near_sl: "近止损",
  in_tp_zone: "止盈带内",
  in_sl_zone: "止损带内",
  strong_run: "短期走强",
  extended_run: "短期大涨",
  deep_pullback: "高位回撤",
  bias_up: "五日偏涨",
  bias_down: "五日偏跌",
  bias_mid: "五日中性",
  near_5d_high: "贴五日高",
  near_5d_low: "贴五日低",
};

const STATUS_LABEL: Record<string, string> = {
  unset: "未设",
  below: "未及",
  in_zone: "区间内",
  above: "已过",
};

const BIAS_LABEL: Record<string, string> = {
  up: "偏涨",
  down: "偏跌",
  mid: "中性",
  unset: "未判",
};

const fmtPct = (v: number | null | undefined) => {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v}%`;
};

export function formatRangeSide(
  mode?: string | null,
  low?: number | null,
  high?: number | null,
  status?: string,
) {
  if (!mode || low == null || high == null) return "未设";
  const unit = mode === "pct" ? "%" : "";
  const label = STATUS_LABEL[status || "unset"] || status;
  return `${low}${unit}~${high}${unit}（${label}）`;
}

export function buildAiContext(holdings: Holding[], totals: PortfolioData["totals"]): string {
  if (!holdings.length) {
    return "我的持仓：暂无记录。";
  }
  const lines = holdings.map((h) => {
    const daily = (h.daily_changes || [])
      .map((d) => `${d.date}:${d.change_pct > 0 ? "+" : ""}${d.change_pct}%`)
      .join("、") || "无";
    const flags = (h.flags || []).map((f) => FLAG_LABEL[f] || f).join("、") || "无";
    const bias = BIAS_LABEL[h.bias5 || "unset"] || h.bias5;
    return [
      `${h.name}(${h.code}) ${h.shares}股 成本${h.cost} 现价${h.price}`,
      `浮盈${h.pnl}(${h.pnl_pct}%) 今日${fmtPct(h.change_pct)}`,
      `近5日高低:高${h.high5 ?? "—"}/低${h.low5 ?? "—"} 距高${fmtPct(h.from_high_pct)} 距低${fmtPct(h.from_low_pct)} 区间位置${h.range_pos_pct ?? "—"}% 判定:${bias}(偏向分${fmtPct(h.chg5)})`,
      `止盈:${formatRangeSide(h.tp_mode, h.tp_low, h.tp_high, h.tp_status)} 止损:${formatRangeSide(h.sl_mode, h.sl_low, h.sl_high, h.sl_status)}`,
      `近5日逐日:[${daily}] 连涨${h.up_days ?? 0}日 标记:[${flags}]`,
    ].join(" | ");
  });
  return (
    `我的持仓（本地数据，用户自设区间 + 客观行情统计）：\n` +
    lines.join("\n") +
    `\n汇总：市值${totals.market_value} 总浮盈${totals.pnl}(${totals.pnl_pct}%)` +
    `\n说明：近5日判定=现价对照近5个交易日盘内最高/最低（自低点涨幅 vs 自高点回撤）；请勿给出买入/卖出指令或目标价，可协助梳理风险结构与观察点。`
  );
}
