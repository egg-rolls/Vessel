# AGENTS.md

> Vessel 仓库的 AI 行为约定。与代码冲突时以代码为准，并顺手改掉本文档。

## 上下文纪律

- 先读本文件与任务相关的 `docs/ARCHITECTURE.md` 小节；契约查 `docs/adr/` 的具体编号，不要整读全部 ADR。
- 历史决策查 ADR，当前版本查 `docs/versions/CURRENT.md`；实现事实以代码为准，文档冲突时顺手改文档。
- 读代码先 grep 定位再读片段，不整读超过 300 行的文件；一次只加载当前任务需要的文档。
- 过程产物（计划、报告、临时脚本）不进本仓库；文档只写已实现的能力。

## 项目是什么

- **可嵌入的多 agent 平台 runtime**：极简核心（稳定接口 + 1 个通用 tool-calling loop + 扩展插槽）、Provider 无关；TUI / CLI / Web / Gateway 是参考 harness 外壳。
- TypeScript + Bun；bun workspaces monorepo：`packages/{core,agent,config,permission,tui,serve}` + `plugins/` + `apps/web`。`@vessel-agent/core` 是零 UI 依赖的库，`@vessel-agent/agent` 是成员能力层，TUI / serve / web 是应用层外壳。
- **能力工具只有 `bash` / `read` / `edit` 三个**，别急着加第四个（不提供 `grep` / 文件操作 / meta-tools）。内置 `agent` 与 `ask_user` 是接缝工具，MCP 工具经插件注册；工具口径与动作表见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §11。
- 状态：alpha，pre-MVP。未实现的能力一律标注，不写进正文。

## 代码风格与硬规矩

### 架构边界

- 不引入 LangChain / LangGraph（[ADR-009](docs/adr/ADR-009-no-langchain.md)）。不加重依赖：core 的 `dependencies` 保持为空，重依赖只能进插件包。
- **core 保持小**：core 里不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）。
- 不新增第二套扩展机制——一切走 `Plugin` + `PluginHost`（[ADR-004](docs/adr/ADR-004-plugin-pluginhost-extension.md)）；插件对象走 `plugins` / `pluginHost` 注入，不塞进 runtime 构造函数。
- Module 是编译期/构造期边界（provider / context / session / policy / transport / observability），不是第二套运行期机制；禁止 `ModuleHost` / `ModuleRegistry`。依赖方向单向 `core ← 其它`，由 `scripts/check-deps.ts` 检查。
- 事件名一律是开放字符串字面量 `<domain>.<action>.<event>`，不新增事件名常量 / 枚举（[ADR-030](docs/adr/ADR-030-event-names-as-open-strings.md)）。
- 全异步，不写 sync-in-async；不留半成品 stub（`throw new NotImplementedError()` / 空实现进 core）。
- 不给 core 默认厂商 API Key / Base URL / 价格；Key 永远用户自备（[ADR-050](docs/adr/ADR-050-yaml-first-config-and-secrets.md)）。
- evals / feishu / MCP 只做插件，不进 core；workflow 已移除，不得恢复；微信不做；durable 只做 core 的 `RunStore` port；多租户原语在 core，跨节点 transport 在装配层；`team_*` / `delegate_task` 已删除，不得恢复（[ADR-043](docs/adr/ADR-043-evals-harness-offline.md)、[ADR-044](docs/adr/ADR-044-feishu-channel-plugin.md)、[ADR-090](docs/adr/ADR-090-remove-workflow-plugin.md)）。mock 场景只在 `src/mock/`，`VESSEL_MOCK_SCENARIO` 只在 CLI 入口读一次（[ADR-063](docs/adr/ADR-063-mock-scenarios-and-demo.md)）。
- **legacy 传输面不得恢复**：`transport.kind` 只剩 `in-process`；`loopback` / `remote` / `transport.nodes[]` 是显式 validation error；`health.get` 不再有 `team` 字段；legacy `/v1/team/*` / `RemoteTransport` / `NodeRegistry` / `LoopbackTransport` 已删除。

### 运行时与工具

