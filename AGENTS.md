# AGENTS.md

> Vessel 仓库的 AI 行为约定。与代码冲突时以代码为准，并顺手改掉本文档。

## 项目是什么

Vessel 是一个**可嵌入的多 agent 平台 runtime**：极简核心（稳定接口 + 1 个通用 tool-calling loop + 扩展插槽）、Provider 无关；TUI / CLI / Web / Gateway 是参考 harness 外壳。

- **语言/运行时**：TypeScript + Bun。
- **monorepo**：bun workspaces。`packages/{core,config,tui,serve,permission}` + `plugins/` + `apps/web`。
- **形态**：`@vessel-agent/core` 是库（零 UI 依赖，可嵌入）；TUI / serve / web 是应用层外壳。
- **工具集**：能力工具只有 `bash` / `read` / `edit` 三个。默认运行期 4 个（+ `delegate_task`）；`ask_user` 仅 REPL+TTY（交互 REPL 为 5）；`team_*` 5 个仅在 `team.enabled: true` 时注册（共 9）；配置 `mcp_servers` 后额外注册 `mcp__<server>__<tool>`（数量动态，4 + N）。别急着加第四个能力工具。
- **状态**：alpha，pre-MVP。未实现的能力一律标注，不写进正文。
- **0.2 状态**：多 agent Kernel（Host / Scheduler / Transport）与模块 subpath exports **已实现**（`release/0.2`，未随版本发布）；`AgentRuntime` 仍是单 agent loop，Host 不重写循环。边界见 [ADR-037](docs/adr/ADR-037-modular-agent-runtime.md) 与 [ARCHITECTURE §14](docs/ARCHITECTURE.md)。
- **0.3 状态**：durable run、MCP 插件、远程监听 / TLS **已实现**（`release/0.3`，未随版本发布）；默认关闭 / 显式 opt-in。决策边界见 ADR-039 / 040 / 041。
- **0.4 状态**：workflow、evals、飞书渠道、metrics / 事件历史 / pruneRuns **已实现**（`release/0.4`，未随版本发布）；三个能力全部是插件、默认关闭；0.4 只做发布干跑，不 tag / publish / 合并 `main`。决策边界见 ADR-042 / 043 / 044 / 045。
- **0.5 状态**：文件优先存储、trace、统一 RPC 方法表 v1.1、多租户、YAML 主配置 **已实现**（`release/0.5`，未随版本发布）；默认 `session.backend: file`、trace 默认 `full`、tenant 缺省 `default`。插件 tenant 行为与 `--serve` 每 tenant 独立执行面 **已实现**；gateway 的 workflow / 飞书控制面仍只走 default tenant。微信不做。决策边界见 ADR-046 ~ ADR-050。
- **0.6 状态**：F5 跨机器远程、独立前端与跨节点 team **已实现**（`release/0.6`，未随版本发布）：`--connect` 非回环强制 HTTPS + token/CA，`serve.allowed_origins`，`transport.kind: remote` 静态节点与 `(node_id, seq)` 事件去重。默认仍本机回环；跨节点 team 控制面 default/admin-only。决策边界见 ADR-051 ~ ADR-053。
- **0.7.1 状态**：0.7 的 P0 加固补丁线（基于 `release/0.7`，未随版本发布）：legacy WS 方法统一按 principal/tenant 作用域执行；tenant 单写者锁修复回收 TOCTOU 与 24h 语义；外部插件仍默认加载但启动告警，并提供 `VESSEL_NO_EXTERNAL_PLUGINS=1` 显式 opt-out（P0-3 记为 **MITIGATED**，未关闭）。
- **0.8.0 状态**：Wave 1 结构收口（基于 `release/0.8`，未随版本发布）：core 的 run 级状态收敛到 `RunExecution` + 单 run 守卫 `run_already_running`，`run()` / `resume()` 共用 `finalizeRun` 终态路径；hook 抛错发 `hook.error` 并继续，guardrail 抛错 fail-closed（`guardrail_error`）；本地 RPC `subscribe` 接线；headless 统一清理；`--resume-run` / `FileRunStore` 走 tenant 目录与归属校验；Web seq 回退重放、durable REST admin 显式 tenant；`read` / `bash cwd` 路径边界与内置凭据 denylist。决策见 ADR-054 / ADR-055。
- **0.8.1 状态**：Wave 2A 加固（基于 `release/0.8.1`，未随版本发布）：`atomicWrite` 默认 fsync（temp 文件 fsync → rename → 尽力目录 fsync）；`SessionCorruptError` 让损坏的 session / tenant run 不再被静默当成不存在或删除，`listRich` 降级跳过；`deleteSessionData` 冲突检查全量分页（`RunStore.list` 新增 `offset`）；配置收敛为单一 resolver（`cliOverrides`、`serve` / `connect` 不再自行读 argv / env）；Gateway 拆分第一阶段（auth / frames / sse / static），协议与公开导出不变。决策见 ADR-056 / ADR-057。
- **0.8.2 状态**：Wave 2B1 统一工具执行（基于 `release/0.8.2`，未随版本发布）：新增 core `ToolPipeline`（getTool → ToolCall guardrail → BeforeTool → permission（最终工具与参数）→ handler（timeout/signal）→ ToolResult guardrail → AfterTool）；`AgentRuntime` 改用管道并关闭外层已处理阶段；workflow `type: tool` 注入 pipeline 后与 runtime 同语义并发布 `tool.call.*`；delegate 子 runtime 继承父级 resolved 权限；runtime / delegate / workflow 共用同一 permission。决策见 ADR-058。
- **0.8.3 状态**：Wave 2B2A 结构拆分（基于 `release/0.8.3`，未随版本发布）：Gateway 方法表按 domain 拆到 `packages/serve/src/gateway/methods/`（`createXxxMethods`），`gateway.ts` 只保留选项校验 / 状态 / 路由，协议与公开导出不变；CLI 一次性命令改为 `src/commands/registry.ts` 的有序注册表，`cli.ts` 删除顶层 `if` 链。决策见 ADR-059 / ADR-060。
- **0.8.4 状态**：TUI 可见问题修复（基于 `release/0.8.4`，未随版本发布）：列表 key 改用 `lineKey(index)`；展示层统一 `sanitizeTerminalText()`（core / 工具原始返回值不变）；TUI 历史改为 `HistoryItem[]` 并保持 Markdown 渲染；`ink-repl.tsx` 用 `useWindowSize()` 订阅 resize，`VIEW_MAX_WIDTH` 160，矮终端隐藏 live。决策见 ADR-061。
- **0.8.5 状态**：TUI 本地化（基于 `release/0.8.5`，未随版本发布）：`packages/tui/src/i18n/` 提供 zh-CN / en 两份 catalog（各 271 个 key）与 `t(key, params?)`；locale 优先级 `VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN`，默认 zh-CN 文案与 0.8.4 逐字一致。CLI 一次性命令与 Web 未本地化，命令数据输出仍为英文。决策见 ADR-062。
- **0.8.6 状态**：mock 场景化与 `vessel demo`（基于 `release/0.8.6`，未随版本发布）：新增 app 层 `src/mock/scenarios.ts`（`echo` / `tools` / `permissions` / `error` / `multi-turn`，场景名冻结，默认 `echo` 与 `MemoryLLMProvider` 逐字一致）；`VESSEL_MOCK_SCENARIO` 只在 `src/cli.ts` 读取并经 bootstrap / tenant runtime factory 透传到 provider factory；`vessel demo` 走 bootstrap / REPL，固定 `tools`，数据目录隔离到 `<dataDir>/demo`，非 TTY exit 1。core 不变。决策见 ADR-063。
- **0.8.7 状态**：上下文默认预算与发布前置（基于 `release/0.8.7`，未随版本发布）：`context.maxTokens` 默认 4096 → 1,000,000（core `context-manager.ts` 三处 fallback + config `defaults.ts`），`provider.maxTokens` / 请求 `max_tokens` 仍 4096；自动压缩阈值仍 0.8，默认约 800k 估算 token 触发。`quality` / `cross-platform` 在 `bun test` 前安装 `apps/web` 依赖；`scripts/version.ts` 写模式同步所有 manifest 的 `@vessel-agent/*` 依赖为精确目标版本。决策见 ADR-064。
- **0.9.0 状态**：Wave 2B2B 收口（基于 `release/0.9.0`，未随版本发布）：core 插件生命周期 v2（`init` 全部安装后按序调用、`dispose` 逆序 best-effort 且幂等、安装失败按插件回滚后重抛）；37 个 canonical 方法补 `result_schema`，`VESSEL_VALIDATE_RESULTS=1` 时校验结果，`PROTOCOL_VERSION` 成为协议版本单源；跨节点事件键改为 `${node}:${incarnation}:${run_id ?? '-'}:${seq}`，消息键含 tenant / from，网关 `hello` / `peers` 透出 `incarnation`。CI 的 Test step 固定 `VESSEL_VALIDATE_RESULTS=1`。决策见 ADR-065 / 066 / 067。
- **0.10.0 状态**：发版硬化（基于 `release/0.10.0`，未随版本发布）：配置与首启（`resolveEffectiveApiKey()` 单源、legacy `default_provider` / `providers` 只读兼容且新版 `provider:` 优先、未知 provider 无 `base_url` 时 `ProviderConfigError`、YAML 解析 / 重复键转 validation error、`config show --sources` 脱敏）；运行时（去掉 100 条硬截断、400 context-overflow 先压缩再重试一次、`interrupt('shutdown'|'timeout'|'user')`、gateway stop 幂等并 drain ≤5s、固定关闭顺序）；可观测（core `Logger` 端口 + stderr JSON + redact、`process.error` / `shutdown.failed`、provider 120s 超时与 `onRetry`、MCP `mcp.warning`、trace 0600 且默认不落 `llm.stream.chunk`）；分发（根包 `vessel-agent`、18 子包 `files:["src"]` + 元数据、`scripts/smoke-install.ts` 与 `install-smoke` job）；CLI i18n（zh-CN / en 各 85 key）。决策见 ADR-068 / 069 / 070 / 071。

