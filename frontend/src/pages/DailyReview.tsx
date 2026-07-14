import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Loader2, AlertCircle, RefreshCw, Gauge, ArrowDownUp, TrendingUp, TrendingDown, Plus, X, Flame, BarChart3, Globe, ListChecks, PenLine } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { AskAiButton } from "@/components/ui/AskAiButton";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { api, ApiError, type IndexQuote, type Quote, type MarketOverview, type ShortTermEmotion, type TurnoverTop, type GlobalIndex, type PortfolioData } from "@/lib/api";
import { hasLlm, chatStream } from "@/lib/llm";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { loadWatch, saveWatch } from "@/lib/watchlist";
import { type Discipline, formatDiscipline, loadDiscipline, saveDiscipline } from "@/lib/discipline";
import { formatThought, loadThought, saveThought, todayKey } from "@/lib/dailyThoughts";
import { buildAiContext } from "@/lib/portfolioContext";
import { cn } from "@/lib/utils";

// A股红涨绿跌。全球市场（美股/港股指数）**也沿用红涨**——与整个看板及东财等中国平台一致，
// 对中国用户最不易看错（Simon 2026-07-05 确认；非国际绿涨惯例，是有意选择，勿改）。
const pctColor = (p: number) => (p > 0 ? "text-danger" : p < 0 ? "text-success" : "text-muted-foreground");
const fmt = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const yi = (v: number | null) => (v == null ? "—" : `${fmt(v / 1e8)} 亿`); // 元 → 亿

type AiMode = "review" | "prep" | null;

const COMPLIANCE =
  "只做客观陈述与对照用户纪律的多视角梳理；不预测涨跌、不推荐未持仓标的、不给具体买卖点位与「你应该买卖」的指令口吻，不构成投资建议。";

