"""系统 AI 对话层 —— function calling 循环（OpenAI 兼容）。

让网页内置 AI 在回答时自己调 astock 数据工具（查行情/估值/研报/新闻），
拿到客观数据再作答。兼容豆包 / DeepSeek / 任意 OpenAI 兼容端点。

合规：工具只返回客观数据；system prompt 强制中立——不荐股、不预测涨跌、
不给买卖时机，只做信息整理与多视角分析。结论由用户配置的模型给出。
"""

from __future__ import annotations

import json

import requests

import astock
import cli_runtime

MAX_ROUNDS = 6  # 工具调用最大轮数，防死循环
_TOOL_RESULT_CAP = 6000  # 单次工具结果注入上限（控 token）

# 投研分析框架：用户要「分析个股 / 给判断 / 下结论」时，AI 一律按这五维组织，
# 让弱模型也能输出结构化、覆盖全、不漏项的专业解读。焊进 SYSTEM_PROMPT，不做成 UI 选项——
# 用户就问，给出的就是这套框架的结论。合规：框架只规定「怎么读数据」，每维只陈述事实与相对位置，
# 最后不给买卖结论。
ANALYSIS_FRAMEWORK = """【投研分析框架】当用户要你分析个股、给判断或下结论时，按下面五个维度依次组织分析，每维用一两句讲清数据事实与相对位置，最后只做客观归纳、不给买卖结论：
1. 估值：PE / PB / PS 的绝对水平 + 处在历史区间的高 / 中 / 低位 + 同业对比 + 机构一致预期的前向估值。
2. 资金面：主力资金流方向与强度 + 融资融券趋势 + 股东户数（筹码集中 / 分散）+ 龙虎榜 / 大宗异动。
3. 财报质量：营收与扣非净利增速是否匹配 + 经营现金流含金量 + 毛利 / 净利率趋势 + 资产负债率。
4. 行业景气：板块 / 概念归属 + 板块近期强弱 + 行业内相对排名 + 关联热门概念热度。
5. 事件催化与风险：重要公告 + 解禁 + 分红 + 舆情，客观分列「催化」与「风险」两栏。

输出组织（像专业研报那样排版，但只陈述客观事实、不做任何买卖/评级/目标价建议）：
- 结论先行：开头一句话客观概括当前基本面 / 估值 / 资金面处于什么状态，再附「关键数据速览」。
- 每个维度用「**加粗小标题** + 一小段展开」，别堆流水账数字。
- 有对比就上小表格（如估值 vs 同业、财报同比）。
- 末尾分列「关键观察」与「风险点」两栏。
（简单的事实性问题——如"现价多少"——直接答，不必套用整个框架。）"""

