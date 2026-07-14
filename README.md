# Vibe-Research · 个人 AI 投研系统（A股 / 美股 / 港股 / 韩股）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![GitHub](https://img.shields.io/badge/GitHub-lichard1220%2FVibe--Research--main-181717?logo=github)](https://github.com/lichard1220/Vibe-Research-main)

**[功能](#-功能) · [快速开始](#-快速开始) · [Docker 部署](#-docker-部署) · [接入 AI](#-接入-ai) · [合规](#️-合规) · [致谢](#-致谢)**

> **Vibe-Research: Your Personal Trading Research Agent**  
> 每日复盘、资讯雷达、个股数据、板块中心、我的持仓、研究记录。把数据和功能配齐，由**你自己的 AI** 驱动投资研究。

本仓库由 [lichard1220](https://github.com/lichard1220) 维护并发布，基于上游开源项目 [simonlin1212/Vibe-Research](https://github.com/simonlin1212/Vibe-Research) 继续演进（持仓止盈止损、近五日动能、交易纪律与次日准备、今日想法、韩股指数等）。**不荐股、不做买卖建议**——方向和结论交给你自己配置的模型。

---

## ✨ 功能

| 页面 | 包含的模块 / 能力 |
|---|---|
| **每日复盘** | 大盘指数 · **全球市场**（美股道指/标普/纳指 · 港股恒指/恒生科技 · **韩股 KOSPI / KOSPI200**）· 关注股票 · **今日想法**（按日本地记录）· **交易纪律** · **AI 当日复盘 / 次日操作准备**（注入想法+纪律+持仓+市场摘要）· 短线情绪 · 成交额 TOP20 · 市场情绪 · 板块资金 |
| **资讯雷达** | 12 赛道 108 个公开 RSS · AI 「今日要点」· A 股公告/新闻（挂钩关注列表）|
| **个股数据** | **A 股**：行情 · 估值 · 财报 · 分位 · 研报 · 公告 · 资金面 · 龙虎榜 · 解禁等。**美/港股**（`AAPL` / `00700`）：行情 + 关键财务 |
| **板块中心** | 板块 + 产业链环节骨架 |
| **我的持仓** | 成本盈亏 · **止盈/止损区间**（相对成本% 或绝对价格）· **近 5 日盘内高低与偏涨/偏跌判定** · 预警标记 · 已清仓记录（本地 JSON，不上传）|
| **研究记录** | 复盘 / 要点 / 问 AI / 次日准备结果本地沉淀 |
| **接入 AI** | 本机 CLI 订阅 · OpenAI 兼容 API · MCP |

> **五日动能口径**：用现价对照近 5 个交易日日 K 的盘内最高/最低，比较「自低点涨了多少」与「自高点回撤多少」，判定偏涨 / 偏跌 / 中性（确定性公式，非大模型计算）。  
> **止盈止损**：用户自设区间；触及状态与提前量由后端公式判定；AI 只读取结果做对照纪律的检查清单。

投研分析框架：估值 / 资金面 / 财报 / 行业 / 事件风险五维组织结论——只规定「怎么读数据」，不规定买卖。

---

## 📡 数据源

仓库内已集成数据工具箱，`git clone` 即可用：

| 目录 | 说明 |
|---|---|
| [`a-stock-data/`](a-stock-data/) | A 股全栈数据（上游 [a-stock-data](https://github.com/simonlin1212/a-stock-data)） |
| [`global-stock-data/`](global-stock-data/) | 美港股数据（上游 [global-stock-data](https://github.com/simonlin1212/global-stock-data)） |
| `backend/newsradar.py` + `news_sources.json` | 全球资讯 RSS（上游 [investment-news](https://github.com/simonlin1212/investment-news)） |

公开行情源（腾讯 / 东财等）仅做客观整理；**不推荐、不预测、不打分**。

## 🏗 架构

```
Vibe-Research/
├── a-stock-data/         A 股数据工具箱
├── global-stock-data/    美港股数据工具箱
├── backend/              FastAPI :8900
│   ├── astock.py / gstock.py / market.py
│   ├── portfolio.py      持仓 · 止盈止损 · 五日动能
│   ├── chat.py / mcp_server.py
│   └── newsradar.py
├── frontend/             Vite + React 19 + TS + Tailwind :5899
└── docker-compose.yml    一键部署
```

本地敏感数据：

| 数据 | 位置 |
|---|---|
| 持仓 / 止盈止损 | `backend/.cache/portfolio.json`（Docker volume `backend-cache`）|
| 交易纪律 | 浏览器 `localStorage` · `vr-discipline` |
| 今日想法 | 浏览器 `localStorage` · `vr-daily-thoughts`（按日）|
| LLM / 访问密钥 | 浏览器本地，不进仓库 |

## 🚀 快速开始

### 本地开发

```bash
# 后端 :8900
cd backend
python3 -m venv .venv
# Windows: .venv\Scripts\pip install -r requirements.txt
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8900

# 前端 :5899
cd frontend
npm install
npm run dev
# 打开 http://localhost:5899
```

### Docker 部署

```bash
# 仓库根目录
docker compose up -d --build

# 前端 http://localhost:5899
# 后端 http://localhost:8900 （经前端 /api 代理）
```

持仓数据在 Docker volume `backend-cache` 中持久化；更新代码后同样执行 `docker compose up -d --build` 即可重建。

可选环境变量（见 [`docker-compose.yml`](docker-compose.yml)）：

- `VR_ALLOW_ORIGINS`：CORS（默认指向 `http://localhost:5899`）
- `VR_API_KEY`：后端访问鉴权（公网建议设置；前端「接入 AI」页填写同一密钥）

## 🔌 接入 AI

在「接入 AI」页配置一次，全站「问 AI / 复盘 / 次日准备 / 要点」都会用你的模型。

1. **订阅接入**：本机已登录的 Claude Code / Codex / Qwen / Gemini / DeepSeek CLI（免 key；适合数据已打包的场景）
2. **API 接入**：DeepSeek / 豆包 / OpenAI / OpenRouter 等 OpenAI 兼容端点（支持 function-calling）
3. **MCP**：见 [`backend/README.md`](backend/README.md)

## 🧪 测试

```bash
cd backend
pip install -r requirements-dev.txt   # 或使用已有 venv
pytest -m "not live"                  # 离线单测
pytest -m live                        # 联网核对（可选）
```

## ⚖️ 合规

- 只做客观数据整理与公开榜单呈现：**不荐股、不预测涨跌、不给买卖时机、不承诺收益**
- 止盈止损、交易纪律、今日想法均为**用户自设**；五日动能与区间状态为**确定性统计/公式**
- AI 输出仅为对照规则与数据的梳理 / 检查清单，**不构成投资建议**
- 持仓、密钥、纪律、想法均存本地，不上传、不进仓库

## 🙏 致谢

- 上游产品与数据生态：[simonlin1212/Vibe-Research](https://github.com/simonlin1212/Vibe-Research)、[a-stock-data](https://github.com/simonlin1212/a-stock-data)、[global-stock-data](https://github.com/simonlin1212/global-stock-data)、[investment-news](https://github.com/simonlin1212/investment-news)（作者 Simon）
- 界面设计语言参考：[HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)（仅借鉴 UI）

## 📬 反馈

本仓库维护者：[lichard1220](https://github.com/lichard1220)  
问题与建议请提 [Issues](https://github.com/lichard1220/Vibe-Research-main/issues)。

## ⚠️ 免责声明

本项目仅供学习与研究，**不构成任何投资建议**。股市有风险，请独立决策、自行核实，风险自担。

## 📄 License

MIT
