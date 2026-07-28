# 任务分工

> 当前分工与任务清单。状态/进度信息允许在本文件(`processes/*`);永久文档(`docs/specs|guides|api`)不允许。
> 协作流程见 [collaboration.md](collaboration.md);命名见 [conventions.md](conventions.md)。
> 进度依据代码实际状态,非 ROADMAP 标注。任务完成请勾选并按 conventions 提交。

## 一、当前进度

| Phase | 状态 | 证据 |
|-------|------|------|
| 0 脚手架 | ✅ 完成 | monorepo;CI 四件套全绿(lint/typecheck/test/build);单二进制可出 |
| 1 MVP-core | ✅ 完成 | runtime loop / provider(流式 SSE + 注册制) / context+auto-compact / session(memory+file+sqlite) / EventStream 枚举(含 LlmStreamChunk) / limits(含 AbortSignal) / guardrail+hook 接口 / PluginHost / **Core 冻结(ADR-017)**;73 测试过 |
| 1 MVP-tui | 🚧 startRepl 待 emma | `src/cli.ts` 壳已重构→调 `startRepl(ctx)`;`ReplContext` 契约已在 `packages/tui/src/repl-context.ts`;`createPermissionGuardrail` 接口已修正 |
| 2 增强 | 🚧 插件真实但**没接进 runtime** | mcp-client(真 JSON-RPC)、memory/project+auto(真持久化)、skills-loader 都实现了,但 `src/cli.ts` 只硬编码加载 metaTools + skills-loader |

## 二、关键发现(决定分工)

1. **`@vessel/tui` 大半是孤岛** -- `src/cli.ts` 自带一套内联 REPL + slash 命令,没用 tui 包的 `CLI_REPL`/`CommandRegistry`/`StreamRenderer`/`ToolPermissionChecker`。
2. **绝大多数插件没加载** -- `src/cli.ts` 硬编码 `const plugins: Plugin[] = [metaToolsPlugin, skillsLoaderPlugin]`。file-ops / mcp-client / memory×2 / provider×6 / security×3 / observability 全在仓库里但没进 runtime。
3. **CLI 不流式** -- `runtime.run()` 一次性返回后整段打印;`StreamRenderer` 闲置;`OpenAICompatibleProvider` 硬编码 `stream: false`。
4. **两套 slash 命令并存** -- `src/cli.ts` 内联的 Hermes 风格(`/resume` 带 pending one-shot)与 `commands.ts` 的层次式(`/session list`),互不相同,也都不是 CC 风格。

## 三、分工原则与接缝

- **原则**:egg-rolls 负责核心模块与功能;emma 负责边缘体验与优化。对应 CLAUDE.md 三层分层与 ADR-002。
- **接缝(两人必须先约定)**:把 `src/cli.ts` 拆成"壳"+"REPL"。壳归 egg-rolls(构造 runtime → 加载插件 → 分发);REPL/渲染归 emma。
- **契约(已草案)**:`ReplContext` 类型见 `packages/tui/src/repl-context.ts`；`startRepl(ctx)` 签名见 `packages/tui/src/repl/repl.ts` 底部。
  壳调用：`import { startRepl } from '@vessel/tui'; await startRepl(ctx);`
  ctx 含：`runtime, tools, session, events, currentSessionId, onSessionChange, provider{name,model,baseUrl}, plugins[], config, newSessionId, onExit`
  壳持有 `currentSessionId`（可变），通过 `onSessionChange` 回调感知 REPL 切换会话。
- **事件 payload**:egg-rolls 在 core 发,emma 渲染。LlmStreamChunk 事件已就绪(ADR-016)。

## 四、egg-rolls — 核心模块与功能

### owns

- `packages/core/src/**`(runtime / provider / context / session / events / tools / limits / plugin-host / types)
- `packages/config/src/**`(loader / validator / types / defaults)
- `plugins/**`(所有插件的 install/handler/hook/guardrail 逻辑)
- `src/cli.ts` 的**壳**:config 加载 → 构造 runtime → 加载插件 → headless 入口 → 交 tui

### 任务

