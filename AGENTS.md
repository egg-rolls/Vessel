# AGENTS.md

> Vessel 仓库的 AI 行为约定。与代码冲突时以代码为准，并顺手改掉本文档。

## 项目是什么

Vessel 是一个**可嵌入的多 agent 平台 runtime**：极简核心（稳定接口 + 1 个通用 tool-calling loop + 扩展插槽）、Provider 无关；TUI / CLI / Web / Gateway 是参考 harness 外壳。
- **语言/运行时**：TypeScript + Bun。
- **monorepo**：bun workspaces。`packages/{core,agent,config,tui,serve,permission}` + `plugins/` + `apps/web`。
- **形态**：`@vessel-agent/core` 是库（零 UI 依赖，可嵌入）；`@vessel-agent/agent` 是成员能力层；TUI / serve / web 是应用层外壳。
- **工具集**：能力工具只有 `bash` / `read` / `edit` 三个。内置 `agent`（owner 动作 `new` / `send` / `close` / `list` / `rotate` / `post`，支持 batch；成员侧只暴露 `rotate` / `post` / `send` / `list`，不能 `new` / `close`；成员 `send` 走统一 dispatch）由 bootstrap 默认注册（显式 `agent.enabled: false` 关闭）；不提供 `wait` / `inbox` / `status` / `cancel`。`ask_user` 在交互 REPL（TTY）或 gateway/serve 注册；`team_*` / `delegate_task` 已删除；配置 `mcp_servers` 后额外注册 `mcp__<server>__<tool>`（数量动态）。实测：默认 4（3 个能力工具 + `agent`）；显式 `agent.enabled: false` 为 3；交互 REPL / serve 默认 5（+`ask_user`）；交互且关闭 agent 为 4。别急着加第四个能力工具。
- **状态**：alpha，pre-MVP。未实现的能力一律标注，不写进正文。

## 版本状态

- 当前状态（当前版本、已合入能力、下一步）：`docs/versions/CURRENT.md`。
- 历史与索引：`docs/versions/INDEX.md`（一个版本一个文件，只追加）。
- 文档分类、生命周期与代码注释规则：`docs/DOC-MANAGEMENT.md`。
- 规则只写约束，不写版本叙事；版本结果与已合入能力不要写回本文件。

## 代码风格与硬规矩