export function DailyReview() {
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [idxErr, setIdxErr] = useState(false);
  const [review, setReview] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [aiMode, setAiMode] = useState<AiMode>(null);
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [emotion, setEmotion] = useState<ShortTermEmotion | null>(null);
  const [turnover, setTurnover] = useState<TurnoverTop | null>(null);
  const [globalIdx, setGlobalIdx] = useState<GlobalIndex[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [portfolioErr, setPortfolioErr] = useState(false);
  // 关注股票（自选，存本地）
  const [watchCodes, setWatchCodes] = useState<string[]>(loadWatch);
  const [watchQuotes, setWatchQuotes] = useState<Record<string, Quote>>({});
  const [watchInput, setWatchInput] = useState("");
  const [watchLoading, setWatchLoading] = useState(false);
  const [discipline, setDiscipline] = useState<Discipline>(() => loadDiscipline());
  const [discSavedHint, setDiscSavedHint] = useState(false);
  const thoughtDate = todayKey();
  const [thought, setThought] = useState(() => loadThought(thoughtDate));
  const [thoughtSavedHint, setThoughtSavedHint] = useState(false);

  // 各数据块请求是否已结束：区分「加载中」与「数据源暂不可用」（非交易时段/被限流时后端返回空）
  const [ovDone, setOvDone] = useState(false);
  const [emoDone, setEmoDone] = useState(false);
  const [toDone, setToDone] = useState(false);

  const loadIndices = () => {
    api.indices().then(setIndices).catch(() => setIdxErr(true));
    api.globalIndices().then(setGlobalIdx).catch(() => {});
    api.marketOverview().then(setOverview).catch(() => {}).finally(() => setOvDone(true));
    api.emotion().then(setEmotion).catch(() => {}).finally(() => setEmoDone(true));
    api.turnoverTop().then(setTurnover).catch(() => {}).finally(() => setToDone(true));
  };

  const loadPortfolio = () => {
    api.portfolio()
      .then((d) => { setPortfolio(d); setPortfolioErr(false); })
      .catch(() => { setPortfolio(null); setPortfolioErr(true); });
  };

  // 数据块占位：请求没回来 = 加载中；回来了但为空 = 数据源暂不可用（别让用户干等）
  const pending = (done: boolean) => (
    <p className="py-4 text-center text-sm text-muted-foreground/60">
      {done ? "暂无数据：可能是非交易时段或数据源暂时不可用，可点「大盘指数」旁的刷新重试" : "加载中…"}
    </p>
  );

  const refreshWatch = (codes: string[]) => {
    if (!codes.length) { setWatchQuotes({}); return; }
    setWatchLoading(true);
    api.quote(codes.join(",")).then(setWatchQuotes).catch(() => {}).finally(() => setWatchLoading(false));
  };

  useEffect(() => {
    loadIndices();
    loadPortfolio();
    refreshWatch(loadWatch());
  }, []);

  const addWatch = () => {
    const c = watchInput.trim();
    if (!/^\d{6}$/.test(c) || watchCodes.includes(c)) { setWatchInput(""); return; }
    const next = [...watchCodes, c];
    setWatchCodes(next); saveWatch(next); setWatchInput(""); refreshWatch(next);
  };

  const removeWatch = (c: string) => {
    const next = watchCodes.filter((x) => x !== c);
    setWatchCodes(next); saveWatch(next); refreshWatch(next);
  };

  const persistDiscipline = (next: Discipline) => {
    const saved = saveDiscipline(next);
    setDiscipline(saved);
    setDiscSavedHint(true);
    window.setTimeout(() => setDiscSavedHint(false), 1500);
  };

  const persistThought = (text: string) => {
    setThought(text);
    saveThought(text, thoughtDate);
    setThoughtSavedHint(true);
    window.setTimeout(() => setThoughtSavedHint(false), 1500);
  };

  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

  const richContext = useMemo(() => {
    const indexLine = indices.length
      ? indices.map((i) => `${i.name} ${i.price}（${i.change_pct > 0 ? "+" : ""}${i.change_pct}%）`).join("；")
      : "（指数数据未取到）";

    const s = overview?.sentiment;
    const sentLine = s
      ? `宽度${s.breadth || "—"} 投机${s.speculation || "—"} 涨/跌/平 ${s.up}/${s.down}/${s.flat} 涨停${s.zt}(真${s.zt_real}) 跌停${s.dt}(真${s.dt_real}) 活跃度${s.active}`
      : "（市场情绪未取到）";

    const e = emotion;
    const emoLine = e && e.zt_count !== undefined
      ? `涨停${e.zt_count} 跌停${e.dt_count} 炸板${e.zb_count} 最高连板${e.max_boards} 封板率${e.seal_rate ?? "—"} 炸板率${e.break_rate ?? "—"} 晋级率${e.promotion_rate ?? "—"}`
      : "（短线情绪未取到）";

    const secs = overview?.sectors || [];
    const byNet = [...secs].sort((a, b) => b.net - a.net);
    const topIn = byNet.slice(0, 5).map((x) => `${x.name}:${fmt(x.net)}`).join("、") || "无";
    const topOut = [...byNet].reverse().slice(0, 5).map((x) => `${x.name}:${fmt(x.net)}`).join("、") || "无";

    const pfBlock = portfolioErr
      ? "我的持仓：读取失败（不影响其它数据）。"
      : portfolio
        ? buildAiContext(portfolio.holdings, portfolio.totals)
        : "我的持仓：尚未加载。";

    const watchLine = watchCodes.length
      ? watchCodes.map((c) => {
          const q = watchQuotes[c];
          return q
            ? `${q.name || c}(${c}) ${q.price}（${q.change_pct > 0 ? "+" : ""}${q.change_pct}%）`
            : c;
        }).join("；")
      : "（无自选）";

    return [
      formatDiscipline(discipline),
      "",
      formatThought(thought, thoughtDate),
      "",
      "【市场状态 · 客观公开数据摘要】",
      `指数：${indexLine}`,
      `情绪：${sentLine}`,
      `短线：${emoLine}`,
      `板块净流入Top5：${topIn}`,
      `板块净流出Top5：${topOut}`,
      "",
      pfBlock,
      "",
      `【自选关注】${watchLine}`,
      "",
      "说明：纪律与今日想法为用户自设/主观看法；行情与持仓标记为客观统计。请勿给出买入/卖出指令或目标价。",
    ].join("\n");
  }, [indices, overview, emotion, portfolio, portfolioErr, watchCodes, watchQuotes, discipline, thought, thoughtDate]);

  const runAi = async (mode: "review" | "prep") => {
    setReviewErr(null);
    setNeedConfig(false);
    if (!hasLlm()) { setNeedConfig(true); return; }
    // 落盘最新想法，避免未失焦就点 AI
    saveThought(thought, thoughtDate);
    setReviewLoading(true);
    setReview("");
    setAiMode(mode);
    const prompt = mode === "review"
      ? (
          "请根据下方「上下文数据」用中文做当天复盘：\n" +
          "1) 整体涨跌与主要指数\n" +
          "2) 市场情绪与短线情绪要点\n" +
          "3) 板块资金冷热\n" +
          "4) 持仓与纪律相关的客观现象（只描述状态与标记，不下指令）\n" +
          "5) 若有「今日想法」，可对照客观数据做呼应或补充视角（标明哪些是用户主观看法）\n\n" +
          COMPLIANCE
        )
      : (
          "请根据下方「上下文数据」输出【次日操作准备】（对照用户自设纪律与今日想法，条件式检查清单）：\n" +
          "1) 今日状态与纪律有无冲突点（只点出事实与规则对照）\n" +
          "2) 对各持仓：对照止盈/止损区间与动能标记，用「若…则按你的纪律…」写观察项\n" +
          "3) 结合用户「今日想法」里的关注点，列明日开盘前后检查清单\n" +
          "4) 不为未持仓票荐买；不给具体目标价；避免「你应该卖/买」指令口吻\n\n" +
          COMPLIANCE
        );
    try {
      await chatStream([{ role: "user", content: prompt }], richContext, {
        onDelta: (t) => setReview((r) => r + t),
      });
    } catch (e) {
      setReviewErr(e instanceof ApiError ? e.message : mode === "prep" ? "次日准备失败" : "复盘失败");
    } finally {
      setReviewLoading(false);
    }
  };

  const sentiment = overview?.sentiment;
  const sectors = overview?.sectors || [];
  const sentCells = sentiment ? [
    { k: "上涨家数", v: sentiment.up, up: true },
    { k: "下跌家数", v: sentiment.down, up: false },
    { k: "平盘", v: sentiment.flat, up: null },
    { k: "涨停", v: sentiment.zt, up: true },
    { k: "真实涨停", v: sentiment.zt_real, up: true },
    { k: "跌停", v: sentiment.dt, up: false },
    { k: "真实跌停", v: sentiment.dt_real, up: false },
    { k: "活跃度", v: sentiment.active, up: null },
  ] : [];

  const noteKind = aiMode === "prep" ? "次日准备" : "复盘";
  const noteTitle = aiMode === "prep" ? `次日操作准备 ${today}` : `每日复盘 ${today}`;

  return (
    <div>
      <PageHeader
        title="每日复盘"
        subtitle={`${today} · 想法 / 纪律 / 持仓 / 大盘，交给你的 AI 做复盘与次日准备`}
        actions={
          <AskAiButton
            context={richContext}
            label="问 AI"
            suggestions={[
              "今天大盘怎么走",
              "对照我今天的想法梳理风险点",
              "按我的纪律对照持仓做次日观察清单",
            ]}
          />
        }
      />

      {/* 1. 大盘指数（实时） */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">大盘指数</h3>
        <button onClick={loadIndices} className="text-muted-foreground hover:text-primary" title="刷新"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {indices.length === 0
          ? [1, 2, 3, 4].map((i) => (
              <GlassCard key={i} className="p-3">
                <p className="text-xs text-muted-foreground">{idxErr ? "行情未接通" : "加载中…"}</p>
                <p className="mt-1 font-mono text-lg font-bold text-muted-foreground/40">—</p>
              </GlassCard>
            ))
          : indices.map((i) => (
              <GlassCard key={i.name} className="p-3">
                <p className="truncate text-xs text-muted-foreground">{i.name}</p>
                <p className={cn("mt-1 font-mono text-lg font-bold", pctColor(i.change_pct))}>{i.price}</p>
                <p className={cn("text-xs", pctColor(i.change_pct))}>{i.change_pct > 0 ? "+" : ""}{i.change_pct}%</p>
              </GlassCard>
            ))}
      </div>

      {/* 1b. 全球市场（隔夜外围脸色：A 股常看美股 / 港股） */}
      {globalIdx.length > 0 && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Globe className="h-4 w-4" /> 全球市场</h3>
            <span className="text-[11px] text-muted-foreground/50">隔夜外围 · 美股 / 港股 / 韩股</span>
          </div>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {globalIdx.map((g) => (
              <GlassCard key={g.key} className="p-3">
                <p className="truncate text-xs text-muted-foreground">{g.name} <span className="text-muted-foreground/40">{g.region}</span></p>
                <p className={cn("mt-1 font-mono text-lg font-bold", g.change_pct == null ? "text-foreground" : pctColor(g.change_pct))}>{g.price ?? "—"}</p>
                <p className={cn("text-xs", g.change_pct == null ? "text-muted-foreground" : pctColor(g.change_pct))}>
                  {g.change_pct == null ? "—" : `${g.change_pct > 0 ? "+" : ""}${g.change_pct}%`}
                </p>
              </GlassCard>
            ))}
          </div>
        </>
      )}

      {/* 2. 关注股票（自选） */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">关注股票</h3>
        {watchCodes.length > 0 && (
          <button onClick={() => refreshWatch(watchCodes)} className="text-muted-foreground hover:text-primary" title="刷新价格">
            {watchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <GlassCard className="mb-6">
        <div className="mb-3 flex gap-2">
          <input
            value={watchInput}
            onChange={(e) => setWatchInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(e) => e.key === "Enter" && addWatch()}
            placeholder="加自选：6 位股票代码"
            className="w-44 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
          <button onClick={addWatch}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25">
            <Plus className="h-4 w-4" /> 增加
          </button>
        </div>
        {watchCodes.length === 0 ? (
          <p className="text-sm text-muted-foreground/60">加上你关注的股票，随时看它们的实时价格与涨跌。数据存本地，不上传。</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {watchCodes.map((c) => {
              const q = watchQuotes[c];
              return (
                <div key={c} className="group relative rounded-lg bg-muted/25 p-3">
                  <button onClick={() => removeWatch(c)} title="移除"
                    className="absolute right-1.5 top-1.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100">
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <p className="truncate text-xs text-muted-foreground">{q?.name || c}</p>
                  <p className={cn("mt-1 font-mono text-lg font-bold", q ? pctColor(q.change_pct) : "text-muted-foreground/40")}>{q ? q.price : "—"}</p>
                  <p className={cn("text-xs", q ? pctColor(q.change_pct) : "text-muted-foreground/40")}>
                    {q ? `${q.change_pct > 0 ? "+" : ""}${q.change_pct}%` : c}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </GlassCard>

      {/* 2b. 今日想法（本地，按日） */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
          <PenLine className="h-4 w-4" /> 今日想法
        </h3>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
          <span>{thoughtDate}</span>
          {thoughtSavedHint && <span className="text-success">已保存</span>}
        </div>
      </div>
      <GlassCard className="mb-6">
        <p className="mb-3 text-xs text-muted-foreground">
          记下今天对盘面、持仓、情绪的主观看法。只存本地、按日归档；AI 复盘 / 次日准备会一并参考，并与客观数据区分开。
        </p>
        <textarea
          value={thought}
          onChange={(e) => setThought(e.target.value)}
          onBlur={(e) => persistThought(e.target.value)}
          rows={4}
          placeholder="例如：今天犹豫要不要减仓某某、感觉情绪过热、某板块资金回流但纪律要求不追高等…"
          className="w-full rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={() => persistThought(thought)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            保存想法
          </button>
        </div>
      </GlassCard>

      {/* 2c. 我的交易纪律（本地） */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
          <ListChecks className="h-4 w-4" /> 我的交易纪律
        </h3>
        {discSavedHint && <span className="text-[11px] text-success">已保存到本地</span>}
      </div>
      <GlassCard className="mb-6">
        <p className="mb-3 text-xs text-muted-foreground">
          纪律只存在你浏览器本地。AI「次日操作准备」会对照这里的规则与持仓状态出检查清单，<b className="text-foreground">不荐股、不下指令</b>。
        </p>
        <textarea
          value={discipline.text}
          onChange={(e) => setDiscipline({ ...discipline, text: e.target.value })}
          onBlur={(e) => persistDiscipline({ ...discipline, text: e.target.value })}
          rows={5}
          placeholder="写下你的交易纪律…"
          className="w-full rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
        />
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">单票仓位上限 %</label>
            <input
              value={discipline.maxPositionPct ?? ""}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, "");
                const next = { ...discipline, maxPositionPct: v === "" ? null : parseFloat(v) };
                setDiscipline(next);
              }}
              onBlur={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, "");
                persistDiscipline({ ...discipline, maxPositionPct: v === "" ? null : parseFloat(v) });
              }}
              className="w-24 rounded-lg border border-border bg-black/20 px-2 py-1.5 text-sm outline-none focus:border-primary/50"
              placeholder="如 30"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">单日回撤警戒 %</label>
            <input
              value={discipline.maxDailyLossPct ?? ""}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, "");
                setDiscipline({ ...discipline, maxDailyLossPct: v === "" ? null : parseFloat(v) });
              }}
              onBlur={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, "");
                persistDiscipline({ ...discipline, maxDailyLossPct: v === "" ? null : parseFloat(v) });
              }}
              className="w-24 rounded-lg border border-border bg-black/20 px-2 py-1.5 text-sm outline-none focus:border-primary/50"
              placeholder="如 3"
            />
          </div>
          <label className="flex items-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={discipline.noChaseLimitUp}
              onChange={(e) => persistDiscipline({ ...discipline, noChaseLimitUp: e.target.checked })}
            />
            不追涨停
          </label>
          <label className="flex items-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={discipline.respectTpSl}
              onChange={(e) => persistDiscipline({ ...discipline, respectTpSl: e.target.checked })}
            />
            严格执行已设止盈止损
          </label>
          <button
            onClick={() => persistDiscipline(discipline)}
            className="ml-auto rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            保存纪律
          </button>
        </div>
        {portfolioErr && (
          <p className="mt-2 text-[11px] text-muted-foreground/70">持仓未能加载，次日准备仍可运行，但不会注入持仓明细。</p>
        )}
        {!portfolioErr && portfolio && (
          <p className="mt-2 text-[11px] text-muted-foreground/60">
            已接入持仓 {portfolio.holdings.length} 只
            {portfolio.holdings.length > 0 && ` · 总浮盈 ${portfolio.totals.pnl_pct}%`}
            ，可与纪律一并注入 AI。
          </p>
        )}
      </GlassCard>

      {/* 3. AI 当日复盘 / 次日操作准备 */}
      <GlassCard glow className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-1.5 font-semibold">
              <Sparkles className="h-4 w-4 text-primary" /> AI 复盘与次日准备
            </h3>
            {aiMode && (
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                本次输出：{aiMode === "prep" ? "次日操作准备" : "当日复盘"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => runAi("review")} disabled={reviewLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
              {reviewLoading && aiMode === "review" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              让 AI 复盘今天
            </button>
            <button onClick={() => runAi("prep")} disabled={reviewLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50">
              {reviewLoading && aiMode === "prep" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
              次日操作准备
            </button>
          </div>
        </div>
        {needConfig && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-muted-foreground">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
            还没接入 AI。<Link to="/settings" className="text-primary">先去接入你的 AI</Link>，之后一键出复盘/次日准备。
          </div>
        )}
        {reviewErr && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {reviewErr}
          </div>
        )}
        {review ? (
          <>
            <div className="prose prose-sm prose-invert mt-4 max-w-none text-foreground"><ReactMarkdown remarkPlugins={[remarkGfm]}>{review}</ReactMarkdown></div>
            {!reviewLoading && (
              <div className="mt-3">
                <SaveNoteButton kind={noteKind} title={noteTitle} content={review} />
              </div>
            )}
          </>
        ) : !needConfig && !reviewErr && !reviewLoading ? (
          <p className="mt-3 text-sm text-muted-foreground">
            系统会把你的<b className="text-foreground">今日想法</b>、<b className="text-foreground">交易纪律</b>、<b className="text-foreground">持仓状态</b>和<b className="text-foreground">市场摘要</b>打包给你的 AI。
            「复盘」看今天；「次日操作准备」出对照纪律的条件式检查清单。<b className="text-foreground">分析是它给的，我们只负责喂数据。</b>
          </p>
        ) : null}
      </GlassCard>

      {/* 4. 市场情绪 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Gauge className="h-4 w-4" /> 市场情绪</h3>
        {sentiment?.date && <span className="text-[11px] text-muted-foreground/50">{sentiment.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!sentiment?.breadth ? (
          pending(ovDone)
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { k: "大盘宽度", v: sentiment.breadth, hint: "冰点 / 偏弱 / 中性 / 偏强 / 普涨" },
                { k: "题材投机", v: sentiment.speculation, hint: "冰点 / 普通 / 活跃 / 亢奋" },
              ].map((m) => (
                <div key={m.k} className="rounded-lg bg-muted/25 p-4">
                  <p className="text-xs text-muted-foreground">{m.k}</p>
                  <p className="mt-1 text-2xl font-bold text-primary">{m.v}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground/60">{m.hint}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {sentCells.map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/20 p-2 text-center">
                  <p className="truncate text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-sm font-bold", c.up === null ? "text-foreground" : c.up ? "text-danger" : "text-success")}>{c.v}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </GlassCard>

      {/* 4b. 短线情绪（连板梯队 / 打板情绪，聚合口径零个股名） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><Flame className="h-4 w-4" /> 短线情绪</h3>
        <span className="text-[11px] text-muted-foreground/50">连板股 · 打板情绪 · 客观公开榜单</span>
        {emotion?.date && <span className="ml-auto text-[11px] text-muted-foreground/50">{emotion.date}</span>}
      </div>
      <GlassCard className="mb-6">
        {!emotion || emotion.zt_count === undefined ? (
          pending(emoDone)
        ) : (
          <>
            {/* 关键计数 */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { k: "涨停", v: `${emotion.zt_count}`, cls: "text-danger" },
                { k: "跌停", v: `${emotion.dt_count}`, cls: "text-success" },
                { k: "最高连板", v: `${emotion.max_boards} 板`, cls: "text-primary" },
                { k: "连板（2板+）", v: `${emotion.lianban_count} 家`, cls: "text-primary" },
              ].map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/25 p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-xl font-bold", c.cls)}>{c.v}</p>
                </div>
              ))}
            </div>
            {/* 打板情绪比率 */}
            <div className="mt-2 grid grid-cols-3 gap-2">
              {[
                { k: "封板率", v: emotion.seal_rate, hint: "封住 / 尝试涨停", strong: true },
                { k: "炸板率", v: emotion.break_rate, hint: "炸板 / 尝试涨停", strong: false },
                { k: "晋级率", v: emotion.promotion_rate, hint: "昨涨停今又停", strong: true },
              ].map((c) => (
                <div key={c.k} className="rounded-lg bg-muted/20 p-2.5 text-center">
                  <p className="text-[11px] text-muted-foreground">{c.k}</p>
                  <p className={cn("mt-0.5 font-mono text-sm font-bold", c.strong ? "text-danger" : "text-success")}>
                    {c.v == null ? "—" : `${(c.v * 100).toFixed(1)}%`}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/50">{c.hint}</p>
                </div>
              ))}
            </div>
            {/* 连板股清单（2 板以上，客观公开榜单） */}
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] text-muted-foreground">连板股（2 板以上连续涨停）· 客观公开榜单，非推荐 / 非预测</p>
              {emotion.lianban_stocks.length === 0 ? (
                <p className="text-xs text-muted-foreground/50">今日无 2 板以上个股</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                        {["名称", "连板", "现价", "涨停%", "成交额", "流通市值", "概念"].map((h) => (
                          <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {emotion.lianban_stocks.map((s) => (
                        <tr key={s.code} className="border-b border-border/30">
                          <td className="px-2 py-2"><span className="font-medium">{s.name}</span> <span className="text-xs text-muted-foreground/50">{s.code}</span></td>
                          <td className="whitespace-nowrap px-2 py-2 font-mono font-bold text-primary">{s.boards} 板</td>
                          <td className="px-2 py-2 font-mono">{s.price}</td>
                          <td className="px-2 py-2 font-mono text-danger">+{s.pct}%</td>
                          <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.amount)}</td>
                          <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.float_cap)}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{s.industry}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </GlassCard>

      {/* 4c. 全市场成交额 TOP20（客观公开榜单） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><BarChart3 className="h-4 w-4" /> 全市场成交额 TOP20</h3>
        <span className="text-[11px] text-muted-foreground/50">客观公开榜单，非推荐 / 非预测 / 不构成投资建议</span>
        {turnover?.updated && <span className="ml-auto text-[11px] text-muted-foreground/50">{turnover.updated}</span>}
      </div>
      <GlassCard className="mb-6">
        {!turnover || turnover.stocks.length === 0 ? (
          pending(toDone)
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["#", "名称", "现价", "涨跌%", "成交额", "总市值", "行业"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {turnover.stocks.map((s, i) => (
                  <tr key={s.code} className="border-b border-border/30">
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground/50">{i + 1}</td>
                    <td className="px-2 py-2"><span className="font-medium">{s.name}</span> <span className="text-xs text-muted-foreground/50">{s.code}</span></td>
                    <td className="px-2 py-2 font-mono">{s.price ?? "—"}</td>
                    <td className={cn("px-2 py-2 font-mono", s.pct == null ? "text-muted-foreground" : pctColor(s.pct))}>
                      {s.pct == null ? "—" : `${s.pct > 0 ? "+" : ""}${s.pct}%`}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono">{yi(s.amount)}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.mcap)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{s.industry}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 5. 板块资金趋势榜（行业） */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><TrendingUp className="h-4 w-4" /> 板块资金趋势榜</h3>
        <span className="text-[11px] text-muted-foreground/50">行业 · 按今日净流入排序</span>
      </div>
      <GlassCard className="mb-6">
        {sectors.length === 0 ? (
          pending(ovDone)
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["行业", "涨跌%", "今日净流入", "流入", "流出", "家数"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sectors.slice(0, 15).map((s) => (
                  <tr key={s.name} className="border-b border-border/30">
                    <td className="px-2 py-2 font-medium">{s.name}</td>
                    <td className={cn("px-2 py-2 font-mono", pctColor(s.pct))}>{s.pct > 0 ? "+" : ""}{s.pct}%</td>
                    <td className={cn("px-2 py-2 font-mono", pctColor(s.net))}>{s.net > 0 ? "+" : ""}{fmt(s.net)} 亿</td>
                    <td className="px-2 py-2 font-mono text-muted-foreground">{fmt(s.inflow)}</td>
                    <td className="px-2 py-2 font-mono text-muted-foreground">{fmt(s.outflow)}</td>
                    <td className="px-2 py-2 font-mono text-muted-foreground">{s.firms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* 6. 资金轮动 */}
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground"><ArrowDownUp className="h-4 w-4" /> 资金轮动</h3>
        <span className="text-[11px] text-muted-foreground/50">板块级净流入 / 流出</span>
      </div>
      <div className="mb-2 grid gap-4 md:grid-cols-2">
        {[
          { title: "流入 Top", icon: TrendingUp, color: "text-danger", rows: sectors.slice(0, 6) },
          { title: "流出 Top", icon: TrendingDown, color: "text-success", rows: [...sectors].slice(-6).reverse() },
        ].map((col) => (
          <GlassCard key={col.title}>
            <h4 className={cn("mb-3 flex items-center gap-1.5 text-sm font-semibold", col.color)}><col.icon className="h-4 w-4" /> {col.title}</h4>
            {col.rows.length === 0 ? (
              pending(ovDone)
            ) : (
              <div className="space-y-1.5">
                {col.rows.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-3 border-b border-border/30 pb-1.5 text-sm last:border-0">
                    <span className="w-5 text-xs text-muted-foreground/50">{i + 1}</span>
                    <span className="flex-1 truncate">{s.name}</span>
                    <span className={cn("font-mono text-xs", pctColor(s.pct))}>{s.pct > 0 ? "+" : ""}{s.pct}%</span>
                    <span className={cn("w-20 text-right font-mono text-xs", pctColor(s.net))}>{s.net > 0 ? "+" : ""}{fmt(s.net)} 亿</span>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        ))}
      </div>

      <Disclaimer />
    </div>
  );
}
