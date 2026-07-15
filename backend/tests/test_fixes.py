"""审计修复回归测（2026-07-05，全部离线）：
鉴权中间件 / 持仓 CRUD 与坏文件降级 / 估值脏数据防护 / 涨停池脏数值 /
空结果不缓存 / akshare 缺失降级 / 无 index 工具调用归位 / CLI 流式超时。
"""
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import app as app_module
import astock
import chat
import cli_runtime
import market
import portfolio as pf

client = TestClient(app_module.app)


# ── VR_API_KEY 鉴权中间件 ───────────────────────────────────────────

def test_api_key_auth(monkeypatch):
    monkeypatch.setattr(app_module, "_API_KEY", "sekret")
    assert client.get("/api/health").status_code == 200  # health 豁免
    assert client.get("/api/quote?codes=abc").status_code == 401  # 缺头
    assert client.get("/api/quote?codes=abc", headers={"Authorization": "Bearer wrong"}).status_code == 401
    # 正确 key → 通过鉴权、走到参数校验层（400 而非 401，不联网）
    assert client.get("/api/quote?codes=abc", headers={"Authorization": "Bearer sekret"}).status_code == 400


# ── 持仓：本地 JSON CRUD（不联网，行情打桩） ────────────────────────

@pytest.fixture()
def tmp_pf(tmp_path, monkeypatch):
    monkeypatch.setattr(pf, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(pf, "PF_FILE", str(tmp_path / "portfolio.json"))
    monkeypatch.setattr(pf, "ALERTS_FILE", str(tmp_path / "portfolio_alerts.json"))
    monkeypatch.setattr(
        astock, "tencent_quote",
        lambda codes: {c: {"name": f"股{c}", "price": 10.0, "change_pct": 1.5} for c in codes},
    )
    # 6 根日 K：近 5 日高低用 OHLC；现价 10 贴近期高点 → 偏涨
    def _fake_kline(code, category=4, offset=60):
        # close, high, low
        rows = [
            (8.0, 8.2, 7.8),
            (8.5, 8.8, 8.2),
            (9.0, 9.3, 8.7),
            (9.2, 9.5, 9.0),
            (9.5, 9.9, 9.2),
            (10.0, 10.4, 9.6),
        ]
        return [
            {"datetime": f"2026-07-{i+1:02d}", "close": c, "high": h, "low": lo}
            for i, (c, h, lo) in enumerate(rows)
        ]
    monkeypatch.setattr(astock, "kline", _fake_kline)
    return tmp_path


def test_portfolio_crud_roundtrip(tmp_pf):
    assert client.get("/api/portfolio").json()["data"]["holdings"] == []

    r = client.post("/api/portfolio/holding", json={"code": "600519", "shares": 100, "cost": 8.0})
    assert r.status_code == 200
    h = r.json()["data"]["holdings"][0]
    assert h["code"] == "600519"
    assert h["pnl"] == pytest.approx((10.0 - 8.0) * 100)

    # 同代码加仓 → 加权平均成本
    client.post("/api/portfolio/holding", json={"code": "600519", "shares": 100, "cost": 12.0})
    h = client.get("/api/portfolio").json()["data"]["holdings"][0]
    assert h["shares"] == 200
    assert h["cost"] == pytest.approx(10.0)

    r = client.post("/api/portfolio/close", json={"code": "600519", "date": "2026-07-05", "price": 11.0, "shares": 200, "cost": 10.0})
    assert r.status_code == 200
    assert r.json()["data"]["closed"][0]["pnl"] == pytest.approx(200.0)

    assert client.delete("/api/portfolio/holding?code=600519").json()["data"]["holdings"] == []
    assert client.delete("/api/portfolio/close?index=0").json()["data"]["closed"] == []
    assert client.post("/api/portfolio/refresh").status_code == 200


def test_portfolio_add_validation(tmp_pf):
    assert client.post("/api/portfolio/holding", json={"code": "abc", "shares": 1, "cost": 1}).status_code == 400
    assert client.post("/api/portfolio/holding", json={"code": "600519", "shares": 0, "cost": 1}).status_code == 400


def test_portfolio_corrupt_file_returns_empty(tmp_pf):
    (tmp_pf / "portfolio.json").write_text("{broken json", encoding="utf-8")
    r = client.get("/api/portfolio")
    assert r.status_code == 200
    assert r.json()["data"]["holdings"] == []


def test_portfolio_ranges_and_momentum(tmp_pf):
    # pct 止盈/止损 + 添加时写入
    r = client.post("/api/portfolio/holding", json={
        "code": "600519", "shares": 100, "cost": 8.0,
        "tp_mode": "pct", "tp_low": 20, "tp_high": 30,
        "sl_mode": "pct", "sl_low": -10, "sl_high": -5,
    })
    assert r.status_code == 200
    h = r.json()["data"]["holdings"][0]
    # 现价 10 / 成本 8 → 浮盈 25% → 进入止盈带
    assert h["pnl_pct"] == pytest.approx(25.0)
    assert h["tp_status"] == "in_zone"
    assert h["sl_status"] == "above"  # 浮盈远在止损带之上
    assert h["tp_mode"] == "pct" and h["tp_low"] == 20
    assert h["change_pct"] == pytest.approx(1.5)
    # 近 5 日 high5=10.4 low5=8.2；现价 10
    # from_high=(10-10.4)/10.4*100≈-3.85；from_low=(10-8.2)/8.2*100≈21.95
    # chg5 = from_low - (-from_high) ≈ 21.95 - 3.85 ≈ 18.1 → 偏涨
    assert h["high5"] == pytest.approx(10.4)
    assert h["low5"] == pytest.approx(8.2)
    assert h["from_high_pct"] == pytest.approx((10 - 10.4) / 10.4 * 100, abs=0.02)
    assert h["from_low_pct"] == pytest.approx((10 - 8.2) / 8.2 * 100, abs=0.02)
    assert h["bias5"] == "up"
    assert h["chg5"] == pytest.approx(h["from_low_pct"] + h["from_high_pct"], abs=0.02)
    assert len(h["daily_changes"]) == 5
    assert "bias_up" in h["flags"]
    assert "in_tp_zone" in h["flags"]

    # 加仓不带区间 → 保留旧区间
    client.post("/api/portfolio/holding", json={"code": "600519", "shares": 100, "cost": 12.0})
    h = client.get("/api/portfolio").json()["data"]["holdings"][0]
    assert h["cost"] == pytest.approx(10.0)
    assert h["tp_mode"] == "pct" and h["tp_low"] == 20

    # PATCH 改为绝对价格止盈；清空止损
    r = client.patch(
        "/api/portfolio/holding/ranges?code=600519",
        json={"tp_mode": "price", "tp_low": 11.0, "tp_high": 12.0},
    )
    assert r.status_code == 200
    h = r.json()["data"]["holdings"][0]
    assert h["tp_mode"] == "price"
    assert h["tp_status"] == "below"  # 现价 10 < 11
    assert "sl_mode" not in h or h.get("sl_mode") is None
    assert h["sl_status"] == "unset"

    # 接近止盈下沿（price 模式：距 10.15 仅约 1.5%）
    r = client.patch(
        "/api/portfolio/holding/ranges?code=600519",
        json={"tp_mode": "price", "tp_low": 10.15, "tp_high": 11.0},
    )
    h = r.json()["data"]["holdings"][0]
    assert h["tp_status"] == "below"
    assert "near_tp" in h["flags"]

    # 清空区间
    r = client.patch("/api/portfolio/holding/ranges?code=600519", json={})
    h = r.json()["data"]["holdings"][0]
    assert h["tp_status"] == "unset"
    assert "tp_mode" not in h

    # 非法区间
    assert client.patch(
        "/api/portfolio/holding/ranges?code=600519",
        json={"tp_mode": "pct", "tp_low": 30, "tp_high": 20},
    ).status_code == 400
    assert client.patch(
        "/api/portfolio/holding/ranges?code=000001",
        json={"tp_mode": "pct", "tp_low": 10, "tp_high": 20},
    ).status_code == 400


def test_portfolio_kline_failure_degrades(tmp_pf, monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("kline down")
    monkeypatch.setattr(astock, "kline", _boom)
    client.post("/api/portfolio/holding", json={
        "code": "600519", "shares": 100, "cost": 8.0,
        "tp_mode": "pct", "tp_low": 20, "tp_high": 30,
    })
    h = client.get("/api/portfolio").json()["data"]["holdings"][0]
    assert h["pnl"] == pytest.approx(200.0)
    assert h["tp_status"] == "in_zone"
    assert h["chg5"] is None
    assert h["daily_changes"] == []


def test_portfolio_legacy_json_without_ranges(tmp_pf):
    """旧 portfolio.json 无区间字段仍可读。"""
    import json
    (tmp_pf / "portfolio.json").write_text(
        json.dumps({"holdings": [{"code": "600519", "shares": 50, "cost": 10.0}], "last_refresh": None}),
        encoding="utf-8",
    )
    h = client.get("/api/portfolio").json()["data"]["holdings"][0]
    assert h["code"] == "600519"
    assert h["tp_status"] == "unset"
    assert h["sl_status"] == "unset"
    assert isinstance(h["flags"], list)


def test_is_trading_session():
    # 2026-07-09 周四
    mon_am = datetime(2026, 7, 9, 10, 0, tzinfo=pf.BEIJING)
    mon_lunch = datetime(2026, 7, 9, 12, 0, tzinfo=pf.BEIJING)
    mon_pm = datetime(2026, 7, 9, 14, 0, tzinfo=pf.BEIJING)
    after = datetime(2026, 7, 9, 15, 30, tzinfo=pf.BEIJING)
    weekend = datetime(2026, 7, 11, 10, 0, tzinfo=pf.BEIJING)  # 周六
    assert pf.is_trading_session(mon_am) is True
    assert pf.is_trading_session(mon_lunch) is False
    assert pf.is_trading_session(mon_pm) is True
    assert pf.is_trading_session(after) is False
    assert pf.is_trading_session(weekend) is False


def test_tp_sl_alert_transition_and_dedupe(tmp_pf, monkeypatch):
    """below → in_zone 出告警；同状态再 tick 不刷；离开后再进入再告。"""
    client.post("/api/portfolio/holding", json={
        "code": "600519", "shares": 100, "cost": 10.0,
        "tp_mode": "pct", "tp_low": 20, "tp_high": 30,
    })
    prices = {"600519": 10.0}

    def quote(codes):
        return {c: {"name": f"股{c}", "price": prices[c], "change_pct": 0.0} for c in codes}

    monkeypatch.setattr(astock, "tencent_quote", quote)

    assert pf.check_tp_sl_alerts(force=True) == []
    assert client.get("/api/portfolio/alerts").json()["data"]["unread"] == 0

    prices["600519"] = 12.5  # 浮盈 25% → 入止盈带
    created = pf.check_tp_sl_alerts(force=True)
    assert len(created) == 1
    assert created[0]["kind"] == "in_tp_zone"
    assert client.get("/api/portfolio/alerts").json()["data"]["unread"] == 1

    assert pf.check_tp_sl_alerts(force=True) == []  # 同态不刷
    assert client.get("/api/portfolio/alerts").json()["data"]["unread"] == 1

    prices["600519"] = 10.0
    assert pf.check_tp_sl_alerts(force=True) == []
    prices["600519"] = 12.5
    created2 = pf.check_tp_sl_alerts(force=True)
    assert len(created2) == 1
    assert client.get("/api/portfolio/alerts").json()["data"]["unread"] == 2

    r = client.post("/api/portfolio/alerts/ack", json={"all": True})
    assert r.status_code == 200
    assert r.json()["data"]["unread"] == 0


# ── full_valuation：一致预期缺「均值」/ '-' 占位不再 502 ─────────────

_QUOTE = {"600519": {"name": "贵州茅台", "price": 100.0, "mcap_yi": 1000, "pe_ttm": 20.0, "pb": 5.0}}


def test_full_valuation_dirty_forecast(monkeypatch):
    monkeypatch.setattr(astock, "tencent_quote", lambda codes: _QUOTE)
    monkeypatch.setattr(astock, "profit_forecast", lambda code: [
        {"年度": "2026", "预测机构数": "-"},  # 缺「均值」+ 脏机构数
        {"年度": "2027", "均值": "-"},        # '-' 占位
    ])
    out = astock.full_valuation("600519")
    assert out["eps_26e"] is None
    assert out["eps_27e"] is None
    assert out["pe_26e"] is None


def test_full_valuation_string_numbers(monkeypatch):
    monkeypatch.setattr(astock, "tencent_quote", lambda codes: _QUOTE)
    monkeypatch.setattr(astock, "profit_forecast", lambda code: [
        {"年度": "2026年", "均值": "2.0", "预测机构数": "12"},
        {"年度": "2027年", "均值": 2.4},
    ])
    out = astock.full_valuation("600519")
    assert out["eps_26e"] == 2.0
    assert out["analyst_count"] == 12
    assert out["pe_26e"] == 50.0


# ── 短线情绪：涨停池脏数值（'-' 占位）不再让排序崩溃 ────────────────

def test_emotion_dirty_amount(monkeypatch):
    pools = {
        "getTopicZTPool": [
            {"c": "600001", "n": "甲", "lbc": 3, "p": 10000, "zdp": 10.0, "amount": "-", "ltsz": None, "hybk": "X"},
            {"c": "600002", "n": "乙", "lbc": 2, "p": "-", "zdp": None, "amount": 5e8, "ltsz": 1e9, "hybk": "Y"},
        ],
        "getTopicZBPool": [],
        "getTopicDTPool": [],
        "getYesterdayZTPool": [{}],
    }
    monkeypatch.setattr(astock, "em_zt_topic_pool", lambda ep, d, sort="": pools.get(ep, []))
    out = market._emotion()
    stocks = out["lianban_stocks"]
    assert [s["code"] for s in stocks] == ["600001", "600002"]  # 排序没崩、按连板数降序
    assert stocks[0]["amount"] is None    # '-' 归一为 None
    assert stocks[1]["price"] == 0.0      # p='-' 归一后按 0 展示
    assert stocks[1]["amount"] == 5e8


# ── 缓存：数据源故障的空结果不缓存 5 分钟 ───────────────────────────

def test_cached_skips_empty():
    market._CACHE.pop("k_test", None)
    calls = []

    def flaky():
        calls.append(1)
        return {} if len(calls) == 1 else {"ok": 1}

    assert market._cached("k_test", flaky) == {}
    assert market._cached("k_test", flaky) == {"ok": 1}  # 空结果没被缓存 → 下次重试成功
    assert market._cached("k_test", flaky) == {"ok": 1}  # 非空已缓存，不再调用
    assert len(calls) == 2
    market._CACHE.pop("k_test", None)


# ── akshare 未安装：market 降级返回空，不挡服务 ─────────────────────

def test_market_degrades_without_akshare(monkeypatch):
    def boom():
        raise astock.DependencyMissing("akshare 未安装")

    monkeypatch.setattr(astock, "_akshare", boom)
    monkeypatch.setattr(astock, "em_get", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no em")))
    assert market._sentiment() == {}
    assert market._sectors() == []


def test_sectors_from_eastmoney(monkeypatch):
    class FakeResp:
        def json(self):
            return {"data": {"diff": [
                {"f14": "半导体", "f3": 2.5, "f62": 3_000_000_000, "f66": 2e9, "f72": 1e9, "f104": 30, "f105": 10},
                {"f14": "银行", "f3": -1.2, "f62": -1_500_000_000, "f66": -1e9, "f72": -0.5e9, "f104": 20, "f105": 15},
            ]}}

    monkeypatch.setattr(astock, "em_get", lambda *a, **k: FakeResp())
    rows = market._sectors()
    assert len(rows) == 2
    assert rows[0]["name"] == "半导体"
    assert rows[0]["net"] == 30.0
    assert rows[1]["net"] == -15.0


# ── OpenAI 兼容端点 URL 规范化（自定义 baseURL 不重复拼路径） ───────

@pytest.mark.parametrize("base,expected", [
    ("https://api.deepseek.com", "https://api.deepseek.com/v1/chat/completions"),
    ("https://api.openai.com/v1", "https://api.openai.com/v1/chat/completions"),
    ("https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/chat/completions"),
    ("https://x/v4/chat/completions", "https://x/v4/chat/completions"),
    ("https://x/v4/chat/completions/", "https://x/v4/chat/completions"),
])
def test_resolve_chat_completions_url(base, expected):
    assert chat.resolve_chat_completions_url(base) == expected


# ── 流式工具调用：非标网关不带 index 时按 id 归位、不串参数 ──────────

def test_stream_tool_calls_without_index(monkeypatch):
    deltas_rounds = [
        [  # 第一轮：增量全部不带 index —— 续块无 id、新调用带新 id
            {"tool_calls": [{"id": "call_a", "function": {"name": "query_quote", "arguments": '{"codes":'}}]},
            {"tool_calls": [{"function": {"arguments": '["600519"]}'}}]},
            {"tool_calls": [{"id": "call_b", "function": {"name": "query_news", "arguments": '{"code":"600519"}'}}]},
        ],
        [{"content": "答案"}],  # 第二轮：纯文本收尾
    ]
    state = {"round": 0}
    monkeypatch.setattr(chat, "_call_llm_stream", lambda cfg, messages, use_tools: None)

    def fake_iter(_resp):
        i = state["round"]
        state["round"] += 1
        yield from deltas_rounds[i]

    monkeypatch.setattr(chat, "_iter_sse_deltas", fake_iter)
    executed = []
    monkeypatch.setattr(chat, "_exec_tool", lambda name, args: (executed.append((name, args)), {"ok": 1})[1])

    events = list(chat.run_chat_stream(
        {"baseURL": "http://x", "apiKey": "k", "model": "m"},
        [{"role": "user", "content": "q"}],
    ))
    assert ("query_quote", {"codes": ["600519"]}) in executed  # 参数没被串坏
    assert ("query_news", {"code": "600519"}) in executed      # 两个调用各归各槽
    assert events[-1]["type"] == "done"


# ── CLI 流式：子进程挂起时超时真正生效（不再无限期阻塞） ────────────

def test_run_cli_stream_timeout(monkeypatch):
    monkeypatch.setattr(cli_runtime, "_CLI_TIMEOUT_S", 1)
    monkeypatch.setitem(cli_runtime._CLI_DEFS, "fake", {
        "bins": ["python3"],
        "delivery": "stdin",
        "build_args": lambda _: ["-c", "import time\nprint('x', flush=True)\ntime.sleep(30)"],
        "env": {},
    })
    chunks = []
    with pytest.raises(RuntimeError, match="超时"):
        for line in cli_runtime.run_cli_stream("fake", "s", "u"):
            chunks.append(line)
    assert chunks and chunks[0].strip() == "x"  # 挂起前的输出已正常流出