## 代码风格与硬规矩

- 不引入 LangChain / LangGraph。
- 不加重依赖。core 的 `dependencies` 保持为空；重依赖只能进插件包。
- **core 保持小**。core 里不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）。
- 不新增第二套扩展机制——一切走 `Plugin` + `PluginHost`。
- 不新增事件名常量/枚举。事件名一律是开放字符串字面量，命名空间 `<domain>.<action>.<event>`。
- workflow / evals / feishu 只做插件，不进 core；core 的 `dependencies` 保持为空。workflow 不注册模型工具；evals 默认离线，真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控；飞书凭据只走 env/config，`app_secret` 永不打印。
- 0.4 发布只做干跑：`scripts/release-dry-run.ts`；不 tag、不 publish、不合并 `main`。
- 全异步。不写 sync-in-async（阻塞调用混进异步路径）。
- 不留半成品 stub（`throw new NotImplementedError()` / 空实现进 core）。
- **单 run 守卫与统一终态**（0.8，ADR-054）：同一个 `AgentRuntime` 同时只允许一个 active run。`run()` / `resume()` 必须经 `beginExecution` 占位、`finalizeRun` 收尾；不要绕开 `activeRun`，也不要另写一份终态持久化 / 事件发布路径。第二个 run 抛 `run_already_running`（`RunAlreadyRunningError`）。
- **插件异常必须隔离**（0.8，ADR-054）：Hook 抛错发 `hook.failed` + `hook.error` 后继续后续 hook；`OnError` 始终 best-effort；Guardrail 的 `check()` 抛错按 fail-closed 处理（`allowed:false` + `guardrail_error`，发 `guardrail.error`），不得让插件异常以原始异常形式冒泡；随后仍按该阶段的 blocked 语义执行。
- **工具路径边界**（0.8，ADR-055）：`read` / `bash cwd` 统一走 basic-tools 的 `evaluatePath`；内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）是硬 `deny`，`allowed_roots` 只把越界降级为 `ask`，`deny_paths` 只能追加。比较必须基于 realpath（含最近已存在祖先），不要用未解析的字符串前缀。
- **持久化写入**（0.8.1，ADR-056）：session / checkpoint 一律走 `atomicWrite`，默认 `durable: true`（temp fsync → rename → 尽力目录 fsync）；不要直写最终路径，不要吞掉 `AtomicWriteError`。只有临时文件或测试才显式 `durable: false`。
- **损坏检测**（0.8.1，ADR-056）：文件存在但不可读 / JSON 损坏一律抛 `SessionCorruptError`，不得当成“不存在”返回 `null`；否则下一次 save 会覆盖原文件。删除同样先 `load()`，损坏时抛错不 unlink；只有 `listRich()` 允许逐项降级跳过。
- **配置层序与单一 resolver**（0.8.1，ADR-057）：层序固定 `CLI > env > tenant overlay > project > user > default`，只在 `loadConfig()` 合并。CLI flag 必须经 `buildCliConfigOverrides()` → `cliOverrides`；serve / connect 不得自行读 argv 或 `process.env`。`defaults` 仅为 deprecated 兼容层。
- **工具执行必须走统一 pipeline**（0.8.2，ADR-058）：任何入口都不得直调 `ToolDefinition.handler`（workflow 未注入 pipeline 的 deprecated 兼容路径除外）；走 `ToolPipeline`（阶段顺序 getTool → ToolCall guardrail → BeforeTool → permission（最终工具与参数）→ handler（timeout/signal）→ ToolResult guardrail → AfterTool）。权限必须在 guardrail/hook 改写之后判定；`tool.call.*` 由调用方发布，管道不发布。
- **新 RPC 方法进 domain 模块**（0.8.3，ADR-059）：新方法加到 `packages/serve/src/gateway/methods/<domain>.ts` 并导出 `createXxxMethods`，由 `gateway.ts` 展开组装；不要把方法表回灌 `gateway.ts`（`events.subscribe` 因依赖连接状态是例外）。方法名 / schema / 返回形状 / 错误码 / 鉴权顺序必须保持兼容。（以代码事实为准，改代码时同步改本节。）
- **新一次性 CLI 子命令进注册表**（0.8.3，ADR-060）：加到 `src/commands/registry.ts` 的 `cliCommands`，实现 `match(args)` / `run(args, ctx)`；不要在 `cli.ts` 加新的 `if` 链。顺序即语义，宽泛的 `match` 会遮蔽后面的命令。（以代码事实为准，改代码时同步改本节。）
- **TUI 展示层统一清洗与 key**（0.8.4，ADR-061）：渲染工具 / 命令文本前用 `sanitizeTerminalText()`，不要在 core / 工具层清洗（原始返回值必须保持原样）；列表 key 用 `lineKey(index)`，不要用文本内容或累计偏移。
- **TUI 用户可见文案必须走 `t()`**（0.8.5，ADR-062）：新增或修改 UI 文案一律用 `t(key, params?)`，并把 key 同时加入 `packages/tui/src/i18n/messages/zh-CN.ts` 与 `en.ts`；中文字面量不得作为 UI 文案直接出现在组件 / 命令里；仅 catalog 与非 UI 逻辑（如 CJK 宽度检测）允许。技术词、命令名、工具名、错误码不翻译；命令的数据输出保持英文。默认 zh-CN 文案不得改动已有措辞。
- **mock 场景只在 app 层**（0.8.6，ADR-063）：场景 provider 放 `src/mock/`，core 不出现场景概念，`MemoryLLMProvider` 及其公开导出保持原样；`VESSEL_MOCK_SCENARIO` 只在 CLI 入口读一次，工厂接收已解析的场景名，不得在 bootstrap / provider factory 里读 env；默认 `echo` 的文本 / usage / 流式分片不得改，场景名只能追加、不能改名。
- **上下文默认预算是 1M，不是 4096**（0.8.7，ADR-064）：`context.maxTokens` 默认 1,000,000；`provider.maxTokens` / 请求 `max_tokens` 是单次输出上限（config 默认 4096），两者不可混用。依赖旧 4096 默认的调用方必须显式传 `maxTokens`；不要假设 1M 适用于小窗口模型（如 8k），需显式配置 `context.maxTokens`。
- **插件资源必须可回收**（0.9，ADR-065）：新增插件若在 `install()` 期间创建资源（连接、定时器、子进程、文件句柄、订阅），**必须**实现 `dispose()` 并在其中释放；不得在 `install()` 里创建不可回收资源。`init()` 在所有插件安装完成后按安装顺序调用，不得假设“后续插件已安装”。安装失败由 `beginPluginInstall()` 的 `rollback()` 清理，不要手动逐个反注册，也不要把安装失败改成隔离继续（安装阶段保持 fail-fast）。`dispose()` 必须幂等或可安全重复调用。
- **canonical 方法必须带 result_schema**（0.9，ADR-066）：新增或修改 canonical RPC 方法时必须同时写 `result_schema`，复用 `gateway/methods/schemas.ts` 的片段；只使用校验器支持的子集，不引入 `oneOf` / `$ref` / `additionalProperties`。CI 的 Test step 以 `VESSEL_VALIDATE_RESULTS=1` 运行，结果形状漂移会直接失败；本地如改了结果形状，用该变量复跑相关测试。协议版本一律引用 `PROTOCOL_VERSION`，不要写字面量 `1`。
- **去重键必须含范围维度**（0.9，ADR-067）：事件键必须包含 `node`、`incarnation` 与 `run_id`（缺失写 `-`）；消息键必须含 `from`，gateway 层还必须含 `tenant`。代际变化或 seq 回退只清该来源节点的键，**不得**退回全局 `clear()`；无 `seq` 的帧不参与去重。去重集合不持久化，文档不得宣称跨重启 exactly-once。
- **配置 legacy 只读兼容**（0.10，ADR-068）：legacy `default_provider` / `providers` 只读，新版 `provider:` 优先；两者并存必须发 deprecation warning，不得让 legacy 覆盖新版。未注册 provider 且无 `provider.base_url` 必须抛 `ProviderConfigError`，不得猜厂商默认端点；已知 provider 缺 model 同样 fail-fast。YAML 解析失败 / 重复键必须是 validation error，不得静默回落默认配置。API Key 一律经 `resolveEffectiveApiKey()`。
- **诊断走 Logger（stderr）**（0.10，ADR-069）：诊断日志一律经 core `Logger`（CLI / serve 注入 `createCliLogger()`），写 stderr；**不得** `console.log` 到 stdout（stdout 只留命令结果 / JSON / UX）。`VESSEL_DEBUG` 只提级别，不打印 prompt 正文；日志 message / fields 必须经 redactor，异常兜底只带 `kind` 与脱敏 message。未捕获异常必须走 `process.error` + 限时 shutdown，不得让运行时默认打印。
- **关闭必须 await gateway.stop()**（0.10，ADR-070）：serve 路径固定 `await gateway.stop()` → 取消订阅 / 关闭 transport → `beforeClose` → `closeAll` → `shutdown`，后两步传 `{ drain: false }`，不得二次 drain。中断 active run 用 `interrupt('shutdown')`（或 `timeout` / `user`），不得只 abort signal 而丢失原因；`shutdown` / `timeout` 必须落可恢复的 `interrupted` checkpoint。
- **发布包名与包元数据**（0.10，ADR-071）：根包发布名为 `vessel-agent`（bin 仍是 `vessel`）；18 个可发布子包必须带 `files: ["src"]`、`license`、`repository`、`engines`。改发布形态后必须跑 `scripts/smoke-install.ts`；发布顺序固定 core → permission → config → serve → tui → plugins → 根包，不得先发根包。
- **CLI 用户可见文案走 `src/i18n/`**（0.10）：`--help` / 一次性命令错误 / 默认空状态 / demo banner 必须用 `t(key, params?)`，zh-CN 与 en 两份 catalog 同步；命令的数据输出保持英文，技术词、命令名、错误码不翻译。`--help` 在配置加载前短路，只能读环境变量层。
- **测试隔离**（0.8.2）：不要用 `mock.module`（Bun 进程级污染，会串到其他测试文件）；改用依赖注入、纯函数与工厂。delegate / workflow 的接线测试必须可独立运行。
- 不给 core 加默认厂商 API Key / Base URL / 价格。Key 永远用户自备。
- 引用文件路径前先确认它存在。本仓库已删除 `docs/specs/`、`docs/role/`、`docs/api/`、`docs/guides/`、`docs/dev/`、`processes/`、`legacy/`——指向它们的链接都是错的。
- 文档只写已实现；规划项明确标注。不吹未实现的能力。

