---
title: 概览与分层
kind: current
triggers: [architecture, layering, dependency, kernel, module, adapter, core, philosophy]
paths: [packages/core/**, packages/**, plugins/**]
---

# 概览与分层

<a id="layering"></a>

## 三层结构与依赖方向

> 本节及下方「分层与模块边界」描述**当前已实现**的结构；Kernel / Modules 的决策见 [ADR-037](../adr/ADR-037-modular-agent-runtime.md)。

```
apps/web                 网页控制台（v1；durable / MCP 面板）
    │
packages/serve           常驻服务 gateway（--serve；loopback / 远程 + TLS）
packages/tui             终端界面：Ink REPL、流式渲染、slash 命令、/mcp、/runs
    │
packages/config          声明式 YAML 配置：加载、校验（未知键报错）、snake_case→camelCase 映射
    │
packages/core            运行时：tool-calling loop、provider 抽象、context、session、事件流、
                         权限策略、guardrail/hook 编排、PluginHost、Kernel、RunStore
                         ← 零 UI 依赖，可独立嵌入
packages/permission      共享权限原语（工具经事件流等用户授权）
plugins/mcp/client       MCP client 插件（stdio + HTTP），经 PluginHost 注册工具
```

**依赖方向单向**：`core` 不引用 `config` / `tui` / `serve` / `plugins`，也直接不引用任何厂商 SDK。`core` 的 `dependencies` 为空。

`plugins/` 与 `core` 的关系是**注入**而非依赖：插件在 `install(host)` 里往 `PluginHost` 注册工具 / provider / guardrail / hook。MCP 是插件，不是 core 模块（ADR-039）。

`src/` 是装配层（`bootstrap.ts` 把 config → provider → plugins → runtime → ReplContext 串起来），不属于任何包。

**分层与模块边界（[ADR-037](../adr/ADR-037-modular-agent-runtime.md)）**

- 分层：`Contracts ← Kernel ← Modules ← SDK ← Shells`；`Plugins` 只依赖 Contracts / 公开 API，经 `PluginHost` 在运行期 install。
- **Module ≠ Plugin**：Module 是编译期 / 构造期边界（provider / context / session / policy / transport / observability，一个 port 一个实现）；Plugin 仍是唯一运行期扩展机制；禁止 `ModuleHost` / `ModuleRegistry`。
- core 内只做 ports & adapters 与 `@vessel-agent/core/<port>` subpath exports，不拆包；`types/**` 不 import 实现，模块只经 port 交互。
- `AgentRuntime` 仍是单 agent tool-calling loop；Host / Scheduler 只提供注册、生命周期、调度与边界，不重写循环。

<a id="philosophy"></a>

## 核心哲学：语言空间与两个适配器

**把判断留给模型。** Vessel 只提供能力、证据与边界，不规定模型怎么完成任务：不加强制流程、
不预设工具次数、不替模型做策略选择。限制只用于安全（路径 / 密钥 / 权限）与不可逆操作；
其余交给模型，出错用反馈修正，而不是加闸门。

**少一层就是一层。** 能复用现有事件 / 消息 / 快照 / 通知就不新增存储、RPC 或控制层；
每加一个实体先证明现有机制做不到。

**LLM 只活在语言空间里。** 它看不见文件系统、看不见终端、看不见网络。Vessel 的全部工作就是维护两个方向的折叠：

```
        ┌──────────────── 世界 ────────────────┐
        │  文件 / 命令 / 网络 / git / 用户       │
        └──────────────────────────────────────┘
                 ↑ ② 语言 → 世界              │ ① 世界 → 语言
                 │  tool_calls 解析 → 执行     │  system prompt + 消息 + 工具 schema
        ┌──────────────── 语言空间 ─────────────┐
        │            LLM（唯一的执行面）          │
        └──────────────────────────────────────┘
```

- **① 世界 → 语言**：`ContextManager` 里的消息 + 工具 schema（`PluginHost.listTools()`）+ system prompt，组成一次 `ChatRequest`。
- **② 语言 → 世界**：解析 `tool_calls` → 权限判定 → 执行 handler → 结果作为 `role: tool` 消息折回语言空间。

**两个插槽**是这套折叠的全部可扩展点：

| 插槽 | 实现 | 放什么 |
|---|---|---|
| **工具** | `PluginHost` | 语言 → 世界的能力。`PluginHost` 是**唯一的工具注册表**（core 里没有第二个） |
| **知识** | `ContextManager` | 世界 → 语言的输入。消息、system prompt、注入的文本 |

其余扩展点（guardrail、hook、provider、session backend）都挂在 `PluginHost` 上，不新增插槽。

**core 不认识业务概念。** core 里没有 skills、记忆、资产、附件这些词。任何要进语言空间的文本——技能文件、项目约定、引用材料——都经 `RunOptions.messages` 注入，**core 不解释它的来源与语义**（见 [runtime-api.md](runtime-api.md#messages)）。

