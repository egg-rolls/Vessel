# Vessel

> 面向无基础/弱基础用户的 AI Agent Harness 应用。

[![Status: pre-MVP](https://img.shields.io/badge/status-pre--MVP-orange)](docs/ROADMAP.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#许可证)

## 这是什么

Vessel 是一个 **Harness 应用**：让不会写代码的人也能跑起、配置、扩展自己的 AI Agent。它不是给开发者的"框架"，而是一个**开箱即用的应用**，同时为愿意深入的人保留插件扩展能力。

形态上参考 Claude Code：一个交互式终端（TUI）作为主入口，背后是一个极简、可嵌入的运行时核心。

## 为谁

- **无基础用户** - 只用 TUI，填个 API Key 就能跑。
- **弱基础用户** - 改 YAML 配置定义自己的 agent/工具。
- **开发者** - 写 TypeScript 插件扩展能力，或把 `@vessel/core` 嵌入自己的应用。

## 状态

pre-MVP / 脚手架阶段。架构与边界已锚定（见下文档），代码待建。

## 文档索引

| 文档 | 作用 | 给谁看 |
|------|------|--------|
| [docs/PRD.md](docs/PRD.md) | 产品需求：愿景、用户、范围、成功指标 | 所有人，先看 |
| [docs/SPEC.md](docs/SPEC.md) | 技术规范：架构、模块、接口契约、执行模型 | 开发者 / AI |
| [docs/ADR.md](docs/ADR.md) | 架构决策记录：每个关键选择的"为什么" | 开发者 / AI |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 路线图：MVP 边界与分期交付 | 所有人 |
| [docs/PLUGINS.md](docs/PLUGINS.md) | 插件 backlog 目录：行业常见功能的插件化清单 | 开发者 / AI |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | 术语表 | 所有人 |
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