## 文件与目录

共享侧与个人侧的分工、目录结构、角色独占路径、分支与发布规则，见 [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)。简版：

- 共享侧（本仓库）只放源码、测试、长期文档、CI；handoff / 计划 / 报告 / worktree 一律放个人侧，不提交。
- 每个角色只写自己的独占路径；跨路径改动先与 1 协商。
- 版本线：`main` → `release/0.10.0` → `0.10-<role>`（`release/0.1` ~ `release/0.9.0` 已冻结；0.10 复用 `worktrees/0.7-<role>`）；发布由 tag `v*` 触发，不由分支名触发。0.10.0 只干跑，不 tag、不 publish、不合并 `main`。

## 怎么跑

```bash
bun test                                        # 测试
bun run typecheck                               # tsc --noEmit
bunx @biomejs/biome ci .                        # lint + format 检查
VESSEL_MOCK=1 bun run src/cli.ts                # 模拟模式起 REPL（不需要 API Key）
VESSEL_MOCK=1 bun run src/cli.ts --run "hello"  # headless 冒烟
bun run src/cli.ts --version                    # 版本（根 package.json）
bun run src/cli.ts --tools                      # 当前配置下的工具（无 Key）
bun run src/cli.ts update --check               # 检查新版本（只提示）
bun run src/cli.ts config path                  # YAML 路径 + data_dir
bun run src/cli.ts config init                  # 生成用户配置模板（不含真实密钥）
bun run src/cli.ts config show --sources        # 脱敏配置与来源
bun run src/cli.ts tenant list                  # tenant 元数据
bun run src/cli.ts migrate --from sqlite --to file-v2   # 默认 dry-run
bun run src/cli.ts trace prune --dry-run        # 查看将清理的 trace
bun run demo                                    # 无 Key 跑核心示例
bun run src/cli.ts workflow list                # workflow run 列表（controls-only 可用）
bun run src/cli.ts eval smoke                   # eval suite（默认离线）
bun run src/cli.ts --feishu                     # 前台运行飞书渠道（需 enabled + 凭据）
bun run scripts/version.ts --check              # 版本一致性 + CHANGELOG 校验
bun run scripts/release-dry-run.ts              # 发布干跑（不 tag / 不 publish）
```