- **单 run 守卫**：同一个 `AgentRuntime` 同时只允许一个 active run。`run()` / `resume()` 必须经 `beginExecution` 占位、`finalizeRun` 收尾，不要绕开 `activeRun`，也不要另写终态持久化 / 事件发布路径；第二个 run 抛 `run_already_running`（[ADR-054](docs/adr/ADR-054-run-execution-and-failure-isolation.md)）。
- **插件异常必须隔离**：Hook 抛错发 `hook.failed` / `hook.error` 后继续；`OnError` best-effort；Guardrail `check()` 抛错按 fail-closed（`allowed:false` + `guardrail_error`）。不得让插件异常原始冒泡，也不得靠抛异常终止 run——要阻断返回 `allowed:false`，要停止就 abort（ADR-054）。
- **工具执行必须走统一 pipeline**：任何入口都不得直调 `ToolDefinition.handler`；顺序固定 getTool → ToolCall guardrail → BeforeTool → permission（最终工具与参数）→ handler → ToolResult guardrail → AfterTool。权限必须在 guardrail/hook 改写之后判定；`tool.call.*` 由调用方发布（[ADR-058](docs/adr/ADR-058-unified-tool-execution-pipeline.md)）。
- **插件资源必须可回收**：`install()` 期间创建的资源（连接、定时器、子进程、句柄、订阅）必须实现 `dispose()` 释放；安装阶段 fail-fast + rollback；`dispose()` 必须幂等（[ADR-065](docs/adr/ADR-065-plugin-lifecycle-v2.md)）。
- **Host 契约**：per-run session 只由 `AgentHandle.run` 消费 `RunOptions.sessionId`；取消经 `AbortSignal.reason` 透传 `RunInterruptReason`；`resume` 必须经 Scheduler（用 `ScheduledTask.runId` 保持 run id）；`snapshot()` 只返回可 JSON 序列化的数据，合成 `agent.run.*` 必须带 `mirror_of_run_id`（[ADR-081](docs/adr/ADR-081-host-parity-and-serializable-snapshot.md)）。唯一 checkpoint 写者是 `AgentRuntime`，Host 与成员 runtime 不得同时写同一个 run。
- **压缩摘要**必须是 `role: 'system'` + `compaction_summary: true`，插在基底 system 之后、其它消息之前，同时最多一条；应用新压缩时移除旧摘要，不得写回 `assistant`（thinking 模式要求 assistant 历史带 `reasoning_content`）（[ADR-083](docs/adr/ADR-083-compaction-summary-and-bash-command-denylist.md)）。
- **限额命中**必须在抛错前发布一次 `limit.blocked` 再抛 `LimitExceededError`；判定只经 `evaluateUsageLimits` / `evaluateTermination`，不另写阈值（[ADR-084](docs/adr/ADR-084-limit-visibility-and-provider-errors.md)）。
- **错误 envelope 只增不改**：`run.failed` / `tool.call.failed` 保留原 `error`，新增字段只能附加；不得把 prompt / reasoning / 完整工具结果写进 envelope（[ADR-080](docs/adr/ADR-080-observability-control-plane-and-gateway-instances.md)）。
- 事件去重键必须含 `node` / `incarnation` / `run_id`（缺失写 `-`）；消息键含 `from`，gateway 层再加 `tenant`；代际变化或 seq 回退只清该来源节点，不得退回全局 `clear()`（[ADR-067](docs/adr/ADR-067-cross-node-dedup-keys.md)）。
- 透明化事件形状冻结、快照只填已知字段、Self Card 每 run 只注入一次、BeforeLlm 注入只增不改——见 [ADR-086](docs/adr/ADR-086-transparency-and-multi-instance-safety.md) 与 [ADR-087](docs/adr/ADR-087-unified-agent-tool-phase-a.md)。
- **诊断走 Logger（stderr）**：不得 `console.log` 到 stdout（stdout 只留命令结果 / JSON / UX）；`VESSEL_DEBUG` 只提级别，日志经 redactor；未捕获异常走 `process.error` + 限时 shutdown（[ADR-069](docs/adr/ADR-069-logging-port-and-observability.md)）。
- **关闭必须 await `gateway.stop()`**：顺序固定 stop → 取消订阅 / 关闭 transport → `beforeClose` → `closeAll` → `shutdown`，后两步传 `{ drain: false }`；中断 active run 用 `interrupt('shutdown'|'timeout'|'user')`，不得只 abort signal 丢原因；headless 不得提前 `process.exit` 跳过清理（[ADR-070](docs/adr/ADR-070-shutdown-drain-and-interrupt-reasons.md)）。

### 安全、路径与数据

