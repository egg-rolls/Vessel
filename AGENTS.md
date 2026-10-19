# AGENTS.md

> Vessel 仓库的 AI 行为约定。与代码冲突时以代码为准，并顺手改掉本文档。

## 项目是什么

Vessel 是一个**可嵌入的多 agent 平台 runtime**：极简核心（稳定接口 + 1 个通用 tool-calling loop + 扩展插槽）、Provider 无关；TUI / CLI / Web / Gateway 是参考 harness 外壳。

- **语言/运行时**：TypeScript + Bun。
- **monorepo**：bun workspaces。`packages/{core,config,tui,serve,permission}` + `plugins/` + `apps/web`。
- **形态**：`@vessel/core` 是库（零 UI 依赖，可嵌入）；TUI / serve / web 是应用层外壳。
- **工具集**：能力工具只有 `bash` / `read` / `edit` 三个。默认运行期 4 个（+ `delegate_task`）；`ask_user` 仅 REPL+TTY（交互 REPL 为 5）；`team_*` 5 个仅在 `team.enabled: true` 时注册（共 9）；配置 `mcp_servers` 后额外注册 `mcp__<server>__<tool>`（数量动态，4 + N）。别急着加第四个能力工具。
- **状态**：alpha，pre-MVP。未实现的能力一律标注，不写进正文。
- **0.2 状态**：多 agent Kernel（Host / Scheduler / Transport）与模块 subpath exports **已实现**（`release/0.2`，未随版本发布）；`AgentRuntime` 仍是单 agent loop，Host 不重写循环。边界见 [ADR-037](docs/adr/ADR-037-modular-agent-runtime.md) 与 [ARCHITECTURE §14](docs/ARCHITECTURE.md)。
- **0.3 状态**：durable run、MCP 插件、远程监听 / TLS **已实现**（`release/0.3`，未随版本发布）；默认关闭 / 显式 opt-in。决策边界见 ADR-039 / 040 / 041。
- **0.4 状态**：workflow、evals、飞书渠道、metrics / 事件历史 / pruneRuns **已实现**（`release/0.4`，未随版本发布）；三个能力全部是插件、默认关闭；0.4 只做发布干跑，不 tag / publish / 合并 `main`。决策边界见 ADR-042 / 043 / 044 / 045。
- **0.5 状态**：文件优先存储、trace、统一 RPC 方法表 v1.1、多租户、YAML 主配置 **已实现**（`release/0.5`，未随版本发布）；默认 `session.backend: file`、trace 默认 `full`、tenant 缺省 `default`。插件 tenant 行为与 `--serve` 每 tenant 独立执行面 **已实现**；gateway 的 workflow / 飞书控制面仍只走 default tenant。微信不做。决策边界见 ADR-046 ~ ADR-050。
- **0.6 状态**：F5 跨机器远程、独立前端与跨节点 team **已实现**（`release/0.6`，未随版本发布）：`--connect` 非回环强制 HTTPS + token/CA，`serve.allowed_origins`，`transport.kind: remote` 静态节点与 `(node_id, seq)` 事件去重。默认仍本机回环；跨节点 team 控制面 default/admin-only。决策边界见 ADR-051 ~ ADR-053。
- **0.7.1 状态**：0.7 的 P0 加固补丁线（基于 `release/0.7`，未随版本发布）：legacy WS 方法统一按 principal/tenant 作用域执行；tenant 单写者锁修复回收 TOCTOU 与 24h 语义；外部插件仍默认加载但启动告警，并提供 `VESSEL_NO_EXTERNAL_PLUGINS=1` 显式 opt-out（P0-3 记为 **MITIGATED**，未关闭）。

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
- 不给 core 加默认厂商 API Key / Base URL / 价格。Key 永远用户自备。
- 引用文件路径前先确认它存在。本仓库已删除 `docs/specs/`、`docs/role/`、`docs/api/`、`docs/guides/`、`docs/dev/`、`processes/`、`legacy/`——指向它们的链接都是错的。
- 文档只写已实现；规划项明确标注。不吹未实现的能力。

## 文件与目录

共享侧与个人侧的分工、目录结构、角色独占路径、分支与发布规则，见 [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)。简版：

- 共享侧（本仓库）只放源码、测试、长期文档、CI；handoff / 计划 / 报告 / worktree 一律放个人侧，不提交。
- 每个角色只写自己的独占路径；跨路径改动先与 1 协商。
- 版本线：`main` → `release/0.7` → `0.7.1-<role>`（`release/0.1` ~ `release/0.6` 已冻结）；发布由 tag `v*` 触发，不由分支名触发。0.7.1 只干跑，不 tag、不 publish、不合并 `main`。

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
- 别在 workflow 的 `type: tool` 步骤里期待 guardrail / hook——它直接调 handler；需要 guardrail 用 `type: agent`。
- 别默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环不得匿名。
- 别给 MCP 工具设默认 `allow`；除非在 `auto_approve_tools` 里按原始工具名精确列出。
- 别让 Host 与成员 runtime 同时写同一个 run 的 checkpoint（唯一写者是 `AgentRuntime`，Host store 优先）。
- 别在文档里描述一个不存在的架构。
- 别绕过 PR 直接 push main。