改完代码，这三个必须过：`bun test` / `bun run typecheck` / `bunx @biomejs/biome ci .`。
收口还要求 `check-deps` / `smoke-subpaths` / `check-docs` / `version --check` / `release-dry-run`。
CI 与发布流程见 [docs/operations/CI-CD.md](docs/operations/CI-CD.md)、[docs/operations/RELEASE.md](docs/operations/RELEASE.md)。发布由 tag `v*` 触发，只有 1 打 tag；N 不发布、不合并。

## 分层与能力准入

新增能力前先分类：**进 core / 做成插件 / 放应用层**。

进 core 必须全部满足：大多数 harness 都需要、领域无关、可接口化、不绑 Provider 或厂商 SDK、能被多个应用复用。

**拿不准就选插件，不选 core。** core 只放领域无关的运行时；其余一律做成 `plugins/<category>/<name>/` 下的插件（放文件夹即注册，无需改代码、无需构建步骤——但插件目录在**进程启动时扫描一次**，新增插件要重启进程才生效）。应用层外壳（TUI、配置向导、gateway、web）不往 core 反推需求。

**Module ≠ Plugin**（0.2 已实现）：Module 是编译期/构造期边界（provider / context / session / policy / transport / observability，一个 port 一个实现）；Plugin 仍是唯一运行期扩展机制。禁止 `ModuleHost` / `ModuleRegistry` 或第二套扩展机制。依赖方向由 `scripts/check-deps.ts` 自动检查。