- **工具路径边界**：`read` / `edit` / `bash cwd` 统一走 basic-tools 的 `evaluatePath`；比较基于 realpath（含最近已存在祖先），不要用未解析字符串前缀。内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）是硬 `deny`；`allowed_roots` 只把越界降级为 `ask`；`deny_paths` 只能追加。`bash` 另在命令文本里匹配同一组 denylist（含自定义 `deny_paths`），但这是 **best-effort 字符串匹配，不是沙箱**——`cd` 后相对路径、变量拼接、引号拆分、通配符、符号链接、`~root`、`%USERPROFILE%` 仍可能绕过（[ADR-055](docs/adr/ADR-055-tool-path-boundaries.md) / [ADR-083](docs/adr/ADR-083-compaction-summary-and-bash-command-denylist.md)）。`agent.cwd` 优先级固定：工具参数 `cwd` > `agent.cwd` > `process.cwd()`；配置不得放宽这些边界。
- **持久化写入**：session / checkpoint 一律走 `atomicWrite`，默认 `durable: true`；不直写最终路径，不吞 `AtomicWriteError`（[ADR-056](docs/adr/ADR-056-persistence-durability-and-corruption.md)）。
- **损坏检测**：文件存在但不可读 / JSON 损坏一律抛 `SessionCorruptError`，不得当“不存在”返回 `null`，不得 unlink（只有 `listRich()` 允许逐项降级）；快照损坏先隔离为 `<path>.corrupt-<timestamp>`；`team_metadata_corrupt` 必须原样透出（ADR-056）。
- **多实例锁**：file / memory 后端用 shared tenant 锁，sqlite / `--exclusive` 用 exclusive `.lock`；session / run 写锁固定 `.locks/sessions|runs/<sha16>.lock`（`0600`）；冲突返回 `tenant_locked`，或 `conflict` + `session_locked` / `run_locked`，发布后必须复查另一侧；不得新增锁机制或另做单写者（[ADR-086](docs/adr/ADR-086-transparency-and-multi-instance-safety.md)）。
- **存储后端**：默认 `session.backend: file`；不要删除 sqlite 后端，也不要在检测到 legacy 数据时自动迁移——只提示 `vessel migrate`。
- **密钥**：不输出 / 不记录解析后的密钥；`app_secret` 永不打印，`app_id` 只允许前 4 位 + `***`；trace / 事件 / 日志 / `config show` 必须经 redactor。
- evals 默认离线；真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控。
- **远程**：不默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环必须 TLS；`serve.allowed_origins` 只接受显式 http(s) origin，禁止 `*` / path / query（[ADR-041](docs/adr/ADR-041-remote-listen-and-tls.md) / [ADR-053](docs/adr/ADR-053-remote-security-baseline.md)）。
- MCP 工具默认不 `allow`；除非在 `auto_approve_tools` 里按原始工具名精确列出（[ADR-039](docs/adr/ADR-039-mcp-client-as-plugin.md)）。
- `node_id` 唯一来源是 `resolveNodeId()`：`config.host.nodeId` > `<dataDir>/node.json` > 首次生成并 `0600` 原子写；不得由 hostname / IP 派生；文件损坏抛 `node_identity_corrupt`，不得静默换身份（[ADR-091](docs/adr/ADR-091-agent-body-and-presence.md)）。
- conversation 预算挂在 `teams[].policy.budget`，不复用 `limits.*`；状态唯一写在 `<dataDir>/conversations/<tenant>.json`（`0600` 原子写、损坏 fail-closed）；override 只能由人经 `teams.budget` / owner 端点 / CLI 抬高或清除（[docs/operations/CONFIG.md](docs/operations/CONFIG.md) §2.12）。

### 权限、事件与团队

