# Vessel

> 自组织 Agent Harness。极简核心。两个插槽。一个通用循环。填 Key 即跑。

[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](#状态)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](#许可证)

## 这是什么

Vessel 是一个**自组织 Agent Harness**——不是给你 50 个工具的 Agent，而是一个**只给最必要工具、其余能力由模型自己组合出来**的 Agent。

| | 传统 Agent 工具 | Vessel |
|---|---------------|--------|
| **能力从哪来** | 给你 50 个工具，自己挑 | 给最必要的三个能力工具，剩下的由模型用它们组合 |
| **绑谁** | 绑一个 LLM 厂商 | 填 Key 即跑，Provider 无关，高频迭代切便宜模型 |
| **范式** | 做一个场景 | 一个 while 循环兜住 Harness / Loop Engineering |
| **核心** | 框架式大 core | 9 个接口、2 个插槽、1 个循环。MIT 开源，core 可嵌入任何应用 |

三层架构：`@vessel/core`（运行时，可独立嵌入）+ `@vessel/config`（声明式配置）+ `@vessel/tui`（Claude-Code 式终端）。形态上参考 Claude Code，但 Provider 无关、范式无关、开源。

## 为谁

- **无基础用户** — 只用 TUI，填 Key 即跑。
- **弱基础用户** — 改 YAML 定义 provider 与 agent。
- **开发者** — 写 TypeScript 插件扩展能力，或把 `@vessel/core` 嵌入 Slack bot / CI / 桌面 app。

## 状态

**alpha。Phase 0 / Phase 1 实现中。**

**已落地的包**（bun workspaces monorepo）：

| 包 | 版本 | 作用 |
|---|---|---|
| **`@vessel/core`** | 0.1.0 | Agent 运行时：tool-calling loop、provider 抽象、context / session、事件流、guardrails、hooks。**不依赖 TUI，可独立嵌入** |
| **`@vessel/tui`** | 0.1.0 | 终端界面：Ink REPL、流式渲染、slash 命令、工具执行前权限确认 |
| **`@vessel/config`** | 0.1.0 | 声明式 YAML 配置与 schema 校验（未知键报错） |
| **`@vessel/permission`** | 0.1.0 | 共享权限原语：工具经事件流等用户授权 |
| **`@vessel/serve`** | 0.1.0 | 常驻服务（gateway，`--serve` 模式） |
| `apps/web` | 0.1.0 | 浏览器控制台：时间线、运行取消、权限弹窗、ask_user（`vessel.gateway/1`） |

- CI：`.github/workflows/ci.yml`（质量门禁、跨平台矩阵、web 构建、examples 类型检查、mock 冒烟）。
- ⚠️ **0.1.0 尚未发布**：库包版本为 `0.1.0`，发布流程已就绪；当前请从源码运行。

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

`VESSEL_MOCK=1` 是**模拟模式**：不调真实模型，用本地模拟响应把整条链路跑通 —— **没有 Key 也能完整体验对话、工具调用、流式渲染与会话管理。**

### ② 接入真实模型

```bash
bun run src/cli.ts
```

首次启动走**引导向导**，填 API 地址、Key、选模型，保存到 `~/.vessel/config.yaml`，之后无需重填。

### ③ 其它常用命令

```bash
bun run src/cli.ts --run "帮我写个冒泡排序"      # 一次性执行后退出（适合脚本）
bun run src/cli.ts --run @prompt.md            # 从文件读 prompt（.json = 多轮 seeding）
echo "翻译这句话" | bun run src/cli.ts --run    # 从管道读输入
bun run src/cli.ts --session <id> --run "..."   # 续接指定会话
bun run src/cli.ts --serve                      # 纯 serve 常驻模式（不进 REPL）
bun test                                        # 跑测试
```

REPL 内用 `/help` 看全部 slash 命令（`/resume` `/new` `/history` `/tools` `/plugins` `/setup` `/reload` `/clear` `/exit`）。

- `/clear` 清屏，**不清空会话上下文**；需要新会话用 `/new`。
- `/reload` 重新加载配置文件并刷新 provider 信息；**不重扫插件目录**，新增插件需重启进程。
- 输入里的 `@路径` 会在发送前展开为注入消息，界面上以引用块显示，用户原文保持不变。

## 架构

**语言空间是唯一的执行面。** Vessel 做两件事：把世界折成语言（system prompt + 消息 + 工具 schema），把语言折回世界（解析 tool_calls → 执行 → 结果折回消息）。

- **9 个接口 + 1 个循环 + 2 个插槽**：`LLMProvider` / `ContextManager` / `EventStream` / `ToolDefinition` / `SessionBackend` / `LimitChecker` / `Guardrail` / `Hook` / `Plugin` + `PluginHost`。两个插槽是**工具**（`PluginHost` 是唯一的工具注册表）与**知识**（`ContextManager`）。
- **core 不认识业务概念**：不认 skills、不认记忆、不认资产。任何要进语言空间的文本都经 `RunOptions.messages` 注入，core 只负责按序放进消息数组。

细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 工具集

运行期 `/tools` 列出 **5 个**：三个来自 `plugins/tools/basic-tools` 的**能力工具**，加两个由装配层注册的**接缝工具**。

**能力工具（3）—— 模型干活就靠这三个：**

| 工具 | 干什么 |
|---|---|
| `bash` | 执行命令。grep / cat / ls / python / mkdir / curl / git —— 一切命令行操作 |
| `read` | 读文件，带行号，支持 `offset` / `limit` |
| `edit` | 精确字符串替换写文件，`old_string` 必须唯一匹配 |

**接缝工具（2）—— 装配层注册，不是能力：**

| 工具 | 干什么 |
|---|---|
| `ask_user` | 交互模式下向用户提问。**仅 REPL 注册** |
| `delegate_task` | 派发子 agent 处理子任务，只回收最终文本 |

headless 模式没有 TUI 订阅者，`ask_user` 不注册——所以那里是 **4 个**。

**为什么这么少？** 这是刻意的。没有 `grep` 工具、没有 file-ops、没有 MCP 客户端——**能被 bash 组合出来的能力，就不再单开一个工具**。工具越多，模型的选错空间越大、核心越难保持小。真正的通用原语只有一个：执行命令。其余都是它的特化。

## Skills 怎么用

**skills 就是文件，不是一条加载通道。** harness 不扫描、不解析、不注入 skills —— 它只认消息。

- REPL 输入里的 `@路径` 会在发送前被展开：文件内容作为一条注入消息进本轮请求，界面上显示为引用块。用户原文保持不变。
- 技能就是 markdown 文件，放两个位置：仓库 [`skills/`](skills/)（**项目级**，随仓库提交、团队共享）与 `~/.vessel/skills/`（**用户级**，跨项目复用）。这是**约定**——代码里没有任何地方硬编码这两个路径。
- 引用方式：`@skills/code-writing.md`。

同一机制可用于引用任何文件：附件、项目约定、上下文材料。**前端负责查找与引用，core 只收消息。**

## Web 控制台

`--serve` 启动本地 gateway（默认端口 8642），浏览器控制台通过 `vessel.gateway/1` 连接。

```bash
VESSEL_MOCK=1 bun run src/cli.ts --serve 8642   # 终端打印 token
cd apps/web && npm run dev                       # http://127.0.0.1:5173
```

- 打开控制台后把终端里的 token 粘到 URL fragment（`#token=...`）；token 随后转入 `sessionStorage`。
- 功能：运行提交/取消、事件时间线、会话列表、工具列表、权限弹窗、ask_user 表单。
- 协议：WS `/v1/events?since=`（`seq` 续订 / `gap`）；REST `/v1/runs`、`/v1/sessions`、`/v1/tools`、`/v1/permissions/:id`、`/v1/ask/:id`。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §13。
- 安全默认：只绑 `127.0.0.1`，Host/Origin 校验，首帧鉴权，1 MiB 请求体上限。
- 生产同源托管：gateway 配 `staticDir` 时直接托管 `apps/web/dist`（装配层接线后生效）；开发时用 Vite proxy。
- 0.1.0 限制：单 runtime / 单 context，并发 1；运行与事件历史在内存；team 协议为 0.2 草案。

## 发布与更新

- 发布由 tag `v*` 触发，流程见 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。
- 0.1.0 发布 `@vessel/*` 库包与插件包；**根 CLI 暂不发布到 npm，`npx vessel` 不可用**。
- **0.1.0 不提供独立二进制**（ADR-006 继续有效）。
- 发布流程会生成 `latest.json`（`version` / `channel` / `assets: {}`），供未来的 `vessel update --check` 使用；**更新客户端尚未实现**。
- 通道：稳定版 `latest`，预发布 `beta`。

## 延后项

以下能力**尚未实现**，明确不在本期范围：

- **MCP** —— 本期不做。工具集里没有 MCP 客户端；接外部系统先用 `bash`（`curl` / CLI）顶。
- **workflow / team / durable execution / evals** —— 未开始。
- **Agent team / 跨节点任务** —— gateway 的 `team.*` 为 0.2 草案，0.1.0 返回 `method_not_allowed`。
- **npm CLI** —— 0.1.0 只发库包与插件包，根 CLI 未发布，`npx vessel` 不可用。
- **独立二进制 / 自动更新客户端** —— 0.1.0 不做；`latest.json` 已生成，但 `vessel update` 尚未实现。

## 文档索引

| 文档 | 作用 | 给谁看 |
|------|------|--------|
| [README.md](README.md) | 是什么 / 怎么跑 / 延后项 | 所有人，先看 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术架构：分层、循环、两个插槽、扩展模型、接口签名、事件名 | 开发者 / AI |
| [docs/ADR.md](docs/ADR.md) | 架构决策记录：每个关键选择的「为什么」（只追加存档） | 开发者 / AI |
| [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md) | 文件放哪里、路径归属、分支与发布规则 | 贡献者 / AI |
| [docs/operations/RELEASE.md](docs/operations/RELEASE.md) | 怎么发版 | 维护者 |
| [docs/operations/CI-CD.md](docs/operations/CI-CD.md) | CI / CD / 自动更新怎么跑 | 维护者 |
| [AGENTS.md](AGENTS.md) | AI 行为约定：风格、硬规矩、怎么跑、红线 | AI 代理必读 |

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT
