"""持仓数据层 —— 用户自己录入的持仓 + 实时行情叠加浮动盈亏。

合规：持仓是用户主动录入的自己的标的（存本地 .cache/portfolio.json，
gitignore、不上传、不进仓库），不预置任何标的、不含 _SEED 兜底、不做推荐。
盈亏红涨绿跌（A股口径）。含每半小时后台定时刷新 + 手动刷新。

扩展：用户自定义止盈/止损区间（pct 或绝对价），以及每次拉取时用日 K
实时计算近 5 日动能与预警 flags（不落多日快照库）。
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone, timedelta
from typing import Any

import astock

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, ".cache")
PF_FILE = os.path.join(CACHE_DIR, "portfolio.json")
BEIJING = timezone(timedelta(hours=8))
_LOCK = threading.Lock()

RANGE_KEYS = ("tp_mode", "tp_low", "tp_high", "sl_mode", "sl_low", "sl_high")
VALID_MODES = ("pct", "price")


def _now() -> str:
    return datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M")


def _load() -> dict:
    try:
        with open(PF_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"holdings": [], "last_refresh": None}


def _save(d: dict) -> None:
    # 先写临时文件再原子改名：并发读若撞上写中途的半截 JSON，会被 _load 静默当成空持仓
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = PF_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, PF_FILE)


def _num(v: Any) -> float | None:
    if v is None or v == "" or v is False:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def normalize_ranges(raw: dict | None) -> dict:
    """校验并规范化止盈/止损区间；返回可写入 holdings 的字段子集。

    抛 ValueError（中文信息）供 API 层转 400。
    """
    if not raw:
        return {}
    out: dict = {}

    def one_side(prefix: str) -> None:
        mode = raw.get(f"{prefix}_mode")
        low = raw.get(f"{prefix}_low")
        high = raw.get(f"{prefix}_high")
        # 全空 = 不设置该侧
        if mode in (None, "") and low in (None, "") and high in (None, ""):
            return
        if mode not in VALID_MODES:
            raise ValueError(f"{prefix}_mode 必须是 pct 或 price")
        lo = _num(low)
        hi = _num(high)
        if lo is None or hi is None:
            raise ValueError(f"{prefix}_low / {prefix}_high 必须成对填写且为数字")
        if lo > hi:
            raise ValueError(f"{prefix}_low 不能大于 {prefix}_high")
        out[f"{prefix}_mode"] = mode
        out[f"{prefix}_low"] = round(lo, 4)
        out[f"{prefix}_high"] = round(hi, 4)

    one_side("tp")
    one_side("sl")
    return out


def _apply_ranges(h: dict, ranges: dict | None, *, clear_missing: bool = False) -> None:
    """把区间写到持仓项。clear_missing=True 时先清掉旧区间再写（用于 PATCH 全量覆盖）。"""
    if clear_missing:
        for k in RANGE_KEYS:
            h.pop(k, None)
    if not ranges:
        return
    for k, v in ranges.items():
        h[k] = v


def _persisted_ranges(h: dict) -> dict:
    return {k: h[k] for k in RANGE_KEYS if k in h and h[k] is not None}


def add_holding(code: str, shares: float, cost: float, ranges: dict | None = None) -> dict:
    """加一笔持仓；同代码则按加权平均成本合并（加仓）。

    合并时：若本次带了新区间则覆盖；否则保留已有区间。
    """
    rng = normalize_ranges(ranges) if ranges else {}
    with _LOCK:
        d = _load()
        for h in d["holdings"]:
            if h["code"] == code:
                total = h["shares"] + shares
                h["cost"] = round((h["shares"] * h["cost"] + shares * cost) / total, 3) if total else cost
                h["shares"] = total
                if rng:
                    _apply_ranges(h, rng, clear_missing=False)
                break
        else:
            item = {"code": code, "shares": shares, "cost": cost}
            _apply_ranges(item, rng)
            d["holdings"].append(item)
        _save(d)
    return get_portfolio()


def update_holding_ranges(code: str, ranges: dict | None) -> dict:
    """只改止盈止损区间，不改正本/股数。传空 dict / None 表示清空两侧区间。"""
    rng = normalize_ranges(ranges) if ranges else {}
    with _LOCK:
        d = _load()
        found = False
        for h in d["holdings"]:
            if h["code"] == code:
                _apply_ranges(h, rng, clear_missing=True)
                found = True
                break
        if not found:
            raise ValueError(f"持仓中没有代码 {code}")
        _save(d)
    return get_portfolio()


def remove_holding(code: str) -> dict:
    with _LOCK:
        d = _load()
        d["holdings"] = [h for h in d["holdings"] if h["code"] != code]
        _save(d)
    return get_portfolio()


def close_position(code: str, date: str, price: float, shares: float, cost: float) -> dict:
    """记一笔已清仓：算已实现盈亏，存入 closed 列表。"""
    pnl = (price - cost) * shares
    with _LOCK:
        d = _load()
        d.setdefault("closed", [])
        try:
            name = astock.tencent_quote([code]).get(code, {}).get("name", code)
        except Exception:
            name = code
        d["closed"].append({
            "code": code, "name": name, "date": date, "price": price,
            "shares": shares, "cost": cost, "pnl": round(pnl, 2),
            "pnl_pct": round((price - cost) / cost * 100, 2) if cost else 0.0,
        })
        _save(d)
    return get_portfolio()


def remove_closed(index: int) -> dict:
    with _LOCK:
        d = _load()
        cl = d.get("closed", [])
        if 0 <= index < len(cl):
            cl.pop(index)
            _save(d)
    return get_portfolio()


def _zone_status(value: float, low: float, high: float) -> str:
    if value < low:
        return "below"
    if value > high:
        return "above"
    return "in_zone"


def _eval_side(prefix: str, h: dict, price: float, pnl_pct: float) -> tuple[str, bool]:
    """返回 (status, near_flag)。

    near_tp：未入带、在下沿外侧且距下沿 ≤2%（提前量）。
    near_sl：未入带、在上沿外侧且距上沿 ≤2%（从上沿外侧逼近止损带）。
    """
    mode = h.get(f"{prefix}_mode")
    low = h.get(f"{prefix}_low")
    high = h.get(f"{prefix}_high")
    if mode not in VALID_MODES or low is None or high is None:
        return "unset", False
    lo, hi = float(low), float(high)
    if mode == "pct":
        status = _zone_status(pnl_pct, lo, hi)
        if prefix == "tp":
            near = status == "below" and (lo - pnl_pct) <= 2.0
        else:
            near = status == "above" and (pnl_pct - hi) <= 2.0
    else:
        status = _zone_status(price, lo, hi)
        if prefix == "tp":
            near = status == "below" and price > 0 and ((lo - price) / price * 100) <= 2.0
        else:
            near = status == "above" and price > 0 and ((price - hi) / price * 100) <= 2.0
    return status, near


def _bar_num(bar: dict, *keys: str) -> float | None:
    for k in keys:
        if k in bar:
            return _num(bar[k])
    return None


def _bar_close(bar: dict) -> float | None:
    return _bar_num(bar, "close", "Close", "CLOSE")


def _bar_high(bar: dict) -> float | None:
    h = _bar_num(bar, "high", "High", "HIGH")
    if h is not None:
        return h
    return _bar_close(bar)


def _bar_low(bar: dict) -> float | None:
    lo = _bar_num(bar, "low", "Low", "LOW")
    if lo is not None:
        return lo
    return _bar_close(bar)


def _bar_date(bar: dict) -> str:
    for k in ("datetime", "date", "time", "Date", "DATETIME"):
        if k in bar and bar[k] is not None:
            s = str(bar[k])
            return s[:10] if len(s) >= 10 else s
    return ""


def _momentum_from_kline(code: str, price: float = 0.0) -> dict:
    """近 5 交易日动能：现价对照盘内最高/最低，判断偏涨还是偏跌。

    - high5 / low5：近 5 根日 K 的最高价 / 最低价
    - from_high_pct：现价相对五日高 `(price-high5)/high5*100`（通常≤0）
    - from_low_pct：现价相对五日低 `(price-low5)/low5*100`（通常≥0）
    - bias5：比较「自低点涨了多少」vs「自高点跌了多少」→ up / down / mid
    - chg5：偏向分 `from_low_pct + from_high_pct`（=涨幅贡献−跌幅回撤，正偏涨、负偏跌）
    """
    empty = {
        "chg5": None,
        "high5": None,
        "low5": None,
        "from_high_pct": None,
        "from_low_pct": None,
        "range_pos_pct": None,
        "bias5": "unset",
        "daily_changes": [],
        "up_days": 0,
        "pullback_from_high_pct": None,
    }
    try:
        bars = astock.kline(code, category=4, offset=12) or []
    except Exception:
        return empty

    rows: list[tuple[str, float, float, float]] = []  # date, close, high, low
    for b in bars:
        c = _bar_close(b)
        if c is None or c <= 0:
            continue
        hi = _bar_high(b) or c
        lo = _bar_low(b) or c
        if hi < lo:
            hi, lo = lo, hi
        rows.append((_bar_date(b), c, hi, lo))
    if len(rows) < 1:
        return empty

    window = rows[-5:]
    high5 = max(r[2] for r in window)
    low5 = min(r[3] for r in window)
    px = price if price and price > 0 else window[-1][1]

    from_high = round((px - high5) / high5 * 100, 2) if high5 else None
    from_low = round((px - low5) / low5 * 100, 2) if low5 else None
    range_pos = None
    if high5 and low5 and high5 > low5:
        range_pos = round((px - low5) / (high5 - low5) * 100, 2)
        range_pos = max(0.0, min(100.0, range_pos))
    elif high5 and low5 and high5 == low5:
        range_pos = 50.0

    # 涨得多：自低点涨幅 > 自高点跌幅；跌得多：相反；接近持平 → mid
    bias5 = "unset"
    chg5 = None
    if from_high is not None and from_low is not None:
        down_from_high = -from_high  # 高点回撤幅度（≥0）
        up_from_low = from_low
        chg5 = round(up_from_low - down_from_high, 2)
        if up_from_low > down_from_high + 1.0:
            bias5 = "up"
        elif down_from_high > up_from_low + 1.0:
            bias5 = "down"
        else:
            bias5 = "mid"

    # 逐日涨跌（辅助展示；判定主轴仍是现价 vs 五日高低）
    daily: list[dict] = []
    if len(rows) >= 2:
        tail = rows[-(5 + 1):] if len(rows) >= 6 else rows
        for i in range(1, len(tail)):
            prev, cur = tail[i - 1][1], tail[i][1]
            chg = round((cur - prev) / prev * 100, 2) if prev else 0.0
            daily.append({"date": tail[i][0], "close": round(cur, 3), "change_pct": chg})
        daily = daily[-5:]

    up_days = 0
    for d in reversed(daily):
        if d["change_pct"] > 0:
            up_days += 1
        else:
            break

    return {
        "chg5": chg5,
        "high5": round(high5, 3) if high5 else None,
        "low5": round(low5, 3) if low5 else None,
        "from_high_pct": from_high,
        "from_low_pct": from_low,
        "range_pos_pct": range_pos,
        "bias5": bias5,
        "daily_changes": daily,
        "up_days": up_days,
        "pullback_from_high_pct": from_high,
    }


def _build_flags(
    tp_status: str, sl_status: str, near_tp: bool, near_sl: bool,
    mom: dict,
) -> list[str]:
    flags: list[str] = []
    if near_tp:
        flags.append("near_tp")
    if near_sl:
        flags.append("near_sl")
    if tp_status == "in_zone":
        flags.append("in_tp_zone")
    if sl_status == "in_zone":
        flags.append("in_sl_zone")

    bias = mom.get("bias5")
    from_high = mom.get("from_high_pct")
    from_low = mom.get("from_low_pct")
    range_pos = mom.get("range_pos_pct")
    if bias == "up":
        flags.append("bias_up")
        if (range_pos is not None and range_pos >= 80) or (from_high is not None and from_high >= -3):
            flags.append("near_5d_high")
        if from_low is not None and from_low >= 15:
            flags.append("strong_run")
        if from_low is not None and from_low >= 25:
            flags.append("extended_run")
    elif bias == "down":
        flags.append("bias_down")
        if (range_pos is not None and range_pos <= 20) or (from_low is not None and from_low <= 3):
            flags.append("near_5d_low")
        if from_high is not None and from_high <= -5:
            flags.append("deep_pullback")
    elif bias == "mid":
        flags.append("bias_mid")
        if from_high is not None and from_high <= -5:
            flags.append("deep_pullback")

    if mom.get("up_days", 0) >= 3 and "strong_run" not in flags:
        flags.append("strong_run")
    return flags


def _enrich_holding(h: dict, q: dict) -> dict:
    price = float(q.get("price") or 0.0)
    shares = float(h["shares"])
    cost = float(h["cost"])
    mv = price * shares
    cv = cost * shares
    pnl = mv - cv
    pnl_pct = round(pnl / cv * 100, 2) if cv else 0.0
    change_pct = q.get("change_pct")
    if change_pct is not None:
        try:
            change_pct = round(float(change_pct), 2)
        except (TypeError, ValueError):
            change_pct = None

    ranges = _persisted_ranges(h)
    tp_status, near_tp = _eval_side("tp", h, price, pnl_pct)
    sl_status, near_sl = _eval_side("sl", h, price, pnl_pct)
    mom = _momentum_from_kline(h["code"], price=price)
    flags = _build_flags(tp_status, sl_status, near_tp, near_sl, mom)

    row = {
        "code": h["code"],
        "name": q.get("name", h["code"]),
        "price": price,
        "shares": shares,
        "cost": cost,
        "market_value": round(mv, 2),
        "pnl": round(pnl, 2),
        "pnl_pct": pnl_pct,
        "change_pct": change_pct,
        **ranges,
        "tp_status": tp_status,
        "sl_status": sl_status,
        "chg5": mom["chg5"],
        "high5": mom["high5"],
        "low5": mom["low5"],
        "from_high_pct": mom["from_high_pct"],
        "from_low_pct": mom["from_low_pct"],
        "range_pos_pct": mom["range_pos_pct"],
        "bias5": mom["bias5"],
        "daily_changes": mom["daily_changes"],
        "up_days": mom["up_days"],
        "pullback_from_high_pct": mom["pullback_from_high_pct"],
        "flags": flags,
    }
    return row


def get_portfolio() -> dict:
    """读持仓 + 实时行情 + 止盈止损状态 + 近5日动能。"""
    with _LOCK:
        d = _load()
    hs = d.get("holdings", [])
    rows, tmv, tcost = [], 0.0, 0.0
    if hs:
        try:
            quotes = astock.tencent_quote([h["code"] for h in hs])
        except Exception:
            quotes = {}
        for h in hs:
            q = quotes.get(h["code"], {})
            row = _enrich_holding(h, q)
            rows.append(row)
            tmv += row["market_value"]
            tcost += h["cost"] * h["shares"]
    total_pnl = tmv - tcost
    closed = d.get("closed", [])
    return {
        "holdings": rows,
        "totals": {
            "market_value": round(tmv, 2), "cost": round(tcost, 2),
            "pnl": round(total_pnl, 2),
            "pnl_pct": round(total_pnl / tcost * 100, 2) if tcost else 0.0,
        },
        "closed": closed,
        "realized_pnl": round(sum(c.get("pnl", 0) for c in closed), 2),
        "updated": _now(),
        "last_refresh": d.get("last_refresh"),
    }


def _refresh_snapshot() -> None:
    """后台定时任务：刷新时间戳（GET 本就实时算，这里记录后台刷新点）。"""
    with _LOCK:
        d = _load()
        d["last_refresh"] = _now()
        _save(d)


def start_scheduler(interval: int = 1800) -> None:
    """每半小时后台刷新一次持仓数据（daemon 线程）。"""
    def loop():
        while True:
            time.sleep(interval)
            try:
                _refresh_snapshot()
            except Exception:
                pass
    threading.Thread(target=loop, daemon=True).start()