# 用 f-string 先把框架焊进去，只留 {{context}} 给运行时 .format() 填——4 处调用点无需改。
SYSTEM_PROMPT = f"""你是 Vibe-Research 里的投研助理。你可以调用工具获取 A 股的客观数据（实时行情、估值、研报、新闻）来支撑回答。

硬性规则（务必遵守）：
- 只做信息整理、数据解读与多视角分析；不推荐任何具体买卖、不预测涨跌与价位、不给买卖时机、不承诺收益、不打分排名。
- 需要数据时先调工具拿客观数据，再基于数据回答；不要编造数字。
- 涉及个股时用工具查到的真实数据；讲清多空两面与风险，让用户自己判断。
- 用简洁中文回答。

{ANALYSIS_FRAMEWORK}

当前页面上下文：
{{context}}"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_quote",
            "description": "查 A 股实时行情：现价/涨跌/PE/PB/市值/换手/涨跌停。可批量。",
            "parameters": {
                "type": "object",
                "properties": {
                    "codes": {"type": "array", "items": {"type": "string"}, "description": "6 位股票代码列表，如 ['600519','000858']"},
                },
                "required": ["codes"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_valuation",
            "description": "查单只个股的完整估值：行情 + 机构一致预期 EPS + 前向PE/PEG/PE消化年数。",
            "parameters": {
                "type": "object",
                "properties": {"code": {"type": "string", "description": "6 位股票代码"}},
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_reports",
            "description": "查个股近期研报列表（标题/机构/评级/日期）。",
            "parameters": {
                "type": "object",
                "properties": {"code": {"type": "string", "description": "6 位股票代码"}},
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_news",
            "description": "查个股近期新闻（标题/时间/来源）。",
            "parameters": {
                "type": "object",
                "properties": {"code": {"type": "string", "description": "6 位股票代码"}},
                "required": ["code"],
            },
        },
    },
]


def _exec_tool(name: str, args: dict):
    """执行工具，返回可序列化结果（失败返回 error 字段，不抛）。"""
    try:
        if name == "query_quote":
            return astock.tencent_quote([str(c) for c in args.get("codes", [])])
        if name == "query_valuation":
            return astock.full_valuation(str(args["code"]))
        if name == "query_reports":
            rows = astock.eastmoney_reports(str(args["code"]), max_pages=1)[:15]
            return [{k: r.get(k) for k in ("title", "publishDate", "orgSName", "emRatingName")} for r in rows]
        if name == "query_news":
            rows = astock.stock_news(str(args["code"]), limit=15)
            return [{k: r.get(k) for k in ("新闻标题", "发布时间", "文章来源")} for r in rows]
        return {"error": f"未知工具 {name}"}
    except astock.DependencyMissing as e:
        return {"error": str(e)}
    except Exception as e:  # noqa: BLE001 — 工具错误回喂给模型，不中断循环
        return {"error": f"{name} 执行失败：{e}"}


def resolve_chat_completions_url(base_url: str) -> str:
    """把用户填的 baseURL 规范成 chat/completions 完整地址。

    兼容三种常见写法：
    - 根地址：https://api.deepseek.com → …/v1/chat/completions
    - 带版本：https://open.bigmodel.cn/api/paas/v4 → …/v4/chat/completions
    - 完整路径：https://…/v4/chat/completions → 原样使用（不再拼 /v1）
    """
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    version_suffixes = ("/v1", "/v2", "/v3", "/v4", "/api/v1", "/api/v2", "/api/v3", "/api/v4")
    if base.endswith(version_suffixes):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def _call_llm(cfg: dict, messages: list, use_tools: bool) -> dict:
    payload = {"model": cfg["model"], "messages": messages, "temperature": 0.3}
    if use_tools:
        payload["tools"] = TOOLS
        payload["tool_choice"] = "auto"
    r = requests.post(
        resolve_chat_completions_url(cfg["baseURL"]),
        headers={"Authorization": f"Bearer {cfg['apiKey']}", "Content-Type": "application/json"},
        json=payload,
        timeout=90,
    )
    if r.status_code != 200:
        raise RuntimeError(f"模型接口 HTTP {r.status_code}: {r.text[:300]}")
    return r.json()


def run_chat(cfg: dict, user_messages: list, context: str = "") -> dict:
    """跑一轮完整对话（含 function calling 循环）。

    cfg: {baseURL, apiKey, model}
    user_messages: [{role, content}, ...]
    返回: {content, trace:[{tool,args}], rounds}
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT.format(context=context or "（无）")}]
    messages.extend(user_messages)
    trace: list[dict] = []

    for rnd in range(1, MAX_ROUNDS + 1):
        data = _call_llm(cfg, messages, use_tools=True)
        choice = data["choices"][0]["message"]
        messages.append(choice)
        tool_calls = choice.get("tool_calls") or []
        if not tool_calls:
            return {"content": choice.get("content") or "", "trace": trace, "rounds": rnd}

        for tc in tool_calls:
            fn = tc["function"]
            name = fn["name"]
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            result = _exec_tool(name, args)
            trace.append({"tool": name, "args": args})
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": json.dumps(result, ensure_ascii=False)[:_TOOL_RESULT_CAP],
            })

    # 超过最大轮数，最后再要一次不带工具的收尾回答
    data = _call_llm(cfg, messages, use_tools=False)
    return {"content": data["choices"][0]["message"].get("content") or "", "trace": trace, "rounds": MAX_ROUNDS}


def run_chat_cli(cfg: dict, user_messages: list, context: str = "") -> dict:
    """订阅接入：用本机已登录的 CLI 一次性作答（无 function-calling）。

    CLI 不能像 API 那条自己调数据工具，所以数据必须已在 context 里（每日复盘 / 今日要点 /
    个股页问 AI 等场景，前端已把当页数据塞进 context）。
    """
    provider = str(cfg.get("provider", ""))
    kind = provider[4:] if provider.startswith("cli-") else provider
    system = SYSTEM_PROMPT.format(context=context or "（无）")
    user = "\n\n".join(m.get("content", "") for m in user_messages if m.get("content")) or "（无问题）"
    content = cli_runtime.run_cli(kind, system, user)
    return {"content": content, "trace": [], "rounds": 1}


# ---------------------------------------------------------------------------
# 流式版：yield 事件字典 {type: tool|delta|done|error}，供 /api/chat 以 NDJSON 推给前端
# ---------------------------------------------------------------------------

