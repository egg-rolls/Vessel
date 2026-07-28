# 任务分工

> 当前分工与任务清单。状态/进度信息允许在本文件(`processes/*`);永久文档(`docs/specs|guides|api`)不允许。
> 协作流程见 [collaboration.md](collaboration.md);命名见 [conventions.md](conventions.md)。

## 一、当前进度

| Phase | 状态 | 证据 |
|-------|------|------|
| 0 脚手架 | ✅ 完成 | monorepo;CI 四件套全绿(lint/typecheck/test/build);单二进制可出 |
| 1 MVP-core | ✅ 完成 | runtime loop / provider(流式 SSE + 注册制) / context+auto-compact / session(memory+file+sqlite) / EventStream(含 LlmStreamChunk) / limits(含 AbortSignal) / guardrail+hook 接口 / PluginHost / 动态插件加载 / **Core 冻结(ADR-017)**;73 测试过 |
| 1 MVP-tui | 🚧 egg-rolls 实现中 | REPL-1~7 完成：`startRepl(ctx)` readline 循环 + 二层 slash 命令(`/session list\|resume\|new\|history`、`/tool list`、`/help /clear /setup /exit`)+ StreamRenderer 流式 token + Hermes `/session resume` pending one-shot + 权限 guardrail(Plugin 注入)+ 默认插件(file-ops/memory-project)+ 错误分类;99 测试过;CI 四件套全绿 |

## 二、新分工（emma 速度慢，egg-rolls 平推全部核心逻辑）

**原则**：egg-rolls 交付完整可跑的 App（所有功能逻辑 + 基础 UI）。emma 拿到接口文档后**仅做 UI/UX 替换**——不写任何功能逻辑。

| 层 | egg-rolls 做 | emma 做 |
|----|-------------|---------|
| **Core** | ✅ 已冻结 | 不改 |
| **Config** | ✅ 已冻结 | 不改 |
| **Shell (cli.ts)** | ✅ 已重构 | 不改 |
| **REPL 循环** | readline 对话循环 + 全部 slash 命令逻辑 | 换 Ink 框架 |
| **Slash 命令** | `/help /tools /sessions /resume /new /history /clear /setup /exit` 全部功能 | `/` 弹菜单 UI + autocomplete + 模糊过滤 |
| **流式输出** | StreamRenderer 订阅 events → `console.log` token | token-by-token 动画 + 工具卡片 + spinner |
| **会话管理** | /resume pending one-shot / 空会话丢弃 / session 列表 | session 表美化（已有 `buildSessionTable`） |
| **权限确认** | `ToolPermissionChecker` + readline `confirm()` | 图形弹窗替换 readline |
| **首启向导** | `runSetupWizard` 流程 | 向导 UI 打磨 |
| **错误处理** | 分类展示（网络/API/限额） | 错误提示美化 |
| **富渲染** | — | banner / 状态栏 / Markdown / 颜色主题 |

## 三、功能流水线（F 线）

egg-rolls 的每个节点产出**可跑的功能**，emma 在节点上挂 **UI/UX 替换**。

```
① CLI 入口      ② 配置加载      ③ Provider     ④ 插件加载      ⑤ Runtime
   │               │               │              │               │
   └─ 她: help     └─ 她: /setup   └─ 她: /model  └─ 她: /plugins └─ 她: 状态栏
      文本            向导 UI          选择器          管理面板         显示
       
       ⑥ REPL 循环      ⑦ LLM 调用       ⑧ 工具执行       ⑨ 响应输出
          │               │               │               │
          └─ 她: Ink       └─ 她: stream    └─ 她: card      └─ 她: markdown
             替换 readline    token 动画        spinner         渲染 + 颜色
```

### 节点详情