- [x] 0. **拆接缝(与 emma 协作,前置)** ✅ -- 壳重构完成: cli.ts 切掉全部 REPL 代码→调 `startRepl(ctx)`;保留 argv 解析/config/provider/runtime/headless;`ReplContext` 契约草案在 `packages/tui/src/repl-context.ts`;emma 实现 `startRepl`。
- [x] 1. **插件加载机制** ✅ -- `PLUGIN_IMPORT_MAP` + `loadPlugin()` 动态 import;`config.plugins: [{name, enabled}]` → 注入 runtime;默认加载 meta-tools + skills-loader;无配置时回退默认。
- [x] 2. **Provider 注册制** ✅ -- 加载全部 provider 插件到临时 PluginHost;从 registry 按 `config.provider.name` 取 factory → 实例化;validator 去掉 "Unknown provider" warning(插件可注册任意 provider)。
- [x] 3. **流式核心(解锁 emma 的流式渲染)** ✅ -- `providers.ts` 三个 Provider(Memory/OpenAI/Anthropic)实现 `on_chunk` 回调流式;`ChatRequest` 增 `stream`+`on_chunk` 字段(向后兼容);新增 `EventType.LlmStreamChunk` + `LlmStreamChunkPayload`;runtime 接线发布增量事件;ADR-016 记录。Files: `packages/core/src/provider/providers.ts`、`types/provider.ts`、`types/event.ts`、`runtime/agent-runtime.ts`。
- [x] 4. **工具权限 guardrail 注册** ✅ -- `createPermissionGuardrail` 接口修正为 `Guardrail`（`stage: GuardrailStage.ToolCall` + `check(value, ctx)` + `GuardrailResult`）;添加 `autoApprove` 参数。弹窗 UI 由 emma 做。
- [x] 5. **core 测试加固** ✅ -- 维护 73 测试(原 67 + 6 新增——Memory/OpenAI 流式 + tool_call 累积 + 非流式回归 + agent-runtime LlmStreamChunk 断言)。后续任务 1/2/4 补对应回归。

## 五、emma — 边缘体验与优化

### owns

- `packages/tui/src/**`(repl / commands / renderer / tool-confirm 的 UI / wizard / rich-renderer / index)
- `src/cli.ts` 的 REPL/渲染部分(迁出到 tui)

### 任务

- [ ] 0. **拆接缝(与 egg-rolls 协作,前置)** -- 实现 `startRepl(ctx)` 入口,接管 `src/cli.ts` 内联 REPL。
- [ ] 1. **CC 风格 slash 命令** -- 合并两套(cli.ts Hermes 风 + `commands.ts` 层次式)成一套:`/` 弹菜单 + 模糊过滤 + 描述 + autocomplete + `/help` 富列表。**保留** Hermes `/resume` 的 pending one-shot(照搬 Hermes,egg-rolls 要求)。先选交互方案(Ink / `@inquirer/prompts` / 手搓 raw-mode)→ 写 ADR。
- [ ] 2. **REPL 重建** -- readline/Ink + 历史 + 行编辑 + 多行。现有 `CLI_REPL` 用 `stdin.once('data')` 且访问 runtime 私有字段 `_events`/`_tools` -- **当草图看,重建**,别直接接。
- [ ] 3. **流式渲染** -- 订阅 EventStream,token-by-token + 工具调用卡片 + spinner,替掉 "Thinking..." + 整段打印。**依赖 egg-rolls 任务 3**。
- [ ] 4. **富渲染打磨** -- banner / status bar / session 表(`buildSessionTable` 已导出未用)/ 颜色 / markdown 渲染响应。`rich-renderer.ts`。
- [ ] 5. **首启向导 UX 打磨** -- `setup-wizard.ts`(已能用,优化体验)。
- [ ] 6. **工具权限弹窗 UI** -- `tool-confirm.ts` 的 `confirm()` 显示(配合 egg-rolls 任务 4 的 guardrail 注册)。

## 六、依赖顺序

```
0. 拆接缝(cli.ts REPL → tui)          ← 前置,否则两人共改 cli.ts 冲突
1. egg-rolls 流式核心  →  解锁 emma 流式渲染
2. egg-rolls provider 注册制  →  emma 的 /model 类命令才有意义
3. 插件加载 + 权限 guardrail  →  可并行
```

## 七、备注

- 最大杠杆:**流式 + CC 式 slash + 插件接通** -- 这三件做完,Vessel 从"能跑"变"好用",也是两人分工的交汇点。
- 本文件是活文档,任务完成勾选;新增任务追加到对应负责人段。分工变更需两人确认。