判断"要不要动 core"时的自检：

```
[ ] 能做成 Tool（Plugin 里 registerTool）吗？
[ ] 能做成 Hook / Guardrail 吗？
[ ] 能做成事件（开放字符串）吗？
[ ] 能由 bash + 模型自己组合出来吗？
→ 任一为"是" → 不进 core。
```

## 插件发现与信任边界

插件是唯一运行期扩展机制。默认发现顺序（同名时**先出现者胜出**）：

`repo`（仓库 `plugins/`）→ `project`（`./.vessel/plugins`）→ `user`（`~/.vessel/plugins`）→ `node_modules`（仓库根与 cwd 的 `node_modules/@vessel`）。

- 配置未写 `plugins` 时，默认集加载**全部**可用插件，包括 project / user / node_modules 来源的**外部插件**；工厂式插件仍按各自开关构造。
- 启动时（`bootstrap` / `--tools` / `doctor`）向 **stderr** 打印一次外部插件告警，列出来源与名称；告警不进入 stdout / JSON。
- `VESSEL_NO_EXTERNAL_PLUGINS=1`（或 `true`）时，默认集只选 `source === 'repo'` 的插件。
- 显式 `plugins:` 列表始终可以加载指定外部插件（**显式即信任**），不受 opt-out 影响。
- **残余风险（P0-3 MITIGATED，未关闭）**：外部插件在启动时通过动态 import 执行，拥有完整进程权限，早于任何工具权限判定。不可信仓库务必设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`，且不要把不可信插件写进 `plugins:`。

## 别做什么

- 别把插件对象塞进 runtime 构造函数（走 `plugins` 或 `pluginHost` 注入）。
- 别在 core 里引用 `tui` / `config` / `plugins`（依赖方向是单向的）。
- 别为了加能力去改 loop 或扩接口——先证明 Tool / Hook / Guardrail / 事件都做不到。
- 别给模型再加一个能干的、能与 bash 等价的事的工具。
- 别写 harness 层面的 skills 扫描 / 解析 / 注入通道——skills 就是文件，经消息进来。
- 别把 MCP / workflow / evals / feishu 塞进 core（它们都是插件）；durable 只做 core 的 `RunStore` port；workflow 不注册模型工具；多租户已进 core（`tenant` 解析/隔离原语），0.6 的跨机器远程 / 跨节点 transport 已在装配层实现（core 只加可选字段）；team 仍默认 off、显式 opt-in。
- 0.5 默认 `session.backend: file`；不要删除 sqlite 后端，也不要在检测到 legacy 数据时自动迁移——只提示 `vessel migrate`。
- 别把 tenant overlay 写成能覆盖 CLI/env；优先级固定 `CLI > env > tenant overlay > project > user > default`。
- 别绕开 RPC 方法表直接调内部实现；新增 canonical 方法必须发 addendum。
- 别在 trace / 事件 / 日志 / `config show` 输出解析后的密钥值；0.5 不脱敏 checkpoint / eval 报告 / 飞书回复，文档不得写成“已脱敏”。
- 别让多个进程同时写同一 tenant；写前必须拿 `.lock`，冲突返回 `tenant_locked`。
- 别在日志 / 事件 / 报告里输出飞书的 `app_secret` 或完整 `app_id`；只允许前 4 位 + `***`。
- 别默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环不得匿名。
- 别给 MCP 工具设默认 `allow`；除非在 `auto_approve_tools` 里按原始工具名精确列出。
- 别让 Host 与成员 runtime 同时写同一个 run 的 checkpoint（唯一写者是 `AgentRuntime`，Host store 优先）。
- 别在同一 runtime 上并发跑多个 run（守卫会拒绝）；需要并行就用多个 runtime（Host 的“一 agent 一 runtime”）。
- 别靠 hook / guardrail 抛异常来终止 run：hook 异常被隔离，guardrail 异常按 fail-closed 转成 `guardrail_error`。要阻断就返回 `allowed: false`，要停止就 abort。
- 别把内置凭据 denylist 改成 `ask` 或做成可移除；也别把 `allowed_roots` 当沙箱——`bash` 只校验 `cwd`，`edit` 未纳入边界。
- 别在 headless 分支里提前 `process.exit` 跳过 gateway / tenant / transport / shutdown 清理。
- 别把“文件存在但损坏”当成“文件不存在”：覆盖或删除损坏的 session / tenant run 会关闭唯一恢复窗口。
- 别在 `serve-config` / `bootstrapConnect` / 其他入口自行合并 argv 或 `process.env`；新增 CLI flag 必须加入 `buildCliConfigOverrides()`。
- 别在文档里描述一个不存在的架构。
- 别绕过 PR 直接 push main。