- **权限默认无限等待**：不得重新引入 120s / 固定 TTL；只有显式正数 `RuntimePermissionConfig.timeoutMs` 才抛 `PermissionTimeoutError`；abort 抛 `PermissionAbortedError`，必须优先于超时判定（[ADR-077](docs/adr/ADR-077-permission-reasoning-cwd.md) / [ADR-079](docs/adr/ADR-079-permission-lifecycle-persistence.md)）。
- **权限只有人或策略能答**：入口只有 TUI / Web / RPC（`answered_by: 'human'`）与 team `deny-after` / headless auto-allow（`answered_by: 'policy'`）；`deny-after` 只由 team policy 开启；没有 agent 审批人，不提供 `allow-after`。
- **权限 / ask 应答只投 tenant 流**：`respondPermission` / `respondAsk` 只能发布到该 tenant 的运行时事件流；流不存在返回 `run_ended`，不得回退共享流或两边都发；权限记录持久化到 `interactions-<tenant>.json`（`0600` + `atomicWrite`），pending 不 TTL 清扫、有界清理也不淘汰 pending，重复应答幂等 / `conflict` / `orphaned`（ADR-079 Addendum）。
- **tenant 事件流是唯一事件面**：不得重新引入 `sharedEvents`、tenant→shared 桥或单流 `GatewayOptions.events`；gateway 只从 `TenantEventHub` 读取；`hub` 不暴露 `publish`，不代理 / 不持久化消息正文，也不存 pending；本地 hub 只监听 `127.0.0.1`，`hub.lock` 保证单实例，不自动 join / 配对（[ADR-089](docs/adr/ADR-089-tenant-event-hub.md) / [ADR-093](docs/adr/ADR-093-hub-control-plane.md)）。
- **AgentService 唯一**：成员能力只由 `packages/agent` 实现；权限 bridge 唯一活路径是 `InProcessMemberRuntime.attachBridge`，不得恢复第二套桥；`packages/core` 不出现 member / owner / visibility / team 概念（[ADR-088](docs/adr/ADR-088-agent-service-package.md) / ADR-091）。**`agent` 工具唯一**：owner 动作 `new` / `send` / `close` / `list` / `rotate` / `post`，成员侧只暴露 `rotate` / `post` / `send` / `list`，工具调用者的 owner / parent 固定为 owner、模型不能伪造；不得新增 `wait` / `inbox` / `status` / `cancel`，等待语义是结束这一轮、回复作为新 turn 到达。
- **session 即成员**：`new` 创建的成员初始 `session_id === id`；`rotate` 换活 Body，旧 Body 进 `body_history`；成员状态机取 `created|idle|running|waiting_permission|completed|failed|cancelled|closed`，`stale` 只读兼容、不得再写入；重启后非 `left` 成员为 `idle + presence='gone'`（ADR-091 / [ADR-092](docs/adr/ADR-092-agent-rotate-and-epoch-fencing.md)）。
- **dispatch 是统一投递入口**：需要“确保成员能干活”的调用方一律走 `AgentService.dispatch`，不得在每个入口重写状态检查或并发 spawn。fork 只在 `gone + resume` 失败后按 policy / 显式 `allow_fork` 发生；rotate 失败保持旧身体，不自动重试（[ADR-094](docs/adr/ADR-094-federation-team-to-team.md) Addendum / ADR-091）。
- **Team 日志不是队列**：无 `@` 的 post / reply / system 绝不产生 run；`@` 必须先写日志再 dispatch；`TeamService` 是唯一写入点。可见性 fail closed：private 成员的 id / 名字 / 回复不得进入 `from` / `to` / `mentions` / `content`；team-scoped token 只能访问自己的 `team_id`，不匹配一律 `not_found`。`teams.create` 仅 human / admin；`archive` 拒绝 present 成员（`team_not_empty`），不提供隐式 hard delete（ADR-091 / ADR-093）。
- **远程 attention**：permission / ask 必须在运行 agent 的节点本地应答；`vessel attention` 用 gateway / team token 直连，peer token 不能用于 attention；`answered_by` 仍只 `human | policy`；roster 排序只由 `TeamService` 产生（[docs/operations/REMOTE.md](docs/operations/REMOTE.md) 的「人类控制 token 词表」与「Federation 与成员寻址」）。

### 协议、配置与发布

