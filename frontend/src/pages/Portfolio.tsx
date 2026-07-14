import { useState, useEffect, useCallback, Fragment } from "react";
import { Plus, ShieldCheck, RefreshCw, Loader2, Trash2, AlertCircle, Pencil } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { api, ApiError, type Holding, type HoldingRanges, type PortfolioData, type RangeMode } from "@/lib/api";
import { buildAiContext, FLAG_LABEL, formatRangeSide } from "@/lib/portfolioContext";
import { cn } from "@/lib/utils";

const REFRESH_MS = 30 * 60 * 1000; // 每半小时自动刷新
const pnlColor = (v: number) => (v > 0 ? "text-danger" : v < 0 ? "text-success" : "text-muted-foreground");
const fmt = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const fmtPct = (v: number | null | undefined) => {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v}%`;
};

type RangeForm = {
  tpEnabled: boolean; tpMode: RangeMode; tpLow: string; tpHigh: string;
  slEnabled: boolean; slMode: RangeMode; slLow: string; slHigh: string;
};

const emptyRangeForm = (): RangeForm => ({
  tpEnabled: false, tpMode: "pct", tpLow: "", tpHigh: "",
  slEnabled: false, slMode: "pct", slLow: "", slHigh: "",
});

function rangesFromForm(f: RangeForm): HoldingRanges | undefined {
  const out: HoldingRanges = {};
  if (f.tpEnabled) {
    const lo = parseFloat(f.tpLow), hi = parseFloat(f.tpHigh);
    if (!(Number.isFinite(lo) && Number.isFinite(hi))) return undefined;
    out.tp_mode = f.tpMode; out.tp_low = lo; out.tp_high = hi;
  }
  if (f.slEnabled) {
    const lo = parseFloat(f.slLow), hi = parseFloat(f.slHigh);
    if (!(Number.isFinite(lo) && Number.isFinite(hi))) return undefined;
    out.sl_mode = f.slMode; out.sl_low = lo; out.sl_high = hi;
  }
  if (!f.tpEnabled && !f.slEnabled) return {};
  return out;
}

function formFromHolding(h: Holding): RangeForm {
  return {
    tpEnabled: !!h.tp_mode,
    tpMode: (h.tp_mode as RangeMode) || "pct",
    tpLow: h.tp_low != null ? String(h.tp_low) : "",
    tpHigh: h.tp_high != null ? String(h.tp_high) : "",
    slEnabled: !!h.sl_mode,
    slMode: (h.sl_mode as RangeMode) || "pct",
    slLow: h.sl_low != null ? String(h.sl_low) : "",
    slHigh: h.sl_high != null ? String(h.sl_high) : "",
  };
}

function RangeInputs({
  form, onChange, compact,
}: { form: RangeForm; onChange: (f: RangeForm) => void; compact?: boolean }) {
  const field = "w-20 rounded-lg border border-border bg-black/20 px-2 py-1.5 text-sm outline-none focus:border-primary/50";
  const sel = "rounded-lg border border-border bg-black/20 px-2 py-1.5 text-sm outline-none focus:border-primary/50";
  return (
    <div className={cn("space-y-2", compact ? "mt-2" : "mt-3 border-t border-border/40 pt-3")}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={form.tpEnabled}
            onChange={(e) => onChange({ ...form, tpEnabled: e.target.checked })} />
          止盈区间
        </label>
        {form.tpEnabled && (
          <>
            <select value={form.tpMode} onChange={(e) => onChange({ ...form, tpMode: e.target.value as RangeMode })} className={sel}>
              <option value="pct">相对成本%</option>
              <option value="price">绝对价格</option>
            </select>
            <input value={form.tpLow} onChange={(e) => onChange({ ...form, tpLow: e.target.value.replace(/[^\d.\-]/g, "") })}
              placeholder="下沿" className={field} />
            <span className="text-xs text-muted-foreground">~</span>
            <input value={form.tpHigh} onChange={(e) => onChange({ ...form, tpHigh: e.target.value.replace(/[^\d.\-]/g, "") })}
              placeholder="上沿" className={field} />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={form.slEnabled}
            onChange={(e) => onChange({ ...form, slEnabled: e.target.checked })} />
          止损区间
        </label>
        {form.slEnabled && (
          <>
            <select value={form.slMode} onChange={(e) => onChange({ ...form, slMode: e.target.value as RangeMode })} className={sel}>
              <option value="pct">相对成本%</option>
              <option value="price">绝对价格</option>
            </select>
            <input value={form.slLow} onChange={(e) => onChange({ ...form, slLow: e.target.value.replace(/[^\d.\-]/g, "") })}
              placeholder="下沿" className={field} />
            <span className="text-xs text-muted-foreground">~</span>
            <input value={form.slHigh} onChange={(e) => onChange({ ...form, slHigh: e.target.value.replace(/[^\d.\-]/g, "") })}
              placeholder="上沿" className={field} />
          </>
        )}
      </div>
      {!compact && (
        <p className="text-[11px] text-muted-foreground/60">
          可选。% 模式填相对成本盈亏比（如止盈 15~25，止损 -8~-5）；价格模式填绝对价。两侧可互不相同。
        </p>
      )}
    </div>
  );
}

export function Portfolio() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [code, setCode] = useState("");
  const [shares, setShares] = useState("");
  const [cost, setCost] = useState("");
  const [rangeForm, setRangeForm] = useState<RangeForm>(emptyRangeForm);
  const [adding, setAdding] = useState(false);
  const [editCode, setEditCode] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RangeForm>(emptyRangeForm);
  const [savingRanges, setSavingRanges] = useState(false);
  // 清仓录入
  const [cCode, setCCode] = useState("");
  const [cDate, setCDate] = useState("");
  const [cPrice, setCPrice] = useState("");
  const [cShares, setCShares] = useState("");
  const [cCost, setCCost] = useState("");
  const [closing, setClosing] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setData(manual ? await api.refreshPortfolio() : await api.portfolio());
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const add = async () => {
    if (!/^\d{6}$/.test(code.trim())) { setErr("请输入 6 位股票代码"); return; }
    const s = parseFloat(shares), c = parseFloat(cost);
    if (!(s > 0) || !(c > 0)) { setErr("数量与成本价必须大于 0"); return; }
    if (rangeForm.tpEnabled || rangeForm.slEnabled) {
      const rng = rangesFromForm(rangeForm);
      if (rng === undefined) { setErr("止盈/止损区间请成对填写数字，且下沿≤上沿"); return; }
      if (rangeForm.tpEnabled && (parseFloat(rangeForm.tpLow) > parseFloat(rangeForm.tpHigh))) {
        setErr("止盈下沿不能大于上沿"); return;
      }
      if (rangeForm.slEnabled && (parseFloat(rangeForm.slLow) > parseFloat(rangeForm.slHigh))) {
        setErr("止损下沿不能大于上沿"); return;
      }
    }
    setAdding(true); setErr(null);
    try {
      const ranges = (rangeForm.tpEnabled || rangeForm.slEnabled) ? rangesFromForm(rangeForm) : undefined;
      setData(await api.addHolding(code.trim(), s, c, ranges));
      setCode(""); setShares(""); setCost(""); setRangeForm(emptyRangeForm());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "添加失败");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (c: string) => {
    try { setData(await api.removeHolding(c)); } catch { /* ignore */ }
  };

  const openEdit = (h: Holding) => {
    setEditCode(h.code);
    setEditForm(formFromHolding(h));
  };

  const saveEdit = async () => {
    if (!editCode) return;
    if (editForm.tpEnabled || editForm.slEnabled) {
      if (rangesFromForm(editForm) === undefined) { setErr("止盈/止损区间请成对填写数字"); return; }
      if (editForm.tpEnabled && parseFloat(editForm.tpLow) > parseFloat(editForm.tpHigh)) {
        setErr("止盈下沿不能大于上沿"); return;
      }
      if (editForm.slEnabled && parseFloat(editForm.slLow) > parseFloat(editForm.slHigh)) {
        setErr("止损下沿不能大于上沿"); return;
      }
    }
    setSavingRanges(true); setErr(null);
    try {
      const ranges = rangesFromForm(editForm) ?? {};
      setData(await api.updateHoldingRanges(editCode, ranges));
      setEditCode(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "更新区间失败");
    } finally {
      setSavingRanges(false);
    }
  };

  const addClose = async () => {
    if (!/^\d{6}$/.test(cCode.trim())) { setErr("清仓记录：请输入 6 位代码"); return; }
    const p = parseFloat(cPrice), s = parseFloat(cShares), c = parseFloat(cCost);
    if (!cDate) { setErr("请选清仓日期"); return; }
    if (!(p > 0) || !(s > 0) || !(c > 0)) { setErr("清仓价 / 股数 / 成本必须大于 0"); return; }
    setClosing(true); setErr(null);
    try {
      setData(await api.closePosition(cCode.trim(), cDate, p, s, c));
      setCCode(""); setCDate(""); setCPrice(""); setCShares(""); setCCost("");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "添加清仓记录失败");
    } finally {
      setClosing(false);
    }
  };

  const removeClosed = async (i: number) => {
    try { setData(await api.removeClosed(i)); } catch { /* ignore */ }
  };

  const holdings = data?.holdings || [];
  const totals = data?.totals;
  const closed = data?.closed || [];

  const aiContext = totals
    ? buildAiContext(holdings, totals)
    : "我的持仓：暂无记录。";

  return (
    <div>
      <PageHeader
        title="我的持仓"
        subtitle="自己录、存在本地，实时看浮动盈亏与止盈止损状态"
        actions={
          <div className="flex items-center gap-2">
            {holdings.length > 0 && (
              <AskAiButton context={aiContext} label="让 AI 看我的持仓"
                suggestions={["哪些票短期涨幅已经很大", "对照我的止盈止损区间梳理风险结构", "帮我梳理近5日动能与观察点"]} />
            )}
            <button onClick={() => load(true)} disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              刷新
            </button>
          </div>
        }
      />

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <span>持仓<b className="text-foreground">只存在你本地</b>，不上传、不进仓库。行情每半小时自动刷新，也可手动刷新。止盈/止损是你自己的参数；近5日动能与标记是客观统计。本产品不提供标的、不给买卖建议。</span>
      </div>

      {totals && holdings.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { k: "总市值", v: fmt(totals.market_value), c: "text-foreground" },
            { k: "总成本", v: fmt(totals.cost), c: "text-foreground" },
            { k: "浮动盈亏", v: (totals.pnl > 0 ? "+" : "") + fmt(totals.pnl), c: pnlColor(totals.pnl) },
            { k: "盈亏比例", v: (totals.pnl_pct > 0 ? "+" : "") + totals.pnl_pct + "%", c: pnlColor(totals.pnl) },
          ].map((m) => (
            <GlassCard key={m.k} className="p-3">
              <p className="text-xs text-muted-foreground">{m.k}</p>
              <p className={cn("mt-1 font-mono text-lg font-bold", m.c)}>{m.v}</p>
            </GlassCard>
          ))}
        </div>
      )}

      <GlassCard className="mb-4">
        <h3 className="mb-3 text-sm font-semibold">添加持仓</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">股票代码</label>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位代码"
              className="w-28 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">数量（股）</label>
            <input value={shares} onChange={(e) => setShares(e.target.value.replace(/[^\d.]/g, ""))} placeholder="如 100"
              className="w-28 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">成本价</label>
            <input value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, ""))} placeholder="如 12.5"
              className="w-28 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <button onClick={add} disabled={adding}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 添加
          </button>
        </div>
        <RangeInputs form={rangeForm} onChange={setRangeForm} />
        <p className="mt-2 text-[11px] text-muted-foreground/60">同一代码再次添加会按加权平均成本合并（加仓）；若本次填了区间则覆盖，否则保留原区间。</p>
      </GlassCard>

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      <GlassCard glow>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">持仓明细</h3>
          {data?.updated && <span className="text-xs text-muted-foreground/60">更新于 {data.updated}</span>}
        </div>
        {holdings.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground/60">还没有持仓记录，用上面的表单添加一笔。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["名称", "现价", "今日%", "五日高低", "成本/盈亏", "止盈止损", "标记", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <Fragment key={h.code}>
                    <tr className="border-b border-border/30">
                      <td className="px-2 py-2.5">
                        <span className="font-medium">{h.name}</span>
                        <span className="ml-1.5 font-mono text-xs text-muted-foreground/60">{h.code}</span>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground/60">{fmt(h.shares)}股 · 市值{fmt(h.market_value)}</div>
                      </td>
                      <td className="px-2 py-2.5 font-mono">{fmt(h.price)}</td>
                      <td className={cn("px-2 py-2.5 font-mono", pnlColor(h.change_pct ?? 0))}>{fmtPct(h.change_pct)}</td>
                      <td className="px-2 py-2.5">
                        {h.high5 == null || h.low5 == null ? (
                          <span className="text-muted-foreground/50">—</span>
                        ) : (
                          <>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              高{fmt(h.high5)} / 低{fmt(h.low5)}
                            </div>
                            <div className="font-mono text-[11px]">
                              <span className={pnlColor(h.from_high_pct ?? 0)}>距高{fmtPct(h.from_high_pct)}</span>
                              <span className="text-muted-foreground/40"> · </span>
                              <span className={pnlColor(h.from_low_pct ?? 0)}>距低{fmtPct(h.from_low_pct)}</span>
                            </div>
                            <div className={cn(
                              "text-[10px]",
                              h.bias5 === "up" ? "text-danger" : h.bias5 === "down" ? "text-success" : "text-muted-foreground",
                            )}>
                              {h.bias5 === "up" ? "偏涨" : h.bias5 === "down" ? "偏跌" : h.bias5 === "mid" ? "中性" : "—"}
                              {h.range_pos_pct != null && ` · 区间${h.range_pos_pct}%`}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="font-mono text-muted-foreground">{fmt(h.cost)}</div>
                        <div className={cn("font-mono", pnlColor(h.pnl))}>
                          {h.pnl > 0 ? "+" : ""}{fmt(h.pnl)} ({h.pnl_pct > 0 ? "+" : ""}{h.pnl_pct}%)
                        </div>
                      </td>
                      <td className="px-2 py-2.5 text-xs text-muted-foreground">
                        <div>盈 {formatRangeSide(h.tp_mode, h.tp_low, h.tp_high, h.tp_status)}</div>
                        <div>损 {formatRangeSide(h.sl_mode, h.sl_low, h.sl_high, h.sl_status)}</div>
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {(h.flags || []).length === 0 ? (
                            <span className="text-xs text-muted-foreground/50">—</span>
                          ) : (h.flags || []).map((f) => (
                            <span key={f} className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {FLAG_LABEL[f] || f}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center gap-2">
                          <button onClick={() => openEdit(h)} className="text-muted-foreground/50 hover:text-primary" title="编辑区间">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => remove(h.code)} className="text-muted-foreground/50 hover:text-destructive" title="删除">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {editCode === h.code && (
                      <tr className="border-b border-border/30 bg-black/10">
                        <td colSpan={8} className="px-3 py-3">
                          <p className="mb-1 text-xs font-medium text-foreground">编辑 {h.name} 止盈/止损</p>
                          <RangeInputs form={editForm} onChange={setEditForm} compact />
                          <div className="mt-2 flex gap-2">
                            <button onClick={saveEdit} disabled={savingRanges}
                              className="rounded-lg bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50">
                              {savingRanges ? "保存中…" : "保存区间"}
                            </button>
                            <button onClick={() => setEditCode(null)}
                              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                              取消
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <GlassCard className="mb-4 mt-6">
        <h3 className="mb-3 text-sm font-semibold">添加清仓记录</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">股票代码</label>
            <input value={cCode} onChange={(e) => setCCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位代码"
              className="w-24 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">清仓日期</label>
            <input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)}
              className="rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">清仓价</label>
            <input value={cPrice} onChange={(e) => setCPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="卖出价"
              className="w-24 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">股数</label>
            <input value={cShares} onChange={(e) => setCShares(e.target.value.replace(/[^\d.]/g, ""))} placeholder="如 100"
              className="w-24 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">买入成本</label>
            <input value={cCost} onChange={(e) => setCCost(e.target.value.replace(/[^\d.]/g, ""))} placeholder="成本价"
              className="w-24 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50" />
          </div>
          <button onClick={addClose} disabled={closing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
            {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} 记录
          </button>
        </div>
      </GlassCard>

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">已清仓</h3>
        {closed.length > 0 && data && (
          <span className="text-sm">
            已实现盈亏合计 <b className={cn("font-mono", pnlColor(data.realized_pnl))}>{data.realized_pnl > 0 ? "+" : ""}{fmt(data.realized_pnl)}</b>
          </span>
        )}
      </div>
      <GlassCard>
        {closed.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground/60">还没有清仓记录。卖出后在上面记一笔，作为已实现盈亏的历史。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["名称", "清仓日期", "清仓价", "股数", "成本", "已实现盈亏", "盈亏%", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closed.map((c, i) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="px-2 py-2.5">
                      <span className="font-medium">{c.name}</span>
                      <span className="ml-1.5 font-mono text-xs text-muted-foreground/60">{c.code}</span>
                    </td>
                    <td className="px-2 py-2.5 font-mono text-muted-foreground">{c.date}</td>
                    <td className="px-2 py-2.5 font-mono">{fmt(c.price)}</td>
                    <td className="px-2 py-2.5 font-mono text-muted-foreground">{fmt(c.shares)}</td>
                    <td className="px-2 py-2.5 font-mono text-muted-foreground">{fmt(c.cost)}</td>
                    <td className={cn("px-2 py-2.5 font-mono", pnlColor(c.pnl))}>{c.pnl > 0 ? "+" : ""}{fmt(c.pnl)}</td>
                    <td className={cn("px-2 py-2.5 font-mono", pnlColor(c.pnl))}>{c.pnl_pct > 0 ? "+" : ""}{c.pnl_pct}%</td>
                    <td className="px-2 py-2.5">
                      <button onClick={() => removeClosed(i)} className="text-muted-foreground/50 hover:text-destructive" title="删除">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <Disclaimer />
    </div>
  );
}