- 不引入 LangChain / LangGraph。
- 不加重依赖。core 的 `dependencies` 保持为空；重依赖只能进插件包。
- **core 保持小**。core 里不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）。
- 不新增第二套扩展机制——一切走 `Plugin` + `PluginHost`。
- 不新增事件名常量/枚举。事件名一律是开放字符串字面量，命名空间 `<domain>.<action>.<event>`。
- evals / feishu 只做插件，不进 core；core 的 `dependencies` 保持为空。workflow 已移除，不得恢复；evals 默认离线，真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控；飞书凭据只走 env/config，`app_secret` 永不打印；gateway 的飞书控制面只走 default tenant；微信不做。
- 发布只做干跑：`scripts/release-dry-run.ts`；不 tag、不 publish、不合并 `main`（1.0 前不发布）。
- 全异步。不写 sync-in-async（阻塞调用混进异步路径）。
- 不留半成品 stub（`throw new NotImplementedError()` / 空实现进 core）。
- **单 run 守卫与统一终态**（0.8，ADR-054）：同一个 `AgentRuntime` 同时只允许一个 active run。`run()` / `resume()` 必须经 `beginExecution` 占位、`finalizeRun` 收尾；不要绕开 `activeRun`，也不要另写一份终态持久化 / 事件发布路径。第二个 run 抛 `run_already_running`（`RunAlreadyRunningError`）。
- **插件异常必须隔离**（0.8，ADR-054）：Hook 抛错发 `hook.failed` + `hook.error` 后继续后续 hook；`OnError` 始终 best-effort；Guardrail 的 `check()` 抛错按 fail-closed 处理（`allowed:false` + `guardrail_error`，发 `guardrail.error`），不得让插件异常以原始异常形式冒泡；随后仍按该阶段的 blocked 语义执行。
- **工具路径边界**（0.8，ADR-055）：`read` / `bash cwd` 统一走 basic-tools 的 `evaluatePath`；内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）是硬 `deny`，`allowed_roots` 只把越界降级为 `ask`，`deny_paths` 只能追加。比较必须基于 realpath（含最近已存在祖先），不要用未解析的字符串前缀。0.14.2 起 `bash` 另在命令文本里匹配同一组内置 denylist（`~` / `$HOME` / `${HOME}` / 绝对路径写法，归一大小写与 `/`、`\`）：`checkPermission` 命中返回 `deny`，执行前复查返回 `path_denied`。0.15 起自定义 `deny_paths` 也参与该文本匹配（同样按 `~` / `$HOME` / `${HOME}` / 绝对路径 / 相对路径展开）。**这是 best-effort 字符串匹配，不是沙箱**——`cd` 后的相对路径、变量拼接、引号拆分、通配符、符号链接、`~root`、`%USERPROFILE%` 仍可能绕过。
- **持久化写入**（0.8.1，ADR-056）：session / checkpoint 一律走 `atomicWrite`，默认 `durable: true`（temp fsync → rename → 尽力目录 fsync）；不要直写最终路径，不要吞掉 `AtomicWriteError`。只有临时文件或测试才显式 `durable: false`。
- **损坏检测**（0.8.1，ADR-056）：文件存在但不可读 / JSON 损坏一律抛 `SessionCorruptError`，不得当成“不存在”返回 `null`；否则下一次 save 会覆盖原文件。删除同样先 `load()`，损坏时抛错不 unlink；只有 `listRich()` 允许逐项降级跳过。agents 快照与 interactions 文件不阻塞启动：先隔离为 `<path>.corrupt-<timestamp>` 保留原字节（隔离失败则禁止覆盖）；`team.json` 损坏记 error 且禁止 `ensureForWorkspace` / `seed` 在同路径重建（`team_metadata_corrupt`）；该错误码经 owner 端点与 `agent` 工具原样透出，不得降级成 generic internal / `invalid_input`。
- **配置层序与单一 resolver**（0.8.1，ADR-057）：层序固定 `CLI > env > tenant overlay > project > user > default`，只在 `loadConfig()` 合并。CLI flag 必须经 `buildCliConfigOverrides()` → `cliOverrides`；serve / connect 不得自行读 argv 或 `process.env`。`defaults` 仅为 deprecated 兼容层。
- **工具执行必须走统一 pipeline**（0.8.2，ADR-058）：任何入口都不得直调 `ToolDefinition.handler`；走 `ToolPipeline`（阶段顺序 getTool → ToolCall guardrail → BeforeTool → permission（最终工具与参数）→ handler（timeout/signal）→ ToolResult guardrail → AfterTool）。权限必须在 guardrail/hook 改写之后判定；`tool.call.*` 由调用方发布，管道不发布。
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
- **关闭必须 await gateway.stop()**（0.10，ADR-070）：serve 路径固定 `await gateway.stop()` → 取消订阅 / 关闭 transport → `beforeClose` → `closeAll` → `shutdown`，后两步传 `{ drain: false }`，不得二次 drain。中断 active run 用 `interrupt('shutdown')`（或 `timeout` / `user`），不得只 abort signal 而丢失原因；`shutdown` / `timeout` 必须落可恢复的 `interrupted` checkpoint。AgentService 在 `agentControl.dispose()` 里 `drain({ timeoutMs: 5000 })` 中断并等待成员轮，之后不再起新轮；成员轮必须在 tenant `eventLog.close()` 之前收口，否则尾部事件 append 被拒 `session_event_log_closed`。
- **发布包名与包元数据**（0.10，ADR-071）：根包发布名为 `vessel-agent`（bin 仍是 `vessel`）；可发布子包（当前 16 个）必须带 `files: ["src"]`、`license`、`repository`、`engines`。改发布形态后必须跑 `scripts/smoke-install.ts`；发布顺序固定 core → permission → config → serve → tui → plugins → 根包，不得先发根包。`scripts/version.ts` 写模式同时把所有 manifest 的包间 `@vessel-agent/*` 依赖改为精确目标版本，只有收口人执行。
- **CLI 用户可见文案走 `src/i18n/`**（0.10）：`--help` / 一次性命令错误 / 默认空状态 / demo banner 必须用 `t(key, params?)`，zh-CN 与 en 两份 catalog 同步；命令的数据输出保持英文，技术词、命令名、错误码不翻译。`--help` 在配置加载前短路，只能读环境变量层。
- **包名统一 `@vessel-agent/*`**（0.11，ADR-073）：可发布子包（当前 16 个）的 `name`、包间依赖与 import specifier 一律使用 `@vessel-agent/<name>`，不得回退到旧 `@vessel` scope；根包名保持 `vessel-agent`，bin 仍是 `vessel`。历史 ADR / CHANGELOG 的旧包名是有意存档，不要批量改写；改发布形态或包名后必须跑 `release-dry-run` + `smoke-install`。
- **TUI 语言变更必须经 `ctx.settings`**（0.11，ADR-072）：`/settings` 等入口不得直接写用户配置文件，必须调用注入的 `setLanguage`；成功后再 `setLocale` 立即重渲染，未注入时保持只读，失败显示 `error.command.settings`。写配置只改 `ui.language`、保留其它键、`0600` 原子写。`VESSEL_LANG` 仍高于 `config.ui.language`，不要声称设置命令能覆盖显式环境变量。
- **新面板默认全宽、常驻信息用 PanelFrame**（0.11，ADR-072）：不要再引入 `VIEW_MAX_WIDTH` 一类的固定上限；宽度用 `viewWidth(columns)`（`cols - 2`）。状态栏 / 启动头 / 队列预览等常驻信息用 `PanelFrame`，行数预算同步计入 `STATUS_BAR_ROWS = 3`；minimal 数据行封顶 `MINIMAL_ROW_CAP = 3`，新增 chrome 必须同时改 `viewCapacity()` 的测试。
- **Web 新文案必须走 `apps/web/src/i18n`**（0.11，ADR-072）：每个新增 key 同时加 zh-CN 与 en 两份 catalog；locale 解析保持 `localStorage['vessel.ui.language']` > `navigator.language`，切换经 `setLocale` 并同步 `<html lang>`。未收录 key 回退中文，但不得把回退当成“已本地化”。
- **Web 不用 `backdrop-filter` 做层级**：全屏遮罩与应用栏保持不透明或半透明底色，层级靠边框与阴影表达。`backdrop-filter` 会为全屏 / 动画层强制额外合成与重采样，滚动、输入和流式文本时容易掉帧。
- **Web 的 Team 写操作只经 canonical `teams.*`**：创建 / 编辑 / 归档复用 `teams.create|update|archive`；成员 add / remove 仍走 CLI / owner 端点，Web 不直接改 roster。token 只存 `sessionStorage`，不落 `localStorage` / URL / 日志。
- **gateway 生命周期只经 `vessel gateway`**（0.12，ADR-074）：前台 `start` / `restart` 复用 `--serve` 装配管线，`--serve` 只是前台别名；不要再加第二条启动路径。运行态以 `<dataDir>/gateway.pid` 为唯一来源（0600 原子写；PID 存活且命令行匹配才算 running，stale 可回收）。`stop` 只删本进程持有的 PID；服务注册只在显式 `install-service` / `uninstall-service` 时执行，只做当前平台的用户级定义，不随启动或安装自动改本机。
- **`gateway.reload` 只承诺可验证的范围**（0.12，ADR-075）：`plugins` 只清扫描缓存（已安装插件 / active run 不变），`config` 只热更新 `serve.allowed_origins`；provider / model / agent / permission / TLS / token / port 变更必须如实进 `requires_restart`，不得报成已生效。未知 scope、配置读取失败、`reconfigure` 抛错必须返回 RPC 错误。
- **CLI 人类输出走 `ui-style`，`--json` 无 ANSI**（0.12，ADR-076）：一次性命令的人类可读输出用 `src/ui-style.ts` 的 `ui`，不要自行拼 ANSI；ANSI 只在 TTY、未设 `NO_COLOR`、`TERM !== 'dumb'` 时输出。`--json`、路径与数据行保持纯文本。`vessel update` 只在 npm / bun 全局安装时执行全局升级；dev / unknown 只提示，不改工作区；非 TTY 必须显式 `--yes`。
- **权限交互时效**（0.11.1→0.12.0 ADR-077；0.13 修订见 ADR-079；0.18 修订见 ADR-079 Addendum）：权限请求与 `ask_user` 默认都**无限等待**，不得重新引入 120s 自动超时或固定 TTL；`ask_user` 由应答 / abort（run 取消）/ run 终态收口，abort 返回明确的取消文案（不伪装成超时）。Web 权限卡片不按 `expiresAt` 丢弃，提问卡片也不再有倒计时 / 过期。同一 `requestId` 只允许一次提交；`not_found` 移除卡片并提示。core 只有在显式正数 `timeoutMs` 时才抛 `PermissionTimeoutError`（`permission_timeout`）并让 run 失败。
- **权限 / ask 应答投递到 tenant 流**（0.18，ADR-079 Addendum）：`respondPermission` / `respondAsk` 只能发布到该 tenant 的运行时事件流（工具与权限策略在那里等待）；流不存在返回 `run_ended`，**不得回退任何共享流，也不得两边都发**。gateway 通过 `hub.streamFor(tenantId)` 解析，`src/cli.ts` 负责把各 tenant 的 `runtimeEvents` 注册进 hub。
- **tenant 事件流是唯一事件面**（0.18，ADR-089）：不得重新引入 `sharedEvents`、tenant→shared 桥或单流 `GatewayOptions.events`。gateway 只从 `TenantEventHub` 读取：raw fan-in 驱动 RunEngine，`map`（脱敏 + 裁剪）后的 sequenced fan-in 驱动广播 / registry / team。测试 helper 之外的 `tenantEventsFor` 传递也必须用 `hub.streamFor`。`hub` 不暴露 `publish`；诊断事件（`rpc.result_invalid` / `team.*`）只投 default tenant 流，缺失时丢弃。`gateway.stop()` 只退订，hub 由 app 在 `closeAll` 之后关闭。
- **reasoning 仅在 `ui.showReasoning` 开启时发布**（0.11.1→0.12.0，ADR-077）：默认 `false`；只有显式 `true` 才把 `reasoning_content` 转成 `reasoning_delta` 经 `llm.stream.chunk` 发布。TUI / Web 折叠展示；`trace.includeStreamChunks` 仍默认 `false`。
- **`agent.cwd` 优先级固定**（0.11.1→0.12.0，ADR-077）：工具参数 `cwd` > `agent.cwd` > `process.cwd()`；`bash` 默认 cwd 与 `read` / `edit` 相对路径都按 `agent.cwd` 解析。配置只提供默认目录，不得放宽 denylist / `allowed_roots` 的路径边界。
- **权限等待默认不超时**（0.13，ADR-079）：不得重新引入 120s 自动失败或任何固定 TTL。权限请求一直等待应答 / 取消 / abort；只有显式正数 `RuntimePermissionConfig.timeoutMs` 才产生 `PermissionTimeoutError`。abort 抛 `PermissionAbortedError`（`permission_cancelled`、`name: AbortError`），必须优先于超时判定，不得误报 `permission_timeout`。请求事件只允许加 additive 字段（`session_id` / `tool_call_id` / `deadline_at` / `source`），默认等待不得写 `deadline_at`。
- **权限记录必须持久化**（0.13，ADR-079）：serve 的 `pending` / `answered` / `orphaned` 必须写 `<dataDir>/interactions-<tenant>.json`（`atomicWrite` + `0600`）；gateway 启动时加载，重启后无对应 run 的 `pending` 转 `orphaned`。不得用 TTL 清扫 pending；run 终态要清出同 run 的 pending 并持久化。重复应答必须幂等返回首次结果，不同决定返回 `conflict`，`orphaned` 返回 `run_ended`；有界清理绝不淘汰 pending。
- **Web 权限必须内联**（0.13，ADR-079）：权限卡片放在所属 `RunCard` 内，跨 session 用顶部待处理条；不得恢复全局权限遮罩。其他端 `tool.permission.response` / `tool.permission.expired` 或 run 终态必须收起卡片；`expired` / `run_ended` 要提示对应语义。`ask_user` 改为 `RunCard` 内联（0.14.1，ADR-082），不得恢复全局遮罩；0.18 起提问不再按事件时间 120s 过期（默认无限等待，见 ADR-079 Addendum）。
- **状态栏字段与显隐按 ADR-078**（0.13）：上栏不查会话列表；路径按显示列中间省略 / 空闲 marquee，branch 固定最右；下栏字段、宽度分级与丢弃顺序固定在 `formatBottomBar`，`<40` 列不渲染、`<18` 行默认隐藏，显示时吸收 hint 行（净增 2）。`Ctrl+T` / `Ctrl+G` / `Ctrl+R` 的副作用（覆盖被插入的控制字符）必须保留。显隐持久化只写用户配置 `ui.status_bars`（YAML），`VESSEL_STATUS_BARS` 只作启动初始覆盖；配置键是 `ui.statusBars`，非法值拒绝。
- **错误 envelope 只增不改**（0.14，ADR-080）：`run.failed` / `tool.call.failed` 必须保留原 `error` 文本，新增 `error_code` / `category` / `phase` / `retryable` / `http_status?` / `details?` 只能附加；不得把 prompt / reasoning / 完整工具结果写进 envelope。分类与阶段枚举按 ADR-080，未知错误归 `internal_error`，不要自造 category。
- **trace 流式过滤覆盖前缀**（0.14，ADR-080）：`includeStreamChunks=false` 时必须同时过滤 `llm.stream.chunk` 与 `<prefix>.llm.stream.chunk`；只匹配字面量会让 subagent / 转发事件绕过 trace 策略。
- **Host 契约**（0.14.1，ADR-081）：per-run session 只由 `AgentHandle.run` 消费 `RunOptions.sessionId`，单 agent `run(input, sessionId)` 不读它；取消必须把 `RunInterruptReason` 经 `AbortSignal.reason` 透传；`resume` 必须经 Scheduler（用 `ScheduledTask.runId` 保持 run id），不得直连成员 runtime 绕过并发 / 串行；`snapshot()` 只返回可 JSON 序列化的数据；合成 `agent.run.*` 必须带 `mirror_of_run_id`。
- **ask_user 注册按入口**（0.14.1，ADR-082）：交互 REPL（TTY）或 gateway/serve 才注册，`--run` / headless / 管道一律不注册；`ui.askUser: false` 必须能按入口与 tenant 关闭；不得让显式 `true` 在无客户端入口注册。`--serve` 只保留隐藏兼容别名，不得重新写回 `--help`。
- **Web 可见性按配置渲染**（0.14.1，ADR-082）：`ui.verbosity` 决定 `minimal` / `normal` / `debug`；`minimal` 不得隐藏失败工具与 run 终态，`debug` 才显示 L3 原始事件；`debug` 与 `showInternalEvents: true` 取“或”；`errorLevel: all` 才放开 internal / process 级错误；缺失 / 非法值回退 `normal` / `false` / `user`。新增文案必须同时进 zh-CN 与 en catalog。
- **压缩摘要必须是 system 且同时最多一条**（0.14.2，ADR-083）：摘要写成 `role: 'system'` + `compaction_summary: true`，插在基底 system 之后、其它消息之前；应用新压缩时必须移除旧摘要。请求组装（缺省补回、hook 改写 system）只认非摘要 system，不得替换摘要内容。不要写回 `role: 'assistant'`——thinking 模式要求 assistant 历史带 `reasoning_content`，否则下一轮请求 400。Anthropic 侧必须合并全部 system 消息，不得只取第一条。
- **限额命中必须发 `limit.blocked` + envelope**（0.14.3，ADR-084）：限额命中（使用量限额或终止策略）时，runtime 必须在抛错前发布**一次** `limit.blocked`（data 含 `error_code: 'limit_blocked'`、完整 `LimitBlock`、`run_id`、`session_id`），并抛 `LimitExceededError`；`run.failed` 必须保留原 `error` 文本（使用量限额 `Usage limits exceeded: ...`，终止策略 `Termination policy triggered: ...`），附 `error_code: 'limit_blocked'` / `category: 'internal'` / `phase: 'run'` / `retryable: false` / `details`。判定只经 `evaluateUsageLimits` / `evaluateTermination`，不得另写第二套阈值；`max_iterations` / `max_runtime` 也是 `LimitBlock` key，不得退回普通 `Error`。
- **provider 429 读 Retry-After、402 不重试**（0.14.3，ADR-084）：`ProviderHttpError` 必须保留 `status` / `body` / `retryAfterMs` 与 `<Provider> API error: <status> - <body>` 文本，不得改成裸状态码；429 优先按错误字段或 `retry-after` 头退避（受 `maxDelayMs` 截断、不加抖动），402（额度耗尽）与其它 4xx 不重试；5xx / 网络错误保持指数退避。openai 与 anthropic 两份 `retry.ts` 必须保持一致。
- **压缩保留同时受 token 与 maxMessages 约束、tool 配对不得切断**（0.14.4，ADR-085）：保留预算固定 `maxTokens × 0.3`，从最新非 system 消息向前累计 `estimateMessageTokens`，至少保留 2 条；保留条数同时受 `maxKept = max(2, messageCap - systemCount - 1)` 约束，token 或条数任一超限都触发摘要，都未超时不压缩。保留区第一条是 `tool` 时必须回退到持有对应 `tool_call_id` 的 `assistant(tool_calls)`；配对完整性优先于条数上限，回退后可能略超 `maxMessages`，不得为凑条数制造孤立 `tool`。
- **摘要 transcript 必须含 tool_calls、输入分块、失败不得丢整段摘要**（0.14.4，ADR-085）：摘要输入必须渲染 `assistant` 的 `[tool_call:<name>] <arguments>` 与 `tool` 的 `[tool:<id>] <content>`，单条 12,000 字符截断，`reasoning_content` 不进入摘要；按 `min(48_000, max(2_000, floor(context.maxTokens / 8)))` 分块，单块一次摘要、多块 N 次 partial（≤1024）+ 1 次 reduce（≤2048）。单块失败写 `[partial summary unavailable: chunk N]` 继续，reduce 失败按序拼接并截断，全部失败返回空串由 core 回退占位摘要——不得因一块失败丢弃已成功的 partial 或整段摘要。
- **透明化事件形状冻结**（0.15，ADR-086）：`context.compacted` 只能带 `{run_id, session_id, removed, remaining, reason}`，`reason` 只取 `auto|overflow|manual`，`removed === 0` 不发；`agent.limit.warning` 固定 `threshold: 0.8`、每 run 每 key 一次，达到硬上限后交给 `limit.blocked`、不得重复预警；`agent.queue.entered/left` 的 `position` 从 1 起，只有真正在队列中停留过的任务才有进出事件。事件名保持开放字符串，不新增常量 / 枚举。
- **快照只填已知字段**（0.15，ADR-086）：`AgentSnapshot` / `RunSnapshot` / `SchedulerSnapshot` 的新字段都 additive；Host 读不到时留 `undefined`，不得伪造 `childrenCount` / `waitReason` / `contextUsed`。`WaitReason` 只能取 `capacity|per_agent_serial|paused|dependency|quota`，core 只产出前两个。
- **Self Card 每次 run 只注入一次**（0.15，ADR-086）：`selfCard` 在 run 开始（含 resume）生成，追加到 systemPrompt，按 `estimateTokens` 截断到 400；不写持久化 session；`before_llm` hook 改写后 Card 不得重复出现。MCP 工具在连接前不可知，不写入 Card；child 的 Card 继承父级限额，不放大。
- **多实例锁分层**（0.15，ADR-086）：file / memory 后端用 shared tenant 锁（`.members/<pid>-<nonce>.json`），sqlite / `--exclusive` 用 exclusive `.lock`；发布后必须复查另一侧。session / run 写锁固定 `.locks/sessions|runs/<sha16>.lock`（`0600`），冲突主码 `conflict` + `session_locked` / `run_locked`；不得新增 RPC 主码或用锁文件之外的机制做单写者。interactions 按实例落 `<dataDir>` 或 `<dataDir>/instances/<instance>`。
- **canonical 方法表为 57**（0.15，ADR-086；0.18 移除 workflow；0.19 S3 / S5 / S4 扩至 48；0.24 S10.3 +3；0.25 +3；0.26 +3）：`agents.tree` / `tasks.list` / `tasks.get` / `config.set` 已冻结；0.18 移除 `workflow.*` 5 个方法（ADR-090），0.19 S3 增加 `teams.list|get|post|members`、S5 增加 `auth.exchange|revoke|tokens`、S4 增加 `teams.budget`（write，不进 control scope），0.24 S10.3 增加 `teams.create|update|archive`（write；create 仅 human/admin），0.25 增加 `agents.create|update|close`（write；批量，team-scoped token 不能 create），0.26 增加 `agents.send|dispatch|rotate`（write；批量，team-scoped token 只能操作同 team 成员），共 57（56 个 domain 方法 + `events.subscribe`）；`tasks.*` 只读派生、不持久化，`config.set` 只写白名单键且仅 default tenant。`health.get` 的 `runtime`、`runs.*` 的 envelope 与 `started_at`、`events.list` 的 redactor + 8 KiB 裁剪都属 additive，不得改已有字段语义。
- **canonical agent 生命周期是批量契约**：`agents.create` / `agents.update` / `agents.close`（permission `write`）统一 `{ agents: [...] }` → `{ results: [...] }`，与输入同序、单条失败隔离（单条 = 单元素数组）。`agents.create` 拒绝 team-scoped control token，`team_id` 只绑定已存在 Team（不隐式创建）；`agents.update` / `agents.close` 的 team-scoped token 只能操作同 team 成员（否则逐条 `not_found`）。改名立即生效；`model` / `systemPrompt` 只写入记录、下一具 Body 才使用（`applies_to: 'next_body'`）；`agent.updated` 只带字段名。
- **唯一 AgentService**（0.17，ADR-088；0.19 增补 dispatch / rotate / S4）：成员能力只由 `packages/agent` 实现（`new` / `send` / `dispatch` / `rotate` / `close` / `list` + registry / 生命周期 / 队列 / 可见性 / 权限 bridge / snapshot；另有 `notePermissionState` / `noteMemberEvent` / `isMemberBody` 等 Body 感知入口）。权限 bridge 的唯一活路径是 `InProcessMemberRuntime.attachBridge`；`AgentService.requestPermission` / `permissionBridge` / `PermissionBridge` 已删除，不得恢复第二套桥。Team 能力在 `packages/agent` 的 `TeamService`（roster 派生 / 只追加日志 / `@` 定向 / `reinstate` 编排）；入口只解析输入、调用服务、渲染事件，不得复制 registry / roster 或另写生命周期与 Team 日志；`packages/core` 不出现 member / owner / visibility / team 概念。不得在插件里重建第二套成员能力。
- **唯一 `agent` schema**（0.17，ADR-088；0.19 S2 增补 rotate）：模型工具面只注册一个内置 `agent`，owner 动作固定 `new` / `send` / `close` / `list` / `rotate` / `post`；成员侧 schema 只暴露 `rotate` / `post` / `send` / `list`（`rotate` 只能换自己的当前 Body，`new` / `close` 只给 owner）。`new` / `close` 接受 `members`、`send` 接受 `messages` 批处理，条目并行、按输入顺序返回逐条结果，单条失败不中止其它条目。工具调用者的 owner / parent 固定为 owner，模型不能伪造。不得新增 `wait` / `inbox` / `status` / `cancel` 模型工具——等待的语义是结束这一轮、回复作为新 turn 到达。`team_*` / `delegate_task` 已删除，不得恢复。
- **session 即成员**（0.17，ADR-088；0.19 增补持久化字段与 rotate）：`new` 创建的成员**初始**与 session 1:1（`session_id === id`）；rotate 后 `MemberStatus.session_id` 报告当前 Body 的 session，旧 Body 记入 `body_history`。`to` / `member` 可用成员 id 或**当前 Body** 的 session 寻址；退役 Body 的 session 不再作为投递目标（第一具 Body 的 session 与 id 相同，仍可经 id 寻址）。注册表记录 `owner` / `visibility` / `state` / `model` / `system_prompt` / `membership` / `current_body` / `body_history` / `forked_from` / `current_tool` / `last_seen` / `usage`；`presence` / `rotation` 只在内存。`private` 仅 owner 可见，跨 tenant 不可寻址；未注册 session 不是成员。名字只由 `present` 成员占用，`left` 后可复用（0.19，ADR-091）。
- **成员状态机与事件**（0.17，ADR-088；0.19 按 ADR-091 修订）：engine 状态取 `created|idle|running|waiting_permission|completed|failed|cancelled|closed`；`stale` 只作旧数据只读兼容，**不得再写入**（仅允许 `stale → closed`）。`membership`（`present|left`）与 `presence`（`live|gone`）是独立层：重启后非 `left` 一律 `state='idle' + presence='gone'`，不得按 terminal 推断、不得写 `stale`。`close` 后到达的 run 终态不得覆盖 `closed`。事件名保持开放字符串（`agent.spawned` / `agent.resumed` / `agent.message.queued` / `agent.turn.*` / `agent.permission.*` / `agent.closed` / `agent.rotating` / `agent.rotated` / `agent.rotate.failed` / `agent.retired` / `agent.reply.stale`；`agent.stale` 仅作兼容，payload 为 `{state:'idle', presence:'gone'}`），事件 `agent_id` 用成员 id，不新增常量 / 枚举。旧 Body 的迟到轮发带 `stale: true` 的 `agent.turn.*`，不写 Agent state / usage，也不投递父队列。
- **owner 外部队列**（0.17，ADR-088）：REPL 主 agent 经 `attachOwner` 注册为 external owner；其队列只由父 turn 的 `BeforeLlm` 调 `takeMessages(ownerId)` 排空，`pump` 永不执行 owner 队列，成员 runtime 也不得消费。注入消息固定 `role:'user'` / `name:'agent:<id>'` / 原 `timestamp`。owner 端点是 loopback + Bearer token，记录 `<dataDir>/agent-owner.json` `0600`；端点只是传输，用合成 owner principal 分发 canonical `agents.*` / `teams.*` 方法表（不建第二套 action 列表），CLI 与进程内工具调用同一 AgentService。
- **权限 bridge**（0.17，ADR-088；0.19 S2 Body fencing / S4 only-human）：成员 `permissionMode` 为 `bridge|allow|deny`，缺省交互 `bridge`、headless `allow`；**唯一活路径**是 `InProcessMemberRuntime.attachBridge`（`AgentService.requestPermission` / `permissionBridge` / `PermissionBridge` 已删除）。bridge 请求必须补 `request_id` / `agent_id` / `session_id` / `parent_session_id` / `team_id` / `delegate_path` 并弹到父窗口，应答沿用 `permission.respond` / `ask.respond`；父流与成员流同源时不得重复转发。`deny` 只复制 `agent.readOnlyTools`（默认 `['read']`）；无 `parentEvents` 时 bridge 退化为 deny，不得死等。有非空 `team_id` 的成员强制 bridge（忽略全局 `allow`），`deny` 保持只读工具不放宽。`notePermissionState` 只接受当前运行 Body（`queue.activeBodySession === session_id`）的回调；`attachBridge` 的每成员 pending 按 Body session fencing，旧 Body 的迟到请求不得把 Agent 拉回 `waiting_permission`。
- **权限只有人或策略能答**（0.19 S4）：应答入口只有 TUI / Web / RPC（`answered_by: 'human'`）与 team 显式 `deny-after` / headless root auto-allow（`answered_by: 'policy'`）；没有 agent 审批人，`answered_by` 不接受 `agent`。默认 `hold`、无定时器、无全局 TTL；`deny-after` 只由 team policy `permission.unattended: 'deny-after'` + 必填 `deny_after_seconds` 开启；不提供 `allow-after`，validator 显式拒绝。`requestPermission` 不得回归。
- **conversation 预算**（0.19 S4）：预算挂在 `teams[].policy.budget`，**不复用** `limits.*`；维度只有 hops / turns / tokens / wall_clock（`max_cost` 未实现，validator 拒绝），环检测默认开启（`max_repeats: 2` / `cooldown_seconds: 60`）。状态唯一写在 `<dataDir>/conversations/<tenant>.json`（0600 原子写、有界、损坏 fail-closed），重启不清零；发送侧入队前与接收侧 turn 开始各查一次，被接收侧挡下的消息留在队列。override 只能由人经 `teams.budget` / owner 端点 / CLI 抬高或清除，且 `teams.budget` 不进 `CONTROL_SCOPE_METHODS`；agent 工具没有预算动作。`conversation_id` 必须贯穿 dispatch / send / Team post / 本机 A2A / reply / rotate，并写进 Team log。
- **snapshot 内存队列**（0.17，ADR-088；0.19 快照 v2 见 ADR-091，body_history 见 ADR-092）：registry 在内存，状态变化经节流合并原子写 `<dataDir>/agents/<tenant>.json`（`0600`，**写 `version: 2`**），只存成员状态 / 配置 / 当前 Body 指针 / 有界 `body_history`（≤20 条，只记已退役 Body）；消息队列只在内存。读取兼容 v1，首次写 v2 前必须把 v1 备份为 `<tenant>.json.v1.bak`，备份失败则放弃写。重启后非 `left` 成员为 `idle + presence='gone'`（不写 `stale`），未处理消息丢失；不得把队列写进快照或声称 durable。
- **节点身份持久化**（0.19，ADR-091）：`node_id` 唯一来源是 `resolveNodeId()`：`config.host.nodeId` > `<dataDir>/node.json` > 首次生成并 0600 原子写；不得由 hostname / IP 派生，不得在 bootstrap 或其它入口另生成。配置优先时只比较并告警、不改写文件；文件损坏抛 `node_identity_corrupt`，不得静默换身份。`incarnation` 保持每进程独立，只用于事件去重，不与 `node_id` 混用。`node.json` 的 `name` 只是展示名：首次创建用 sanitized `os.hostname()`，`host.node_name` 优先但不改写文件；`name` 缺失或非法只回退 hostname，不触发 `node_identity_corrupt`。`node_id` 仍是唯一寻址 / 去重键，UI 不展示 UUID。
- **dispatch 是统一投递入口**（0.19，ADR-091）：需要“确保成员能干活”的调用方一律走 `AgentService.dispatch`：live / rotating 入队，gone 先 single-flight resume（`Map<id, Promise>`）再入队，left / resume 失败 / 不可见返回 `rejected`。不得在每个入口重写状态检查或并发 spawn。strict `send` 保留原语义与错误码（`member_closed` / `member_stale`），不 resume；0.19 S3 起 `agent` 工具的 `send` 走 dispatch（成员走 `TeamService.send`），strict `service.send` 只保留给 owner 端点 / CLI。resume 与入队之间必须复查 `membership` / `presence`。
- **fork 只在 resume 失败后发生**（ADR-091 / ADR-094）：`dispatch` 在 `gone + resume` 失败后才按 `teams[].policy.allowFork`（缺省 false）或 owner / CLI 显式 `allow_fork` 创建新 Agent；private / 无 Team / 无 handoff / `already_forked` 一律 `resume_failed` 且零写入。fork 不带历史、prompt 只带绝对 handoff 路径；不新增 `agent` 工具动作或 canonical RPC。
- **rotate 与 epoch fencing**（0.19，ADR-092）：`AgentService.rotate` 只换**活**身体（`presence !== 'live'` → `body_not_live`，gone 走 dispatch resume），成员工具路径只能 rotate 自己（`from_session_id === current_body.session_id`，否则 `not_current_body`）。顺序固定：spawn 新 Body（新 `session_id`、`epoch + 1`）→ 旧指针进 `body_history`（≤20）→ `setCurrentBody` → `flushSnapshot()`；成功后启动嘱托才入队并恢复 `stable`。失败保持旧身体：指针 / `body_history` 回滚、dispose 新 engine、`rotation` 回 `stable`、不插入启动嘱托、返回 `rotate_failed`；不 fork、不自动重试。`entries` 以 `session_id` 为键、`bySession` 跟随当前 Body；旧轮按 epoch fencing 丢弃 state / usage / 自动回复，只发 `stale: true` 的配对 `agent.turn.*` 与 `agent.reply.stale`。启动嘱托正文不得进入事件 payload（`handoff` 只带路径）。
- **Team 日志不是队列**（0.19 S3，ADR-091 Addendum）：无 `@` 的 post / reply / system **绝不产生 run**；`@` 必须先写日志再 dispatch，日志写失败不得 dispatch；`mentions` 只收结构化 agent id，不从正文解析。`TeamService` 是唯一 Team 日志写入点；`packages/serve` 通过结构化 `TeamControlLike` 注入，不依赖 `@vessel-agent/agent`。`teams.members remove` 复用 `close`（归档不删历史），`add` 只走 `AgentService.reinstate`；`closed → idle` 不得走普通 `setState`。
- **Team 可见性 fail closed**（0.19 S3）：Team 日志对 team 可见，private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；`onAgentEvent` 只接受 `visibility === 'team' | 'tenant'`。private mention 在 owner 路径返回 `team_private_member`、canonical 路径返回 `unknown_member`，两种都不入日志。`reinstate` 是 roster add 专用的人力 `left → present` 路径（与 `attachOwner` 并列），不 spawn、不新建 session。
- **Team CRUD 边界**：`teams.create` 仅 human / admin；team-scoped token 只能 update / archive 自己的 team；`archive` 拒绝 present 成员（`team_not_empty`），归档后只读并保留日志 / session / agent 历史；hard delete 不是 archive，不提供隐式删除。
- **team-scoped token 在节点侧收窄**（0.19 S5，ADR-093）：`control` token 只能访问 token 自己的 `team_id`，不匹配一律 `not_found`（不泄漏存在性）；`teams.list` / `teams.get.team` 的 scoped 响应剔除 `workspace` / `handoff_path` / `policy`。scope 白名单在 `rpc.ts` 单点执行，不新增 role 字符串；`auth.exchange` 只签 `control`，`exchange` / `control` / `view` 不能互签。
- **federation 按成员寻址，不做广播**（0.21，ADR-094 Addendum）：wire 的 `principal` 是名字不是 agent id；入站最多 1 个 run；`accept:'members'` 在配置 / team.json / 运行时都必须显式报错，未知值 fail-safe 为 `log`；principal 解析必须用完整 roster，不能受 `teams.get` 展示窗口影响；`team-info` 必须 opt-in 且不返回 agent id / workspace / policy / private；peer token 只认证节点，不构成用户级身份证明；peer token 必须唯一，重复 token 的 peer 全部丢弃、`matchPeer` 歧义一律 401。
- **远程 attention 不跨节点转发权限**（0.22，DECISION-038）：permission / ask 必须在运行 agent 的节点本地应答；`vessel attention` 用 gateway / team token 直连，**peer token 不能用于 attention**；`interactions.list` 的 cursor 用 `(order, created_at, request_id)`，`agent_id` 过滤必须在服务端、`total` 之前；`answered_via: cli` 只是审计提示，不是身份认证；`answered_by` 仍只 `human | policy`；roster 排序只由 `TeamService` 产生，serve / Web 不得重排；hub 不存 pending、不代答。
- **多节点 attention 只用配置节点 token**：`attention.nodes[].tokenEnv` 是每节点人类 token 的唯一来源；不接受内联 token，不回退 `connect` / `serve` / `VESSEL_CONNECT_TOKEN`。`--all-nodes` 只列表、逐节点聚合，单节点失败不中止其它节点；`--to` 多匹配必须显式 `--node`；配置了 `nodeId` 的节点每次用 `health.get` 校验。token 逐节点只存 `sessionStorage`。
- **默认能力开关**：`agent.enabled` / `durable.enabled` / `evals.enabled` / `federation.enabled` / `hub.autoStart` 缺省 true，必须能用显式 `false` 关闭；`feishu.enabled` / `serve.allowRemote` 因外部凭据 / 网络暴露保持 false。
- **本地 hub 单实例**：gateway 在 `hub.dataDir`（缺省 `<dataDir>/hub`）启动同进程 hub，只监听 `127.0.0.1`、端口缺省 0；`hub.lock` 保证单实例，本机 node 自动登记但不自动 join / 配对；`hub.direction: node` 跳过本地 hub。
- **hub 不代理正文**（0.19 S5，ADR-093）：hub 只持有目录与指针（`{node_id, team_id, request_id?, reason, ts}`），不得转发或持久化消息 / 事件 / 工具结果 / 权限正文；`TeamService.subscribe` 只带 `team_id` / `kind` / `message_id`，供 hub 投影指针，绝不带正文。S5 实现 hub → node 拨号、S5.1 实现 node → hub 出站；跨节点 A2A（S7）仍未实现，不得写进当前态。node → hub 出站（`hub.direction: node`）一个进程 / data dir 只加入一个 hub；node token 只进 SecretStore，30 天过期需重新 join，没有自动 refresh。
- **BeforeLlm 注入只增不改**（0.16，ADR-087）：`HookContext.messages` 是 additive 注入位；runtime 只写入一次，按 `name` / `timestamp` 稳定键或对象引用去重，每个 run 重置；未写时不改变请求形状。`agent.followReplies` 目前只作为配置 / 事件字段，不得实现成阻塞等待或隐藏的 `wait`。
- **测试隔离**（0.8.2）：不要用 `mock.module`（Bun 进程级污染，会串到其他测试文件）；改用依赖注入、纯函数与工厂。成员接线测试必须可独立运行。
- 不给 core 加默认厂商 API Key / Base URL / 价格。Key 永远用户自备。
- 引用文件路径前先确认它存在。本仓库已删除 `docs/specs/`、`docs/role/`、`docs/api/`、`docs/guides/`、`processes/`、`legacy/`——指向它们的链接都是错的。过程产物（handoff / plan / report / 临时脚本）只放个人侧，不进本仓库。
- 文档只写已实现；规划项明确标注。不吹未实现的能力。

## 文件与目录

共享侧与个人侧的分工、目录结构、角色独占路径、分支与发布规则，见 [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)。简版：
- 共享侧（本仓库）只放源码、测试、长期文档、CI；handoff / 计划 / 报告 / worktree 一律放个人侧，不提交。
- 每个角色只写自己的独占路径；跨路径改动先与 1 协商。
- 版本线：`main` → `release/<version>`（集成分支）→ `<version>-<role>`（角色分支 / worktree）；当前版本见 `docs/versions/CURRENT.md`。发布由 tag `v*` 触发，不由分支名触发。1.0 前不发布，只做干跑：不 tag、不 publish、不合并 `main`。

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
bun run src/cli.ts update                       # 按安装形态自更新（npm / bun 全局；默认确认）
bun run src/cli.ts gateway start --daemon       # 后台启动 gateway（PID + 日志）
bun run src/cli.ts gateway status --json        # 运行态（纯 JSON）
bun run src/cli.ts gateway status --rpc         # 经 RPC 查询 health + 队列计数
bun run src/cli.ts doctor --deep                # 额外只读查询本地 gateway
bun run src/cli.ts logs tail --lines 100        # 本地 gateway 日志尾部
bun run src/cli.ts --data-dir /srv/vessel ...   # 覆盖 data_dir（CLI > env > config）
bun run src/cli.ts --exclusive ...              # 强制 tenant 单写者锁
bun run src/cli.ts gateway reload --scope config,plugins  # 热重载（其余字段需重启）
bun run src/cli.ts gateway stop                 # 停止（默认等待 10s）
bun run src/cli.ts team list --json             # Team 列表（经 owner 端点）
bun run src/cli.ts team post <team_id> "status" # 无 @ 只写日志；@ 才 dispatch
bun run src/cli.ts hub start                    # 前台启动 hub 目录服务
bun run src/cli.ts hub pair                     # 节点侧生成一次性配对码
bun run src/cli.ts hub node add <url> --code <CODE>  # hub 侧纳入节点
bun run src/cli.ts config path                  # YAML 路径 + data_dir
bun run src/cli.ts config init                  # 生成用户配置模板（不含真实密钥）
bun run src/cli.ts config show --sources        # 脱敏配置与来源
bun run src/cli.ts tenant list                  # tenant 元数据
bun run src/cli.ts migrate --from sqlite --to file-v2   # 默认 dry-run
bun run src/cli.ts trace prune --dry-run        # 查看将清理的 trace
bun run demo                                    # 无 Key 跑核心示例
bun run src/cli.ts eval smoke                   # eval suite（默认离线）
bun run src/cli.ts --feishu                     # 前台运行飞书渠道（需 enabled + 凭据）
bun run scripts/version.ts --check              # 版本一致性 + CHANGELOG 校验
bun run scripts/release-dry-run.ts              # 发布干跑（不 tag / 不 publish）
```

根 `devDependencies` 的 `react` / `react-dom` 只为让根 `bun test` 在未安装 `apps/web` 依赖时也能跑 Web 测试；Web 构建仍用 `apps/web` 自己的 `npm ci`，不要把 `apps/web` 加进根 workspaces。

改完代码，这三个必须过：`bun test` / `bun run typecheck` / `bunx @biomejs/biome ci .`。
收口还要求 `check-deps` / `smoke-subpaths` / `check-docs` / `version --check` / `release-dry-run`。
CI 与发布流程见 [docs/operations/CI-CD.md](docs/operations/CI-CD.md)、[docs/operations/RELEASE.md](docs/operations/RELEASE.md)。发布由 tag `v*` 触发，只有 1 打 tag；N 不发布、不合并。

## 分层与能力准入

新增能力前先分类：**进 core / 做成插件 / 放应用层**。

进 core 必须全部满足：大多数 harness 都需要、领域无关、可接口化、不绑 Provider 或厂商 SDK、能被多个应用复用。

**拿不准就选插件，不选 core。** core 只放领域无关的运行时；其余一律做成 `plugins/<category>/<name>/` 下的插件（放文件夹即注册，无需改代码、无需构建步骤——但插件目录在**进程启动时扫描一次**，新增插件要重启进程才生效）。应用层外壳（TUI、配置向导、gateway、web）不往 core 反推需求。

**Module ≠ Plugin**：Module 是编译期/构造期边界（provider / context / session / policy / transport / observability，一个 port 一个实现）；Plugin 仍是唯一运行期扩展机制。禁止 `ModuleHost` / `ModuleRegistry` 或第二套扩展机制。依赖方向由 `scripts/check-deps.ts` 自动检查。Host / Scheduler / Transport 只提供调度与边界，单 agent 的 tool-calling loop 仍由 `AgentRuntime` 实现；不要在 Host 再写一套 loop。

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

- 别再引入共享事件流 / tenant→shared 桥 / 单流 `GatewayOptions.events`；事件面只经 `TenantEventHub`（ADR-089）。
- 别把插件对象塞进 runtime 构造函数（走 `plugins` 或 `pluginHost` 注入）。
- 别在 core 里引用 `tui` / `config` / `plugins`（依赖方向是单向的）。
- 别为了加能力去改 loop 或扩接口——先证明 Tool / Hook / Guardrail / 事件都做不到。
- 别给模型再加一个能干的、能与 bash 等价的事的工具。
- 别给模型加 `wait` / `inbox` / `status` / `cancel`；也别把成员回复做成需要轮询的收件箱。等待就是结束这一轮，回复作为新 turn 到达。
- 别写 harness 层面的 skills 扫描 / 解析 / 注入通道——skills 就是文件，经消息进来。
- 别把 MCP / evals / feishu 塞进 core（它们都是插件）；workflow 已移除，不得恢复；durable 只做 core 的 `RunStore` port；多租户已进 core（`tenant` 解析/隔离原语），跨机器远程 / 跨节点 transport 已在装配层实现（core 只加可选字段）；team / delegate 模型工具与插件已删除；legacy `/v1/team/*` / `RemoteTransport` / `NodeRegistry` / `LoopbackTransport` 不得恢复。
- `transport.kind` 只剩 `in-process`；`loopback` / `remote` 与 `transport.nodes[]` 是显式 validation error，不得恢复；`health.get` 不再有 `team` 字段。
- 0.5 默认 `session.backend: file`；不要删除 sqlite 后端，也不要在检测到 legacy 数据时自动迁移——只提示 `vessel migrate`。
- 别把 tenant overlay 写成能覆盖 CLI/env；优先级固定 `CLI > env > tenant overlay > project > user > default`。
- 别绕开 RPC 方法表直接调内部实现；新增 canonical 方法必须发 addendum。
- 别在 trace / 事件 / 日志 / `config show` 输出解析后的密钥值；0.5 不脱敏 checkpoint / eval 报告 / 飞书回复，文档不得写成“已脱敏”。
- 别让多个进程同时写同一 tenant；写前必须拿 `.lock`，冲突返回 `tenant_locked`。
- 别在日志 / 事件 / 报告里输出飞书的 `app_secret` 或完整 `app_id`；只允许前 4 位 + `***`。
- 别默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环不得匿名。`serve.allowed_origins` 只接受显式 http(s) origin，禁止 `*` / path / query。
- 别给 MCP 工具设默认 `allow`；除非在 `auto_approve_tools` 里按原始工具名精确列出。
- 别让 Host 与成员 runtime 同时写同一个 run 的 checkpoint（唯一写者是 `AgentRuntime`，Host store 优先）。
- 别在同一 runtime 上并发跑多个 run（守卫会拒绝）；需要并行就用多个 runtime（Host 的“一 agent 一 runtime”）。
- 别靠 hook / guardrail 抛异常来终止 run：hook 异常被隔离，guardrail 异常按 fail-closed 转成 `guardrail_error`。要阻断就返回 `allowed: false`，要停止就 abort。
- 别把内置凭据 denylist 改成 `ask` 或做成可移除；也别把 `allowed_roots` 当沙箱——`bash` 只校验 `cwd`，命令文本检查是 best-effort 字符串匹配。`read` / `edit` 都走 `evaluatePath`，不要给 `edit` 另开一条绕过边界的写路径。
- 别在 headless 分支里提前 `process.exit` 跳过 gateway / tenant / transport / shutdown 清理。
- 别把“文件存在但损坏”当成“文件不存在”：覆盖或删除损坏的 session / tenant run 会关闭唯一恢复窗口。
- 别在 `serve-config` / `bootstrapConnect` / 其他入口自行合并 argv 或 `process.env`；新增 CLI flag 必须加入 `buildCliConfigOverrides()`。
- 别在文档里描述一个不存在的架构。
- 别绕过 PR 直接 push main。