- 新 RPC 方法进 `packages/serve/src/gateway/methods/<domain>.ts` 并导出 `createXxxMethods`，由 `gateway.ts` 展开；不要把方法表回灌 `gateway.ts`。方法清单与冻结项见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §13.7；新增 canonical 方法必须发 addendum，并同时写 `result_schema`（[ADR-059](docs/adr/ADR-059-gateway-method-modules.md) / [ADR-066](docs/adr/ADR-066-rpc-result-schemas.md)）。
- 新一次性 CLI 子命令进 `src/commands/registry.ts` 的 `cliCommands`，不要在 `cli.ts` 加 `if` 链（[ADR-060](docs/adr/ADR-060-cli-command-registry.md)）。
- **配置层序固定** `CLI > env > tenant overlay > project > user > default`，只在 `loadConfig()` 合并；CLI flag 必须经 `buildCliConfigOverrides()`；serve / connect 不得自行读 argv 或 `process.env`；tenant overlay 不得覆盖 CLI / env（[ADR-057](docs/adr/ADR-057-config-single-resolver.md)）。
- **legacy 配置只读**：新版 `provider:` 优先，legacy 并存发 deprecation warning；未注册 provider 且无 `provider.base_url` 必须抛 `ProviderConfigError`；YAML 解析失败 / 重复键必须是 validation error；API Key 一律经 `resolveEffectiveApiKey()`（[ADR-068](docs/adr/ADR-068-config-and-first-run-hardening.md)）。
- **gateway 生命周期只经 `vessel gateway`**：运行态以 `<dataDir>/gateway.pid` 为唯一来源；`stop` 只删本进程持有的 PID；服务注册只在显式 `install-service` / `uninstall-service` 时执行。`gateway.reload` 只热更新 plugins 扫描缓存与 `serve.allowed_origins`，其余必须如实进 `requires_restart`（[ADR-074](docs/adr/ADR-074-gateway-lifecycle-daemon-service.md) / [ADR-075](docs/adr/ADR-075-gateway-reload-scope.md)）。
- **发布纪律**：1.0 前只做干跑，不 tag、不 publish、不合并 `main`、不 force-push；改动只走 PR。根包名 `vessel-agent`（bin 仍是 `vessel`），可发布子包统一 `@vessel-agent/*` 并带 `files: ["src"]` / `license` / `repository` / `engines`；改发布形态后跑 `smoke-install`。发布顺序、包数与 `version.ts` 写模式见 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)（写模式只由 1 执行）（[ADR-071](docs/adr/ADR-071-distribution-vessel-agent-and-install-smoke.md) / [ADR-073](docs/adr/ADR-073-npm-scope-vessel-agent.md)）。

### 产品面与测试

- **TUI**：渲染工具 / 命令文本前用 `sanitizeTerminalText()`，列表 key 用 `lineKey(index)`；用户可见文案一律 `t(key, params?)` 并同时加 zh-CN / en 两份 catalog，中文字面量不得直接作 UI 文案；写用户配置只经注入的 `setLanguage` / `ctx.settings`（`0600` 原子写），`VESSEL_LANG` 仍最高（[ADR-061](docs/adr/ADR-061-tui-display-layer-fixes.md) / [ADR-062](docs/adr/ADR-062-tui-i18n.md) / [ADR-072](docs/adr/ADR-072-ui-settings-and-terminal-polish.md)）。
- **CLI**：`--help` / 一次性命令错误 / 默认空状态 / demo banner 走 `src/i18n/` 双 catalog；人类输出用 `src/ui-style.ts` 的 `ui`，ANSI 只在 TTY、未设 `NO_COLOR`、`TERM !== 'dumb'` 时输出；`--json`、路径与数据行保持纯文本；命令的数据输出保持英文（[ADR-076](docs/adr/ADR-076-cli-style-and-self-update.md)）。
- **Web**：新增文案同时进 `apps/web/src/i18n` 两份 catalog；locale 解析 `localStorage['vessel.ui.language'] > navigator.language`；未收录 key 回退中文但不得当成“已本地化”。Team 写操作只经 canonical `teams.*`，成员 add / remove 走 CLI / owner 端点；token 只存 `sessionStorage`；权限 / `ask_user` 卡片内联在 `RunCard`，不得恢复全局遮罩；不用 `backdrop-filter` 做层级（ADR-072 / [ADR-082](docs/adr/ADR-082-ask-user-registration-and-web-chat.md)）。
- `ask_user` 只在交互 REPL（TTY）或 gateway / serve 注册；`--run` / headless / 管道一律不注册；`ui.askUser: false` 必须能按入口与 tenant 关闭。布局 / 状态栏 / 可见性细节见 ADR-078 / ADR-082；`context.maxTokens` 默认 1M、`provider.maxTokens` 是单次输出上限（[ADR-064](docs/adr/ADR-064-context-budget-default-1m.md)）。
- **测试**：不要用 `mock.module`（Bun 进程级污染，会串到其他测试文件）；改用依赖注入、纯函数与工厂。

## 文件与目录

- 共享侧 / 个人侧分工、目录结构、角色独占路径、分支与发布规则见 [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)。共享侧只放源码、测试、长期文档与 CI。
- 每个角色只写自己的独占路径；跨路径改动先与 1 协商。引用路径前先确认存在（`docs/specs/`、`docs/role/`、`docs/api/`、`docs/guides/`、`processes/`、`legacy/` 已删除）；当前版本见 [docs/versions/CURRENT.md](docs/versions/CURRENT.md)。

## 怎么跑

