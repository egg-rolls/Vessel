# Vessel

> 自组织 Agent Harness。极简核心。两个插槽。一个通用循环。填 Key 即跑，自己会长大。

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](docs/specs/ROADMAP.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#许可证)

## 这是什么

Vessel 是一个**自组织 Agent Harness**——它不是一个装了 50 个工具的 Agent，而是一个**会自己装工具的 Agent**。

| | 传统 Agent 工具 | Vessel |
|---|---------------|--------|
| **能力从哪来** | 给你 50 个工具，自己挑 | 启动时只有元 Skills。Agent 发现缺口 → 自己装工具/接 MCP/写 Skill |
| **绑谁** | 绑一个 LLM 厂商 | 填 Key 即跑。任何 Provider。高频迭代切便宜模型 |
| **范式** | 做一个场景 | 一个 while 循环兜住 Harness Engineering、Loop Engineering、A2A、树搜索 |
| **核心** | 框架式大 core | 9 个接口、2 个插槽。MIT 开源。core 可嵌入任何应用 |
| **认知启动** | 裸 agent，靠模型自己摸索 | BIOS（asset-introspection Skill）在第一轮就告诉 Agent 怎么查自己、怎么补缺口 |

三层架构：`@vessel/core`（运行时，可独立嵌入）+ `@vessel/config`（声明式配置）+ `@vessel/tui`（Claude-Code 式终端）。形态上参考 Claude Code，但 Provider 无关、范式无关、开源。

## 为谁

- **无基础用户** — 只用 TUI，填 Key 即跑。Agent 自己装能力，不需要人懂技术。
- **弱基础用户** — 改 YAML 配置定义 agent/工具。Agent 改不动的才找人。
- **开发者** — 写 TypeScript 插件扩展能力，或把 `@vessel/core` 嵌入 Slack bot / CI / 桌面 app。

## 状态

**Phase 0 / Phase 1 实现中**（分期定义见 [ROADMAP](docs/specs/ROADMAP.md)）。

**已落地的包**（`bun workspaces` monorepo）：

| 包 | 版本 | 作用 |
|---|---|---|
| **`@vessel/core`** | 0.1.0 | Agent 运行时：tool-calling loop、provider 抽象、context / session、事件流、guardrails、hooks。**不依赖 TUI，可独立嵌入** |
| **`@vessel/tui`** | 0.1.0 | 终端界面：Ink REPL、流式渲染、slash 命令、工具执行前权限确认 |
| **`@vessel/config`** | 0.1.0 | 声明式 YAML 配置与 schema 校验（未知键报错） |
| **`@vessel/permission`** | 0.1.0 | 权限与授权 |
| **`@vessel/serve`** | 0.1.0 | 常驻服务（gateway，`--serve` 模式） |
| `apps/web` | — | 网页控制台 |

**工程状态**

- 测试：**175 个测试文件**（`bun test`）
- CI：`.github/workflows/ci.yml`（lint + typecheck + test + build）+ release 流水线 + 标签同步
- **MVP 验收表**：[docs/dev/ACCEPTANCE.md](docs/dev/ACCEPTANCE.md) —— 从**用户视角**列出 7 个模块约 50 项验收项（每项含操作方式与通过标准），**尚未逐项验收**（状态列仍为空）
- ⚠️ **尚未发布到 npm**：`@vessel/*` 各包为 `0.1.0` 且已具备发布条件，**当前请从源码运行**（见下节）

## 文档索引

| 文档 | 作用 | 给谁看 |
|------|------|--------|
| [docs/specs/PRD.md](docs/specs/PRD.md) | 产品需求：愿景、用户、范围、成功指标 | 所有人，先看 |
| [docs/specs/SPEC.md](docs/specs/SPEC.md) | 技术规范：架构、模块、接口契约、执行模型 | 开发者 / AI |
| [docs/specs/ADR.md](docs/specs/ADR.md) | 架构决策记录：每个关键选择的"为什么" | 开发者 / AI |
| [docs/specs/ROADMAP.md](docs/specs/ROADMAP.md) | 路线图：MVP 边界与分期交付 | 所有人 |
| [docs/specs/PLUGINS.md](docs/specs/PLUGINS.md) | 插件 backlog 目录：行业常见功能的插件化清单 | 开发者 / AI |
| [docs/specs/GLOSSARY.md](docs/specs/GLOSSARY.md) | 术语表 | 所有人 |
| [CLAUDE.md](CLAUDE.md) | AI 开发操作手册：规范、红线、命令 | AI 代理必读 |
| [legacy/](legacy/) | 旧项目遗产与教训（背景资料） | 选读 |

**阅读顺序**：README → PRD → SPEC → ADR → ROADMAP → GLOSSARY → CLAUDE.md。

## 快速开始

前置：[Bun](https://bun.sh)（`bun --version` 确认可用）。

```bash
git clone https://github.com/egg-rolls/Vessel.git
cd Vessel
bun install
```

### ① 先跑起来看看（**不需要 API Key**）

```bash
VESSEL_MOCK=1 bun run src/cli.ts
```

`VESSEL_MOCK=1` 是**模拟模式**：不调真实模型，用本地模拟响应把整条链路跑通 ——
**没有 Key 也能完整体验对话、工具调用、流式渲染与会话管理。**

### ② 接入真实模型

```bash
bun run src/cli.ts
```

首次启动走**引导向导**，引导你填 API 地址、Key、选模型，保存到 `~/.vessel/config.yaml`，之后无需重填。

### ③ 其它常用命令

```bash
bun run src/cli.ts --run "帮我写个冒泡排序"      # 一次性执行后退出（适合脚本）
echo "翻译这句话" | bun run src/cli.ts --run     # 从管道读输入
bun run src/cli.ts --serve                       # 纯 serve 常驻模式（不进 REPL）
bun test                                         # 跑测试
```

> 📌 **分发方式**：计划走 `npx vessel` 与 GitHub Release（见 [ROADMAP](docs/specs/ROADMAP.md) Phase 1 与 ADR-006，弃单二进制）。
> **当前尚未发布到 npm**，请按上面的源码方式运行。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前请读 [AGENTS.md](AGENTS.md) 红线（§4）与能力分层决策树（§6）。

## 许可证

MIT
