# Vessel

> 自组织 Agent Harness。极简核心。两个插槽。一个通用循环。填 Key 即跑，自己会长大。

[![Status: pre-MVP](https://img.shields.io/badge/status-pre--MVP-orange)](docs/specs/ROADMAP.md)
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

pre-MVP / 脚手架阶段。架构与边界已锚定（见下文档），代码待建。

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

`[plan]` 待脚手架就绪后补充。预期：

```bash
npx vessel                      # 零安装运行（需 Node）
# 或下载单二进制                 # 无需 Node
```

首启向导引导填 API Key → REPL 对话 → 让 agent 调工具干活。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前请读 [CLAUDE.md](CLAUDE.md) 红线与能力分层决策树。

## 许可证

MIT