```bash
bun install                                     # 依赖
bun test                                        # 测试
bun run typecheck                               # tsc --noEmit
bunx @biomejs/biome ci .                        # lint + format 检查
VESSEL_MOCK=1 bun run src/cli.ts                # 模拟模式起 REPL（不需要 API Key）
VESSEL_MOCK=1 bun run src/cli.ts --run "hello"  # headless 冒烟
bun run src/cli.ts --tools                      # 当前配置下的工具（无 Key）
bun run src/cli.ts doctor --deep                # 自检 / 只读查询本地 gateway
bun run src/cli.ts gateway start --daemon       # 后台启动 gateway
bun run src/cli.ts gateway status --json        # 运行态（纯 JSON）
bun run src/cli.ts gateway stop                 # 停止（默认等待 10s）
bun run scripts/version.ts --check              # 版本一致性 + CHANGELOG 校验
```

改完代码，`bun test` / `bun run typecheck` / `bunx @biomejs/biome ci .` 三个必须过；收口还要求 `check-deps` / `smoke-subpaths` / `check-docs` / `version --check` / `release-dry-run`。
完整命令（config / tenant / migrate / trace / hub / team / eval / update）见 [README.md](README.md) 的「快速开始」，运维细节见 [docs/operations/CONFIG.md](docs/operations/CONFIG.md)。
CI 与发布见 [docs/operations/CI-CD.md](docs/operations/CI-CD.md)、[docs/operations/RELEASE.md](docs/operations/RELEASE.md)；发布由 tag `v*` 触发，只有 1 打 tag。

## 分层与能力准入

新增能力前先分类：进 core / 做成插件 / 放应用层。

进 core 必须全部满足：大多数 harness 都需要、领域无关、可接口化、不绑 Provider 或厂商 SDK、能被多个应用复用。**拿不准就选插件，不选 core。** core 只放领域无关的运行时；其余一律做成 `plugins/<category>/<name>/` 下的插件（放文件夹即注册，无需改代码；但插件目录只在进程启动时扫描一次，新增插件要重启进程）。应用层外壳（TUI、配置向导、gateway、web）不往 core 反推需求。

判断“要不要动 core”：能做成 Tool（`registerTool`）/ Hook / Guardrail / 事件（开放字符串），或能由 `bash` + 模型自己组合出来 → 不进 core。单个 agent 的 tool-calling loop 仍由 `AgentRuntime` 实现，不要在 Host 再写一套 loop。

## 插件发现与信任边界

插件是唯一运行期扩展机制。默认发现顺序（同名时先出现者胜出）：`repo`（仓库 `plugins/`）→ `project`（`./.vessel/plugins`）→ `user`（`~/.vessel/plugins`）→ `node_modules`（仓库根与 cwd）。发现与信任细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §8。

- 配置未写 `plugins` 时，默认集加载**全部**可用插件，包括 project / user / node_modules 来源的外部插件；工厂式插件仍按各自开关构造。
- 启动时（`bootstrap` / `--tools` / `doctor`）向 **stderr** 打印一次外部插件告警，列出数量、来源与名称；告警不进入 stdout / JSON。
- `VESSEL_NO_EXTERNAL_PLUGINS=1`（或 `true`）时，默认集只选 `source === 'repo'` 的插件；显式 `plugins:` 列表始终可以加载指定外部插件（**显式即信任**）。
- **残余风险（P0-3 MITIGATED，未关闭）**：外部插件在启动时通过动态 import 执行，拥有完整进程权限，早于任何工具权限判定。不可信仓库务必设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`，且不要把不可信插件写进 `plugins:`。

## 别做什么

- 别为了加能力去改 loop 或扩接口——先证明 Tool / Hook / Guardrail / 事件都做不到。
- 别给模型再加一个能与 `bash` 等价的能力工具；别加 `wait` / `inbox` / `status` / `cancel`，也别把成员回复做成需要轮询的收件箱。
- 别写 harness 层面的 skills 扫描 / 解析 / 注入通道——skills 就是文件，经消息进来。
- 别把插件对象塞进 runtime 构造函数（走 `plugins` / `pluginHost` 注入）。
- 别让多个进程同时写同一 tenant；写前必须拿 `.lock`。
- 别靠 hook / guardrail 抛异常来终止 run；要阻断返回 `allowed: false`，要停止就 abort。
- 别把“文件存在但损坏”当成“文件不存在”。
- 别在 trace / 事件 / 日志 / `config show` 输出解析后的密钥值；别绕过 PR 直接 push `main`。
