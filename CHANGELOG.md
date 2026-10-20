# Changelog

> 版本历史。遵循 [Keep a Changelog](https://keepachangelog.com/)。
> 0.x 阶段：breaking 变更走 minor，新功能走 minor，修复走 patch。

## [0.8.6] - 2026-10-20

> 0.8.6（基于 `release/0.8.6`，未发布）：确定性 mock 场景与 `vessel demo`。默认 mock 行为（`echo`）与 0.8.5 逐字一致；core 不引入场景概念。版本号由 1 在集成线统一写入。

### Added

- `src/mock/scenarios.ts`：`resolveMockScenario()` / `createScenarioProvider()`；场景名 `echo`（默认）/ `tools` / `permissions` / `error` / `multi-turn` 为冻结契约。`echo` 的文本、usage 与流式分片与 core `MemoryLLMProvider` 逐字一致。
- `tools` / `permissions`：首轮返回一次 `bash echo vessel-demo-ok` 的 tool_call，收到 tool 结果后以固定文本收尾；`error` 抛固定错误；`multi-turn` 返回 `Turn N: <输入>`。
- `VESSEL_MOCK_SCENARIO`：只在 `src/cli.ts` 读取一次，经 bootstrap / tenant runtime factory 透传到 provider factory；未设置时仍用 `MemoryLLMProvider`；未知值回退 `echo` 并打印一行 stderr 警告。
- `vessel demo`：CLI 模式（复用现有 bootstrap / REPL，不进一次性命令注册表），固定 mock + `tools` 场景，数据目录隔离到 `<dataDir>/demo`，不读用户已有 session；`--help` 可见。非 TTY 时打印提示并 exit 1。
- 测试 `src/__tests__/mock-scenarios.test.ts`：5 个 CLI spawn 用例，含未知场景回退与 `error` 场景的反向验证。

### Changed

- README 快速开始步骤① 改为 `vessel demo`；`VESSEL_MOCK=1` 保留为调试 / CI 用法。
- `vessel demo` 忽略 `VESSEL_MOCK_SCENARIO`，固定 `tools`；`VESSEL_MOCK` 的语义不变。

### Known limitations

- `vessel demo` 需要交互式 TTY；非 TTY 直接失败（CI 用 `VESSEL_MOCK=1 ... --run`）。
- evals 与 workflow 未接入场景 provider，仍使用各自固定的 mock 行为。
- `vessel demo` 的引导文案与 CLI 输出未本地化（0.8.5 的本地化范围限制继续有效）。

## [0.8.5] - 2026-10-20

> 0.8.5（基于 `release/0.8.5`，未发布）：TUI 本地化（zh-CN / en）。用户可见文案收敛到 catalog 并经 `t()` 查表；新增 `ui.language` 配置与 `VESSEL_LANG` 环境变量。默认 zh-CN 文案与 0.8.4 逐字一致。版本号由 1 在集成线统一写入。

### Added

- `packages/tui/src/i18n/`：`index.ts`（`resolveLocale` / `setLocale` / `getLocale` / `t`）、`messages/zh-CN.ts`、`messages/en.ts`；两份 catalog 各 271 个 key，集合一致。
- `packages/config`：`VesselConfig.ui.language`（`UiConfig`），validator 的已知键包含 `ui` / `ui.language`；配置含该字段时不再被当作未知键拒绝。
- locale 优先级：`VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN`；`zh` / `zh-*` / `zh_*`（可带 `.UTF-8`）归一为 `zh-CN`，`en` / `en-*` 归一为 `en`，非法值跳过该层。
- 新增 ADR-062。

### Changed

- TUI 启动头 / 摘要、状态栏、确认与提问弹窗、队列预览、命令描述与错误文案改走 `t(key, params?)`；会话选择器、setup wizard、流式与工具显示同步。
- `t()` 缺失 key 回退 zh-CN，再回退 key 本身；缺失参数保留 `{name}` 原文，不抛错、不打印。
- locale 在 REPL 启动时解析一次并进程内固定；wizard 没有 `ReplContext`，只按环境变量解析。

### Build

- 根 `package.json` 的 `files` 排除 `__tests__` 与 `*.test.ts` / `*.test.tsx`：`npm pack --dry-run` 由 packed **1,035,163 B** 降到 **642,679 B**、unpacked **4,349,088 B** 降到 **2,549,095 B**、文件数 **660** 降到 **374**；包内测试文件为 0。
- 根 `dependencies` 显式声明 `@vessel/{config,core,permission,serve,tui}` 为 `^0.8.5`。**发布前提：先发布这些子包**，否则 tarball 安装时依赖无法解析。

### Known limitations

- CLI 一次性命令（`--run` / `--tools` 等）与 Web 前端未本地化。
- 运行时切换语言需重启 REPL / wizard 进程。
- wizard 只读环境变量，不读 `config.ui.language`。
- 命令的数据输出（会话 / trace / metrics / 成本等）仍为英文；`t()` 只覆盖 UI chrome 与交互文案。
- 新增 key 必须在 `zh-CN` 与 `en` 两份 catalog 同步；en 缺失时静默回退 zh-CN，不会报错。

## [0.8.4] - 2026-10-20

> 0.8.4（基于 `release/0.8.4`，未发布）：TUI 可见问题修复——重复 key、ANSI 控制序列、Markdown 归档与 resize。全部改动在展示层，core / 工具的原始返回值不变。版本号由 1 在集成线统一写入。

### Added

- `packages/tui/src/utils/sanitize-terminal-text.ts`：纯函数 `sanitizeTerminalText()`（CSI / OSC / ESC / C0 / DEL / C1 清洗，`\r\n` 与 `\r` 归一为 `\n`）。
- `packages/tui/src/utils/text-layout.ts`：纯函数 `lineKey(index)`。
- `packages/tui/src/repl/use-repl-state.ts`：`HistoryItem`（`{ text, markdown? }`）。
- 新增 ADR-061。

### Fixed

- **React duplicate key**：`TextViewer` / `QuickHelp` / `QueuePreview` / `ToolTrail` 的列表 key 从“累计字符偏移”改为按行下标（`lineKey(index)`）；连续空行或重复文本不再产生相同 key。
- **ANSI 控制序列破坏布局**：新增纯函数 `sanitizeTerminalText()`，去除 CSI / OSC / 其它 ESC / C0 / DEL / C1，保留 `\n` / `\t`，并把 `\r\n` 与 `\r` 归一为 `\n`；`TextViewer`、`ToolTrail`、`StreamOutput` 与命令输出归档在渲染前清洗。
- **Markdown 归档回退成源码**：流式完成后历史项带 `markdown: true`，`<Static>` 继续用 `<MarkdownText>` 渲染；命令输出与用户输入仍按纯文本渲染。
- **resize 不生效**：`ink-repl.tsx` 改用 Ink `useWindowSize()` 订阅 `columns` / `rows`（`useStdout()` 不订阅 resize）；弹窗 / 面板宽度与 live 行数随窗口即时变化，矮终端（`<15` 行）隐藏 live 并只提示一次。

### Changed

- TUI 历史从 `string[]` 改为 `HistoryItem[]`（`{ text, markdown? }`）；`appendHistory` / `appendHistoryLines` 支持 `markdown` 标志。
- `VIEW_MAX_WIDTH` 从 110 提到 160；live 行数上限随终端高度增长（`MINIMAL_ROW_CAP = 5`）。
- 根布局不设固定 `height`：固定高度会让 Ink 每帧 `clearTerminal`，在 Windows / PowerShell 下造成历史、流式输出与底栏互相覆盖。
- 新增纯函数测试（`sanitize-terminal-text` / `text-layout` / `repl-state` / `layout`），全部在 `packages/tui` 内独立运行，不依赖 `mock.module` 的进程级状态。

### Known limitations

- ANSI 清洗只在展示层：gateway / headless / web / 插件仍拿到工具的原始文本（含控制序列）。
- TUI 不再显示原始 ANSI 颜色；`sanitizeTerminalText()` 只做清洗，不做宽度重排。
- Markdown 历史项比纯文本更占内存与渲染成本；`<Static>` 一旦写入不会重绘，窗口变宽后已归档内容按原宽度换行。
- Windows 真终端的 resize 行为仍需人工验证；`<15` 行的终端不显示流式 live 区。
- i18n 只在设计文档中，未实现。

## [0.8.3] - 2026-10-20

> 0.8 Wave 2B2A（基于 `release/0.8.3`，未发布）：Gateway 方法表按域拆分、CLI 一次性命令改为有序注册表。纯结构重构，无协议、无行为变化。版本号由 1 在集成线统一写入。

### Added

- **Gateway 方法模块**：新增 `packages/serve/src/gateway/errors.ts`（`MethodError`）与 `packages/serve/src/gateway/methods/`：`common.ts`（`tenantParamSchema` / `stringParam` / `checkpointBelongsToTenant`）、`config.ts`（`createConfigMethods` / `createToolMethods` / `createPluginsMethods`）、`evals.ts`、`feishu.ts`、`interactions.ts`、`mcp.ts`、`observability.ts`（`createEventsMethods` / `createMetricsMethods` / `createTraceMethods`）、`runs.ts`、`sessions.ts`、`tenants.ts`、`workflow.ts`（`createWorkflowMethods` / `parseWorkflowInputs`）。
- **CLI 命令注册表**：新增 `src/commands/registry.ts`，导出 `CliCommand`（`name` / `match(args)` / `run(args, ctx)`）、有序数组 `cliCommands` 与 `matchCommand(args)`；覆盖 `tools` / `update` / `resume-run-list` / `workflow` / `eval` / `config` / `tenant` / `migrate` / `trace` / `plugin` / `doctor` 11 条命令。
- 新增 ADR-059 / ADR-060。

### Changed

- `packages/serve/src/gateway.ts` 从约 4000 行降到 3002 行，只保留选项校验、缓冲 / 连接状态、HTTP / WS 路由与鉴权顺序；方法表用 `...createXxxMethods(deps)` 组装后交给 `defineMethods`。
- `events.subscribe` 仍留在 `gateway.ts`（依赖连接类型与事件缓冲游标），其余方法全部移入 domain 模块。
- `src/cli.ts` 删除约 153 行顶层 `if` 链，只解析全局参数 → `matchCommand` → 执行 → 统一 `exitCode`；REPL / serve / headless 路径不变。
- `MethodError` 独立成文件，保证拆分后 handler 与 legacy 错误处理仍命中同一个 `instanceof`。

### Fixed

- 无用户可见修复。本节只记录本次消除的结构性问题：方法定义与路由 / 连接状态混在单文件、新增 RPC 方法需在巨型数组中插入；一次性命令的命中顺序与退出码处理散落在 `if` 链各分支、单个命令无法独立测试。

### Known limitations

- 拆分只改变文件组织：方法名、`params_schema`、返回形状、协议错误码与鉴权顺序完全不变。
- 方法表不再能在一个屏幕内读完；domain 间共享逻辑必须显式放进 `common.ts`，否则会重复。
- CLI 注册表的顺序即语义：宽泛的 `match` 放在前面会遮蔽后面的命令；`--help` / `--version` 仍在入口处先行处理，不进入注册表。
- 注册表只覆盖一次性命令；REPL / serve / headless 的入口选择未抽象。

## [0.8.2] - 2026-10-19

> 0.8 Wave 2B1（基于 `release/0.8.2`，未发布）：统一工具执行管道，关闭 workflow / delegate 的权限与检查旁路。版本号由 1 在集成线统一写入。

### Added

- **core `ToolPipeline`**：新增 `packages/core/src/runtime/tool-pipeline.ts`，导出 `createToolPipeline` / `createToolPipelineFor` / `ToolPipeline` / `ToolPipelineOptions` / `ToolPipelineStages` / `ToolPipelineResult`（根入口与 `@vessel/core/runtime`）。阶段顺序：getTool → ToolCall guardrail → BeforeTool hook → permission（最终工具与参数）→ handler（timeout + signal）→ ToolResult guardrail → AfterTool hook（仅成功）。
- **workflow 注入点**：`WorkflowEngineOptions.toolPipeline?`；`type: tool` 走管道并发布 `tool.call.started|completed|failed`（payload 含 `workflow_run_id` / `tool_call_id` / `tool_name`）。
- **delegate 权限继承**：`DelegateTaskOptions.permission?`；子 runtime 使用父级 resolved 权限（`default` + `autoApprove`）。
- **装配纯函数**：`resolveRuntimePermission(config, headless)` 与 `buildDelegateTaskOptions()`；runtime / delegate / workflow 共用同一份 permission。

### Changed

- `AgentRuntime.runToolCall` 改用 `ToolPipeline`；关闭外层已处理的 ToolCall guardrail / BeforeTool / AfterTool，只复用 permission、handler 超时与 ToolResult guardrail；删除私有 `invokeTool`。
- 权限判定统一在 guardrail / hook 改写之后执行，针对最终工具与参数；改写导致参数 JSON 非法时直接失败。
- workflow `type: tool` 从“直接调 handler”改为走统一管道；未注入 `toolPipeline` 的旧嵌入路径保留但标记 deprecated。
- delegate 子 agent 不再固定 `{ default: 'allow' }`；显式 `permissionMode: 'allow'` 仍覆盖，`deny` 仍过滤工具。
- 交互默认 `ask` / headless 默认 `allow` 的口径由同一 resolved 权限提供给 runtime / delegate / workflow。

### Fixed

- workflow `type: tool` 绕过 runtime 的 guardrail / hook / 超时，以及与 runtime 权限语义不一致。
- delegate 子 agent 静默放行未声明 `checkPermission` 的工具（现继承父级 `ask` / `autoApprove`）。
- 三条执行路径的权限判定时机不一致；统一管道后一律针对 guardrail / hook 改写后的最终工具与参数判定。
- `ToolDefinition.timeout` 在 workflow 直接 handler 路径不生效；统一管道后生效。

### Security

- 关闭 workflow / delegate 的工具执行旁路：两处与 runtime 使用同一 guardrail / hook / permission / timeout 顺序。
- delegate 默认权限不再无条件 allow；交互模式继承父级 `ask`。
- workflow 的权限 `ask` 走 `tool.permission.request`，120s 无应答按失败处理，不静默放行。
- 管道阶段可由嵌入方显式关闭（`ToolPipelineStages`），关闭即由调用方承担检查责任；asm 默认全开。

### Known limitations

- 直接构造 workflow 引擎且不注入 `toolPipeline` 的第三方嵌入方仍走旧直接 handler 路径。
- 管道统一执行语义，不改变 `ToolDefinition` / `PermissionPolicy` / guardrail / hook 的接口。
- 测试禁止使用 `mock.module`（Bun 进程级污染），接线测试改用依赖注入与纯函数。

## [0.8.1] - 2026-10-19

> 0.8 Wave 2A 加固（基于 `release/0.8.1`，未发布）：持久化耐久性与损坏检测、配置单一 resolver、Gateway 拆分第一阶段。版本号由 1 在集成线统一写入。

### Fixed

- `FileSessionBackend.load()` 不再把“文件存在但不可读 / JSON 损坏”静默当成“无会话”，避免下一次 save 覆盖唯一副本；非 ENOENT 读取错误与解析失败抛 `SessionCorruptError`（`session_corrupt`）。
- 主路径存在（包括属于其它 tenant）时不再回退 legacy 路径；只有主路径 `ENOENT` 才尝试 legacy。
- `FileSessionBackend.delete()` / tenant 模式 `FileRunStore.delete()` 不再删除损坏文件：先 `load()` 校验，损坏时抛错、缺失或 foreign 时 no-op。
- `deleteSessionData` 的冲突检查从“只看第一页 200 条”改为 `limit: 200` + `offset` 全量分页；超过一页的 `running` / `interrupted` run 不再漏判后被删除。
- `atomicWrite` 在 rename 前对 temp 文件 fsync、rename 后尽力 fsync 目录，降低掉电后目标文件内容未落盘的风险。
- `VESSEL_CONNECT_TOKEN` / `VESSEL_CONNECT_CA` 进入 config env 层；connect token / CA 不再由 `bootstrapConnect` 各自读 argv / `process.env`，消除与 `VESSEL_GATEWAY_TOKEN`、`serve.token` 的优先级漂移。

### Changed

- `atomicWrite` 新增 `AtomicWriteOptions.durable`（默认 `true`）；`durable: false` 恢复 0.5 的旧行为。文件 fsync 失败抛 `AtomicWriteError` 且不 rename，目录 fsync 失败忽略。
- 新增并导出 `SessionCorruptError`；`FileSessionBackend.listRich()` 对损坏文件逐项降级跳过，直接 `load()` 仍抛错。
- `RunStore.list` 新增可选 `offset`（过滤、排序后切片）；`MemoryRunStore` / `FileRunStore` 同步实现，既有调用方不受影响。
- `ConfigLoadOptions` 新增 `cliOverrides`，`defaults` 标记 deprecated（先应用，`cliOverrides` 后应用）；层序仍为 `CLI > env > tenant overlay > project > user > default`。
- 新增 `src/cli-overrides.ts` 的 `buildCliConfigOverrides()`；`resolveServeOptions(config)` 不再接收 argv，`serve` / `connect` 统一从合并后的 config 读取。
- connect token 解析：`VESSEL_CONNECT_TOKEN` 优先，缺失时回退 `VESSEL_GATEWAY_TOKEN`；CA 来自 `VESSEL_CONNECT_CA` 或 `connect.ca_file`。
- Gateway 拆分第一阶段：新增 `packages/serve/src/gateway/{auth,frames,sse,static}.ts`；`gateway.ts` 从 4172 行降到 3886 行。公开导出、协议帧与 wire 行为不变。
- 新增 ADR-056 / ADR-057，并同步 ARCHITECTURE / AGENTS / SECURITY。

### Security

- 损坏的 session / tenant run 不再被静默覆盖或删除；损坏可能仍含敏感会话内容，排查时不应粘贴到日志或 issue。
- 持久化默认 fsync，降低掉电导致 checkpoint / 会话内容丢失的风险；这不等同于备份或磁盘损坏防护。
- connect token / CA 只经配置层合并，`config show --sources` 只显示来源与 set/unset，不输出明文。

### Known limitations

- 每次 session / checkpoint 写入多一次 fsync；Windows 上目录 fsync 通常被跳过。
- 损坏文件只报错或跳过，不自动修复、不备份、不重试 fsync。
- 非 tenant 的 `FileRunStore` 仍把损坏当 `null`（0.3 兼容语义）。
- `deleteSessionData` 的冲突检查成本随 run 数增长（上限 10,000 页）。
- Gateway 只完成第一阶段拆分；路由与连接状态机仍在 `gateway.ts`。
- 新增 CLI flag 必须同时加入 `buildCliConfigOverrides()`，否则不会进入配置层。

## [0.8.0] - 2026-10-19

> 0.8 Wave 1 结构收口（基于 `release/0.8`，未发布）：只做真实行为缺陷、core 失败隔离与工具安全边界，不做 Gateway 拆分等大重构。版本号由 1 在集成线统一写入。

### Added

- **RunExecution（core）**：新增 `RunExecution` 类型，run 级状态（run id / session / branch / 计时 / usage / context）从 `AgentRuntime` 实例字段收敛到每次执行；`run()` 与 `resume()` 共用。
- **单 run 守卫**：新增 `RunAlreadyRunningError`（`code: 'run_already_running'`，继承 `RunResumeError`，从根入口与 `@vessel/core/session` 导出）；同一 runtime 已有 active run 时，新的 `run()` / `resume()` 立即失败。
- **统一终态**：`finalizeRun()` 成为 `run()` / `resume()` 唯一终态路径；新增 `run.finalize.failed` 事件（终态持久化失败时保留原始错误）。
- **失败隔离**：新增 `hook.error` 与 `guardrail.error` 事件；单个 hook 抛错发事件后继续执行，guardrail 抛错按 fail-closed 返回 `guardrail_error`。
- **本地 RPC subscribe**：装配层把 `LocalRpcClient.subscribe()` 桥接到 `runtimeEvents`（只读 `events.event` 转发）。
- **basic-tools 路径边界**：内置敏感路径 denylist；插件配置 `allowed_roots`（越界 `ask`）与 `deny_paths`（追加）；`read` / `bash cwd` 按 realpath 判定。
- **Web seq 回退重放**：`hello.latest_seq < currentSeq` 时以 `since=0` 重连并从头重放；新增 `GatewayClient.restart` 与纯函数 `planHelloSeq`。
- **durable REST 显式 tenant**：admin 可用 query `tenant_id` 或 `X-Vessel-Tenant` 指定 tenant；两者不一致返回 400。
- **文档**：新增 [ADR-054](docs/adr/ADR-054-run-execution-and-failure-isolation.md) / [ADR-055](docs/adr/ADR-055-tool-path-boundaries.md)，同步 ARCHITECTURE / AGENTS / SECURITY。

### Changed

- `resume()` 的用户取消改为 checkpoint `cancelled` + `run.cancelled`，与 `run()` 一致；不再发 `run.failed`。
- `OnError` hook 变为 best-effort：hook 自身抛错不替换原始错误，也不跳过 session / checkpoint 写入。
- `VESSEL_MODEL` / `VESSEL_BASE_URL` / `VESSEL_PROVIDER_API_KEY` 只合并对应字段；只有显式 `VESSEL_PROVIDER` 才覆盖 `provider.name`（修复项目 `provider.name: anthropic` 被改成 `openai`）。
- headless 不再提前 `process.exit`：先统一执行 gateway / tenant / transport / shutdown 清理，再设置退出码。
- `--resume-run` 读取 `<data_dir>/tenants/<id>/runs`，与执行面一致。
- `createRunStore` 透传 `tenantId`；`FileRunStore.delete()` 在 tenant 模式下先校验归属，foreign / 缺失 no-op。
- durable REST 的 tenant 解析与 RPC `runs.resume` 的 `ctx.tenantId` 对齐（admin 显式指定，其余按 principal）。

### Fixed

- 本地 REPL 的 `/runs resume`、`/workflows run|resume` 因缺少事件订阅而挂起。
- `--serve --run` 退出时跳过清理，残留 tenant `.lock`。
- 同一 runtime 并发 `run()` 互相污染 usage / session / branch。
- Web 在 gateway 重启（seq 回退）后丢失重放事件。
- durable REST 忽略 admin 的显式 tenant。
- `coreToJob` 随 run 数量无界增长（终态与 `trimRuns` 时清理）。
- `--resume-run` 在默认 tenant 布局下列不出 run。

### Security

- `read` / `bash cwd` 内置 denylist 硬拒绝 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`，用于降低提示注入诱导的凭据读取；命中 `deny` 而非 `ask`。
- `allowed_roots` / `deny_paths` 为 opt-in；路径比较基于 realpath（含最近已存在祖先），`..` 与符号链接不能绕过。
- **明确边界**：这不是沙箱。`bash` 只校验 `cwd`，命令本身仍可访问其它路径；`edit` 未纳入路径边界。真正的隔离仍需沙箱类插件与受限运行环境。

### Known limitations

- 单 run 守卫是进程内、每 runtime 的；跨进程并发仍依赖 tenant 写锁与 durable 唯一写者约定。
- `finalizeRun` 持久化失败只发 `run.finalize.failed`，不重试、不补偿。
- 内置 denylist 不能通过配置移除，只能追加。
- Web seq 回退会清空本地事件存储并全量重放，成本随事件数增长。
- 0.8 Wave 1 不包含 Gateway 拆分、统一工具执行管道、插件生命周期 v2、协议 schema、fsync/损坏恢复、CLI 命令注册表与配置单一 resolver（留在 Wave 2）。

## [0.7.1] - 2026-10-19

> 0.7 的 P0 加固补丁线（基于 `release/0.7`）。与 0.5 / 0.6 / 0.7 一样只做发布干跑，不 tag、不 publish、不合并 `main`。

### Security

- **P0-1 legacy WS 租户作用域**：`run.submit` / `run.get` / `run.cancel` / `permission.respond` / `ask.respond` 等 legacy WS 方法不再绕过 principal/tenant，统一经 dispatcher 按调用方 tenant 执行；跨 tenant 读取 / 取消 / 应答返回 `forbidden/not_found`，`team.*` legacy 帧保持 `method_not_allowed`。
- **P0-2 tenant 锁回收**：锁内容改为原子发布，不可解析锁增加 mtime 宽限，stale 回收改为带互斥守卫的 compare-and-delete；同主机存活 pid 不再被 24h 年龄判为 stale，跨主机仍按年龄兜底。消除空文件窗口与双重回收导致的单写者失效。
- **P0-3 外部插件信任边界（缓解 / MITIGATED）**：默认仍加载 repo / project / user / node_modules 插件，但启动时向 stderr 打印外部插件告警；新增 `VESSEL_NO_EXTERNAL_PLUGINS=1` 显式 opt-out；显式 `plugins:` 始终可加载指定外部插件。**该风险只是缓解，未完全关闭**——外部插件仍以完整进程权限在启动时执行。

### Changed

- 插件来源优先级修正为 `repo → project → user → node_modules`，同名插件先出现者胜出（项目覆盖用户）。

### Upgrade notes

- 在不可信仓库中运行请设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`。默认行为不变（外部插件仍会加载），但启动会看到告警。
- 若依赖外部插件，可继续使用默认集；只想信任指定插件时，使用显式 `plugins:` 列表。

### Known limitations

- P0-3 记录为 **MITIGATED**（残余风险经用户接受）：没有插件 manifest / 签名 / 沙箱，也没有 `install()` 超时与故障隔离。
- 0.7.1 不包含 Gateway 拆分、统一工具执行管道、RunExecution、协议 schema 与 fsync（留在 0.8）。

## [0.5.0] - 2026-10-18

> 0.5 代码就绪，发布决定在 1；0.5 仍只做发布干跑，不 tag、不 publish、不合并 `main`。

### Added

- **F1 文件优先存储**：默认 `session.backend: file`；tenant 目录布局（`sessions/` / `runs/` / `events/` / `tenant.json` / `.lock`）；原子写；单写者锁；`vessel migrate`（sqlite / file-v1 → file-v2，默认 dry-run、源只读、幂等）。
- **F2 trace**：`TraceRecorder` / `FileTraceRecorder`、`RunEvent.seq` / `tenant_id`、`readTraceEvents`、`pruneTrace`、`rebuildMetrics`、`TraceRedactor`；默认 `full`，30 天 / 1000 runs / 1 GiB。
- **F3 统一入口**：RPC 信封 v1、方法表 v1.1、capability manifest、`RpcClient`（local / http）、`--connect`；旧 REST 端点保留为兼容别名。
- **F4 多租户**：`TenantContext`、tenant 解析、token → principal、存储 / 配置 / 工具 / 权限 / quota / trace / RPC 隔离；`serve.tokens` / `serve.admin_token`；`vessel tenant list|get|create|update`。
- **F6 配置与密钥**：YAML 主配置、`config path|init|show [--sources]`、`_env` 间接引用、来源标注、密钥脱敏输出。
- **A-6 内置多租户执行**：`pluginsFor`、per-tenant `capabilities.list` / `plugins.list`、`trace.readEvents(filter, tenantId)`、`sessionData.deleteSessionData(sessionId, tenantId)`；`--serve` 为每个 active tenant 构建独立执行面（config / provider / session / run store / context / PluginHost / trace / metrics / redactor / sessionControl）与独立 EventStream、per-tenant writer lock；启动失败回滚、shutdown 释放。
- **ADR 多文件**：`docs/adr/ADR-001..050`，`docs/adr/README.md` 索引与编写约定，`docs/ADR.md` 保留为兼容 stub。
- **门禁**：`check-docs` ADR 树校验；`check-rpc-methods`；`check-config-sources`；`check-trace`。

### Changed

- `session.backend` 默认 sqlite → file；`durable.path` 默认统一到 `<data_dir>/tenants/<tenant_id>/runs`。
- 显式用户取消只发 `run.cancelled`（不再同时发 `run.failed`），`metrics.runs.cancelled` 首次可能非 0；0.4 的 cancel→failed 是历史行为。
- trace 的 `seq` 由 recorder 落盘分配并持久化；内存事件可无 seq，消费方按 `(seq ?? ts)`。
- `.env` 从推荐主配置降为部署覆盖；CLI/TUI 走 RPC 客户端。
- ADR 从单文件迁移到 `docs/adr/`；`docs/ADR.md` 只作兼容入口。

### Upgrade notes

- 旧 sqlite / file-v1 数据不会自动迁移：检测到后只提示执行 `vessel migrate`。先 dry-run，再 `--apply`。
- 显式 `session.storage_path` / `durable.path` 可以逃出 tenant，但启动时会 warn。
- 旧 `.vessel/sessions.db`、`~/.vessel/runs` 不自动删除；验证新数据后再手工处理。
- 配置优先级固定为 `CLI > env > tenant overlay > project > user > default`；项目 `vessel.yaml` 禁止密钥。

### Known limitations

- 不承诺多进程并发写同一 tenant；单写者锁是唯一保障。
- `sessions.list` / `runs.list` 为 O(N)；0.5 上限单 tenant 5,000 sessions / 20,000 runs。
- redactor 只降低泄漏面，不是合规保证；0.5 不脱敏 run checkpoint / eval 报告 / 飞书回复。
- trace 队列溢出会写 `trace.overflow`，该 trace 标记为不完整。
- `pruneTrace` 不删除 `running` / `interrupted` run；tenant 删除默认 disabled，0.5 无 `--purge`。
- `--connect` 只连本机回环 gateway；**F5 跨机器远程在 0.6**。
- 多租户执行已实现（ext 插件、web 接口、asm per-tenant 执行面）；**gateway 的 workflow / 飞书控制面仍只走 default tenant**（A-6 §13.3 方法表未包含 per-tenant 变体）。
- Windows 上 programmatic SIGINT 不触发 Bun 信号处理器，shutdown 释放 tenant 锁（A6-17/A6-21c）未自动验证；代码路径存在（`tenantFactory?.closeAll()`），需 POSIX CI 补验。
- **微信（公众号 / 企业微信）不做**；0.5 不发布。

## [0.4.0] - 2026-10-18

> 0.4 代码就绪，发布决定在 1；**0.4 只做发布干跑，不 tag、不 publish、不合并 `main`**。
> 0.1.0 / 0.2 / 0.3.0 / 0.4.0 均未发布。

### Added

- `@vessel/workflow`：声明式 workflow 插件——YAML/JSON DAG、`agent` / `tool` 步骤、模板插值、重试 / `on_error` / `when`、并行上限、run 持久化与 resume、`WorkflowControls` 控制面；工厂式插件，不进 core，不注册模型工具。
- `@vessel/evals`：默认离线的 eval harness——suite / case、脚本化 mock provider、断言白名单（`output_contains` / `output_matches` / `no_error` / `tool_called` / `tool_not_called` / `max_duration_ms` / `max_iterations` / `usage_under`）、JSON 报告、`report.ts` 写盘与 latest 查找。
- `@vessel/feishu`：飞书渠道插件——官方 SDK WebSocket 长连接、`FeishuTransport` 抽象、专用 `InProcessRuntimeHost`、per-chat session（`feishu:<chat_id>`）、文本消息、队列上限、凭据掩码；`--feishu` 附加开关。
- `@vessel/core`：`MetricsCollector` / `MetricsSnapshot`（进程内事件聚合）；`MemoryEventStreamOptions.maxHistory`（缺省 1000、显式 0 = 不限制、>0 环形缓冲）；`pruneRuns` helper（`status` / `older_than_ms` / `keep_latest`）。
- `@vessel/config`：`workflow` / `evals` / `feishu` / `observability` 四个配置块与严格校验；`feishu.agent_id` 已删除，按未知键拒绝。
- CLI：`vessel workflow run|list|show|resume|cancel`、`vessel eval <suite>`、`--feishu`（TTY → REPL + 渠道；非 TTY → 仅渠道前台；`--serve` → gateway + 渠道）。
- `@vessel/tui`：`/workflows`、`/metrics`、`/feishu`、启动横幅（interrupted workflow / 飞书已连接）。
- `@vessel/serve`：`GET /v1/metrics`、`/v1/workflows*`、`/v1/channels/feishu`、`GET /v1/evals/latest`；新错误码与 `hello.features`；慢客户端丢事件并标记 `gap`。
- `apps/web`：workflow / metrics / 飞书面板。
- 发布干跑：`scripts/release-dry-run.ts` + `Release Dry Run` CI job（PR + `release/**`；不 tag / 不 publish / 不上传）；Offline Integration 扩展 workflow / evals / feishu / core。

### Changed

- `@vessel/core` 的 `./observability` subpath 在 0.3 已存在；0.4 **改指**到新的 `src/observability/index.ts` barrel，并继续 re-export 原 events 符号（不是新增 subpath）。
- 四个新配置块全缺省时行为与 0.3 一致；`observability` 块缺省时不注入 metrics；事件历史缺省仍为 1000。
- 发布流程不变：1.0 前不发布；0.4 只干跑，tag / publish / 合并 `main` 仍由 1 决定。

### Fixed

- `@vessel/core`：长会话 context compact 后消息/事件不重复、不丢最后一条用户消息。
- `@vessel/core`：`InProcessRuntimeHost` 在 run 结束时释放 `AbortSignal` 监听器，避免泄漏；关闭路径清理成员、排队 run 与交互请求。
- `@vessel/core`：`Scheduler` 队列满 / 并发取消 / 同成员串行的并发不变量由测试固定。
- 发布干跑：`entry_file_missing`（`main` / `types` / `exports` 目标不在 tarball 中）由 warning 提升为 **error**。
- 0.3 基线已包含 PeerRegistry stop race 修复（`ec25cfc`），0.4 不回归。

### Known limitations

- workflow `type: tool` 直接调用 handler，**绕过 runtime 的 guardrail / hook**；需要 guardrail 的步骤用 `type: agent`。
- workflow resume 不保证 step 幂等；重跑可能重复副作用。
- workflow agent step 使用 Host 中已存在的成员，**共享其 session**；workflow 级会话隔离不在 0.4 承诺。
- workflow `cancel` 只支持同进程；跨进程 run 返回 `workflow_not_found`。
- `MetricsCollector` 的 `runs.cancelled` 保持 0，取消的 run 计入 `runs.failed`；resume 不计 `runs.started`，因此 `completed` 可能大于 `started`。
- `pruneRuns` 的 `kept` 受 `RunStore.list` 200 窗口限制，`keep_latest > 200` 不保证精确；prune 不自动调度。
- 事件历史上限只作用于 `MemoryEventStream`；`FileEventStore` 不自动轮转。
- 飞书只支持文本、单 chat 单 session；真实 WebSocket 连接未在离线 CI 验证（CI 使用 mock transport）；达到 `max_members` 时新 chat 回 `busy`，不逐出已有成员；不做富媒体 / 卡片 / thread / 多机器人 / OAuth。
- eval 使用 mock provider 时 usage 可能为 0；`usage_under` 的判定以实际报告为准；真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控。
- 发布干跑通过不代表 npm 凭据、2FA、provenance 的线上配置已完成；0.4 不生成 `latest.json`。

## [0.3.0] - 2026-10-17

> 0.1.0 与 0.2 均未单独发布；0.2 的变更并入本版本。0.3.0 代码就绪，发布决定在 1。

### Added

- 0.2：`@vessel/core` Kernel——`RuntimeHost` / `AgentHandle` / `RunHandle` / `Scheduler` / `EventBus` / `Cancellation` / `Limits`，以及 `createRuntime()`。
- 0.2：`@vessel/core` subpath exports——`context` / `observability` / `kernel` / `policy` / `provider` / `session` / `transport` / `types`；根入口保持兼容。
- 0.2：in-process `Transport`；gateway loopback transport 与 `team.*` 协议。
- 0.2：`team` / `delegate_task` 共用 Host；team 仍默认 off、显式 opt-in。
- `@vessel/core`：durable run——`RunStore` port、`RunCheckpoint`、`MemoryRunStore` / `FileRunStore`；checkpoint 在 run 开始、每轮 tool-call 后、run 结束写入；`AgentRuntime.resume(runId, opts?)`、`RunnableAgent.resume?`、`RuntimeHost.resume(runId)`（不经 Scheduler）；开放事件 `run.checkpoint` / `run.resumed`。
- `@vessel/core`：resume 稳定错误 `RunResumeError`（`run_not_found` / `run_not_resumable` / `run_already_running` / `run_store_required` / `agent_not_found`）；同一 run 并发恢复首个成功，后续 `run_already_running`。
- `@vessel/mcp-client`：MCP client 插件——stdio 与 HTTP（Streamable HTTP，POST JSON-RPC + JSON/SSE 响应）两种传输；工具经 `PluginHost` 注册；`mcp__<server>__<tool>` 前缀（超 64 字符截断并加 hash）；权限默认 `ask`，`auto_approve_tools` 按原始工具名精确放行；单 server 失败隔离；控制面 `listServers()` / `getServer()` / `reconnect()` / `close()`；事件 `mcp.server.*` / `mcp.tool.*`。
- `@vessel/config`：`mcp_servers`（stdio/http、超时、tool_prefix、auto_approve_tools 等）、`durable`（enabled / backend / path / checkpoint_every）、`serve`（hostname / port / allow_remote / tls）配置块与校验。
- `@vessel/serve`：`GET /v1/durable/runs`、`POST /v1/durable/runs/<runId>/resume`、`GET /v1/mcp/servers`；新错误码 `run_not_found` / `run_not_resumable` / `run_already_running` / `durable_disabled` / `mcp_disabled`；`hello.features` 按实际启用增加 `durable-resume` / `mcp-status` / `tls`。
- `@vessel/serve`：显式 opt-in 的远程监听与 TLS——`serve.allow_remote` / `--allow-remote`、`serve.tls.cert_file` + `key_file` / `--tls-cert` + `--tls-key`；非回环必须 token；默认仍绑 `127.0.0.1` 且明文。
- `@vessel/tui`：`/mcp`（状态 / `reconnect <name>`）、`/runs`（running + interrupted，`resume <runId>`）、启动横幅提示（有 MCP server 或未完成 run 时）。
- CLI：`--resume-run [runId]`（无参列出 interrupted，有参恢复；与 `--run` / `--serve` / `--tools` / 位置式输入互斥）、`--serve-host`、`--allow-remote`、`--tls-cert`、`--tls-key`。
- `apps/web`：按 `hello.features` 显示 MCP server 面板与 interrupted run 面板；可触发 durable resume。
- examples：`examples/embedded-mcp.ts`、`examples/mcp-echo-server.ts`。

### Changed

- 0.2：定位调整为「可嵌入的多 agent 平台 runtime + 参考 harness 外壳」（ADR-037）。
- 0.2：`AgentRuntime` 仍是单 agent loop；Host 包在它外面，不重写 loop。
- durable 默认关闭（`durable.enabled: false`）：关闭时不创建 `RunStore`，行为与 0.2 一致。
- serve 默认行为不变（回环 + 明文）；REST 仍为 HTTP/1.1。
- MCP 工具默认逐次询问；`auto_approve_tools` 只接受 server 返回的原始工具名（大小写敏感）。

### Removed

- `@vessel/team` 中 0.2 的 deprecated 进程内 Host 兼容路径（`InProcessRuntimeHost` / `LegacyHostAdapter`）；team 统一注入 core `RuntimeHost`。
- 配置键 `delegate.viaHost` 与 `team.maxMembers`；旧配置按未知键报错。

### Fixed

- 无 0.3 专属修复；0.2 的 loop / SSE / 启动竞态修复已包含在基线中。

### Known limitations

- durable 只支持本机 `file` / `memory` 后端；不做跨机器恢复、分布式锁或跨进程并发写协调。
- `FileRunStore` 的原子写是 best-effort（Windows 下 rename 失败重试后整文件直写）；无保留/清理策略，`list` 可能增长。
- resume 并发守卫是 per-Host / per-store-instance；多 Host 共享同一 `FileRunStore` 或跨进程同时恢复同一 run 属部署错误，不在 0.3 协调范围。
- MCP HTTP 不做 GET 长连接、session 恢复、OAuth；MCP 工具默认需要用户确认。
- 远程/TLS：只做 HTTP/1.1；证书由用户提供，不支持 ACME / mTLS / HTTP/2。
- workflow / evals / 多租户 / 跨机器调度 / 单二进制 / npm CLI 仍未实现。
- 0.1.0 / 0.2 / 0.3.0 均未发布。

## [0.1.0] - 2026-10-17

### Added

- `@vessel/core`：AgentRuntime 与通用 tool-calling loop（流式、中断、事件、限流、session 恢复）。
- `@vessel/core`：9 个接口（Provider / Context / EventStream / Tool / Session / Limits / Guardrail / Hook / Plugin），唯一扩展机制 `Plugin` + `PluginHost`。
- `@vessel/core`：`FileEventStore` + `replayRun` 事件回放；File / SQLite / Memory 三种 session 后端。
- `@vessel/config`：YAML 配置加载、校验（未知键报错）、snake_case → camelCase 映射。
- `@vessel/tui`：Ink REPL、流式渲染、slash 命令、权限确认、`@路径` 文件引用。
- `@vessel/serve`：常驻 gateway（`--serve`），实现 `vessel.gateway/1`：WS/SSE 事件流（`seq` 续订 / `gap`）、异步运行提交与取消、会话/工具/权限/ask_user 端点、可选同源静态托管。
- `apps/web`：浏览器控制台 v1（时间线、运行取消、权限弹窗、ask_user、断线重连）。
- `@vessel/permission`：共享权限原语（工具经事件流等用户授权）。
- 能力工具 3 个：`bash` / `read` / `edit`；接缝工具 2 个：`ask_user`（仅交互）/ `delegate_task`。
- 插件包：`provider-openai` / `provider-anthropic` / `guardrail-pii` / `redact-secrets` / `tool-policy` / `hook-logging`。
- headless 入口 `--run`：文本、`@file`（`.json` 多轮 seeding）、stdin 管道。
- `VESSEL_MOCK=1` 模拟模式：无 API Key 跑通整条链路。
- CLI：`--version`（根 `package.json`）、`--tools`（headless 口径，不需要 Key）、`update [--check] [--channel latest|beta] [--json] [--force]`（check-only）；非交互且无 Key 时快速失败，不进首启向导。
- 配置块：`provider.timeout_ms`、`session.backend`（sqlite / file / memory）、`update.*`、`delegate.*`（含 `permission_mode` / `read_only_tools`）、`team.*`；顶层未知键升为 error（带拼写建议）。
- 插件包 9 个：新增 `@vessel/team`（进程内原型，`team.enabled` 显式 opt-in，注册 5 个 `team_*` 工具）。
- provider timeout 装饰器（openai / anthropic 插件）；`delegate_task` 权限 bridge / allow / deny。
- thinking 模型：OpenAI 兼容 provider 支持 `reasoning_content`（非流式解析、流式累积、下一轮请求回传、会话持久化；事件流与 TUI 不暴露思维链，ADR-038）。
- CI：质量门禁、跨平台矩阵、web 构建、examples 类型检查、mock 冒烟。
- 发布：tag `v*` 驱动，npm 发布 `@vessel/*` 与插件包（provenance、latest/beta dist-tag），生成 `latest.json`。
- 版本工具：`scripts/version.ts`（统一版本 + 一致性校验）、`scripts/latest-json.ts`。

### Fixed

- core loop 正确性修复（ADR-035）：非法 tool arguments JSON 不终止 run；失败 run 保存真实上下文；请求消息归一化（补 system、丢弃孤儿 `role:tool`、降级不完整 `tool_calls`）；`updateRealTokens` 使用本次请求 token；guardrail `replacement` 四阶段生效；Anthropic 非流式 `max_tokens` 映射为 `length`；会话标题取首轮最后一条 user；`FileEventStore` 自动创建父目录。
- SSE 长连接：`Bun.serve` `idleTimeout` 默认禁用（0），保留 15s heartbeat；`hello.from_seq` 空缓冲为 `0`、已追平为 `since + 1`。

### Changed

- 极简化重构（ADR-034）：工具集收敛为 `bash` / `read` / `edit`；插件发现只保留运行时目录扫描；skills 改为普通文件经 `RunOptions.messages` 注入。
- 事件名统一为开放字符串（ADR-030）；hook / guardrail 按 priority 排序。
- `AgentRuntime` 改为异步静态工厂 `AgentRuntime.create()`（ADR-023）。
- 工具口径：默认 4（`bash` / `read` / `edit` + `delegate_task`）；`ask_user` 仅 REPL+TTY（交互 5）；`team.enabled` 后 9。
- `--serve` 接线完成：传入 `context` / `pluginHost` / `staticDir`，G2 会话切换与 Web 静态托管生效。

### Removed

- `file-ops` / `meta-tools` / `skills-loader` / `mcp-client` / memory 插件。
- `ToolRegistry` 与 `ToolDefinition` 的死字段（`default` / `interactive` / `render` / `isEnabled` / `shouldDefer`）。
- `vessel.yaml` 的 `tools:` 声明段。
- 旧的 `docs/specs/`、`docs/api/`、`docs/guides/`、`docs/dev/`、`docs/role/`、`processes/`、`legacy/` 文档树。

### Known limitations

- MCP 未实现；接外部系统先用 `bash`（`curl` / CLI）。
- workflow / durable execution / evals 未实现；agent team 只有进程内原型（`team.enabled` 显式开启），gateway 的 `team.*` 为 0.2 草案。
- Gateway 0.1.0 单节点单 runtime：并发固定 1（队列上限 100），运行与事件历史在内存。
- 0.1.0 **不发布二进制**（ADR-006 继续有效）。
- 根 CLI `vessel` 尚未发布到 npm，`npx vessel` 暂不可用。
- `vessel update` 只做版本检查与提示（check-only），不下载、不自替换。
- `provider.timeout_ms` 只对插件式 provider 生效；未知 provider 的降级路径没有超时装饰器。
- 顶层未知配置键现在是 error（不是 warning）：旧配置里的拼写错误会让启动失败。

---

## 版本命名规则

- `x.y.z` = 语义化版本（Semantic Versioning）。
- pre-1.0 阶段：`0.x.y`，Minor（中间位）= 不兼容变更。
- 发布时打 tag：`git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0`。