def _call_llm_stream(cfg: dict, messages: list, use_tools: bool):
    payload = {"model": cfg["model"], "messages": messages, "temperature": 0.3, "stream": True}
    if use_tools:
        payload["tools"] = TOOLS
        payload["tool_choice"] = "auto"
    r = requests.post(
        resolve_chat_completions_url(cfg["baseURL"]),
        headers={"Authorization": f"Bearer {cfg['apiKey']}", "Content-Type": "application/json"},
        json=payload, timeout=120, stream=True,
    )
    if r.status_code != 200:
        raise RuntimeError(f"模型接口 HTTP {r.status_code}: {r.text[:300]}")
    return r


def _iter_sse_deltas(resp):
    """解析上游 SSE 流，逐个 yield choices[0].delta。

    按字节缓冲、只解码「完整行」——`\\n` 是 ASCII(0x0A)不会落在多字节 UTF-8 字符内部，
    故按 `\\n` 切分再解码，避免 iter_lines(decode_unicode=True) 在网络分块处切断中文导致乱码。
    """
    buf = b""
    for chunk in resp.iter_content(chunk_size=None):
        if not chunk:
            continue
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            try:
                j = json.loads(data)
            except json.JSONDecodeError:
                continue
            choices = j.get("choices") or []
            if choices:
                yield choices[0].get("delta") or {}


def run_chat_stream(cfg: dict, user_messages: list, context: str = ""):
    """API 接入流式：function-calling 循环，边流答案边推工具调用事件。"""
    messages = [{"role": "system", "content": SYSTEM_PROMPT.format(context=context or "（无）")}]
    messages.extend(user_messages)
    trace: list[dict] = []

    for rnd in range(1, MAX_ROUNDS + 1):
        resp = _call_llm_stream(cfg, messages, use_tools=True)
        content_parts: list[str] = []
        tool_acc: dict[int, dict] = {}
        for delta in _iter_sse_deltas(resp):
            if delta.get("content"):
                content_parts.append(delta["content"])
                yield {"type": "delta", "text": delta["content"]}
            for tc in (delta.get("tool_calls") or []):
                idx = tc.get("index")
                if idx is None:
                    # 非标「OpenAI 兼容」网关可能不带 index：有 id 按 id 归位（新 id 开新槽），
                    # 无 id 则续拼最后一个调用，避免多个调用的 arguments 串到一起
                    tc_id = tc.get("id") or ""
                    idx = next((k for k, v in tool_acc.items() if tc_id and v["id"] == tc_id), None)
                    if idx is None:
                        idx = len(tool_acc) if (tc_id or not tool_acc) else max(tool_acc)
                acc = tool_acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                if tc.get("id"):
                    acc["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    acc["name"] = fn["name"]
                if fn.get("arguments"):
                    acc["arguments"] += fn["arguments"]

        if not tool_acc:  # 本轮是纯答案（已流完）→ 结束
            yield {"type": "done", "trace": trace, "rounds": rnd}
            return

        # 有工具调用：回填 assistant 消息 + 执行工具 + 推事件
        messages.append({
            "role": "assistant",
            "content": "".join(content_parts) or None,
            "tool_calls": [{
                "id": tool_acc[i]["id"], "type": "function",
                "function": {"name": tool_acc[i]["name"], "arguments": tool_acc[i]["arguments"]},
            } for i in sorted(tool_acc)],
        })
        for i in sorted(tool_acc):
            a = tool_acc[i]
            try:
                args = json.loads(a["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            yield {"type": "tool", "tool": a["name"], "args": args}
            result = _exec_tool(a["name"], args)
            trace.append({"tool": a["name"], "args": args})
            messages.append({
                "role": "tool", "tool_call_id": a["id"],
                "content": json.dumps(result, ensure_ascii=False)[:_TOOL_RESULT_CAP],
            })

    # 超过最大轮数：不带工具收尾（非流式一次拿完再吐）
    data = _call_llm(cfg, messages, use_tools=False)
    yield {"type": "delta", "text": data["choices"][0]["message"].get("content") or ""}
    yield {"type": "done", "trace": trace, "rounds": MAX_ROUNDS}


def run_chat_cli_stream(cfg: dict, user_messages: list, context: str = ""):
    """订阅接入流式：CLI stdout 边出边推 delta。"""
    provider = str(cfg.get("provider", ""))
    kind = provider[4:] if provider.startswith("cli-") else provider
    system = SYSTEM_PROMPT.format(context=context or "（无）")
    user = "\n\n".join(m.get("content", "") for m in user_messages if m.get("content")) or "（无问题）"
    for chunk in cli_runtime.run_cli_stream(kind, system, user):
        yield {"type": "delta", "text": chunk}
    yield {"type": "done", "trace": [], "rounds": 1}