| 节点 | egg-rolls 交付 | emma 挂载点 | 接口 |
|------|---------------|-----------|------|
| ① CLI | argv 解析、--run headless、--session、--pipe、--help | help 文本美化 | 无（纯字符串） |
| ② Config | 加载链（env→vessel.yaml→~/.vessel→默认）、首启向导流程 | `/setup` 向导 UX | `runSetupWizard()` |
| ③ Provider | 6 个 provider 插件全量加载、`config.provider.name` 选 provider | `/model` 切换 UI | `ReplContext.provider` |
| ④ Plugins | `PLUGIN_IMPORT_MAP` 16 插件、`config.plugins` 驱动加载 | `/plugins` 管理面板 | `ReplContext.plugins` |
| ⑤ Runtime | `AgentRuntime` 构造、`await runtime.ready`、guardrail 注册 | 状态栏（provider/model/session/plugins）| `ReplContext.{provider,plugins}` |
| ⑥ REPL | readline 对话循环、9 个 slash 命令、session 管理 | Ink 框架替换、`/` 弹菜单 | `startRepl(ctx)` |
| ⑦ LLM | `runtime.run()` 调 provider、`LlmStreamChunk` 事件流 | token-by-token 流式动画 | `EventStream.subscribe(LlmStreamChunk)` |
| ⑧ Tool | `ToolPermissionChecker.confirm()` readline 弹窗 | 图形确认弹窗 | `createPermissionGuardrain()` |
| ⑨ Output | `console.log` 输出、错误分类 | Markdown 渲染、颜色主题 | `StreamRenderer` |

## 四、emma 接口文档（待写）

交付物：`docs/api/tui.md`

内容：
- `ReplContext` 字段说明
- `startRepl(ctx)` 签名 + 调用示例
- 替换清单：哪些函数/模块可以单独替换（readline→Ink、confirm→弹窗、console.log→Markdown）
- 不动的边界：core/config/壳/插件加载/session 逻辑
- 事件订阅示例（`LlmStreamChunk`、`ToolCallStarted`、`RunCompleted`）

## 五、egg-rolls 后续任务

### 第一梯队：让 App 完整跑起来

- [x] REPL-1：实现 `startRepl(ctx)`——readline 对话循环 + 全部 9 个 slash 命令
- [x] REPL-2：StreamRenderer 实际订阅 `ctx.events`——流式 token 输出
- [x] REPL-3：Session 管理——/resume pending one-shot、/new、/history、空会话丢弃
- [x] REPL-4：Guardrail 注册——`createPermissionGuardrail` 注入 runtime PluginHost
- [x] REPL-5：默认插件扩展——file-ops / mcp-client / memory / security 进默认加载列表
- [x] REPL-6：首启向导接入 REPL——Shell 无 Key 时走向导再进 REPL
- [x] REPL-7：错误分类展示——网络错误 vs API 错误 vs 限额超限

### 第二梯队：机制打磨

- [ ] MECH-1：hook-logging 插件接入（事件日志）
- [ ] MECH-2：memory-project 插件接入（项目记忆）
- [ ] MECH-3：Anthropic provider SSE 流式测试（当前仅有 OpenAI SSE mock）

### 第三梯队：emma 接口文档

- [ ] DOC-1：`docs/api/tui.md`——接口文档 + 替换指南 + 注意事项
- [ ] DOC-2：`docs/guides/` 更新

## 六、依赖顺序

```
REPL-1 (startRepl 实现)
  ├── REPL-2 (StreamRenderer 接线)
  ├── REPL-3 (Session 管理)
  └── REPL-4 (Guardrail 注册)
REPL-5 (默认插件)
REPL-6 (首启向导)
REPL-7 (错误展示)
  ↓
MECH-1~3 (机制打磨)
  ↓
DOC-1~2 (接口文档)
```

## 七、备注

- egg-rolls 原始 5 任务（流式/插件/provider/guardrail/测试）+ Core 冻结 + 壳重构 + 审查修复 **全部已完成**。
- emma 不再负责功能逻辑——只做 UI/UX 替换层。
- 接口文档 `docs/api/tui.md` 交付给 emma 后，她可独立开发，不阻塞 egg-rolls。
