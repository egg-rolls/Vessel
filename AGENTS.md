# AGENTS.md

> Vessel 仓库的 AI 行为约定。与代码冲突时以代码为准，并顺手改掉本文档。

## 项目是什么

Vessel 是一个**可嵌入的多 agent 平台 runtime**：极简核心（9 个接口 + 1 个通用 tool-calling loop + 2 个插槽）、Provider 无关；TUI / CLI / Web / Gateway 是参考 harness 外壳。

- **语言/运行时**：TypeScript + Bun。
- **monorepo**：bun workspaces。`packages/{core,config,tui,serve,permission}` + `plugins/` + `apps/web`。
- **形态**：`@vessel/core` 是库（零 UI 依赖，可嵌入）；TUI / serve / web 是应用层外壳。
- **工具集**：能力工具只有 `bash` / `read` / `edit` 三个。默认运行期 4 个（+ `delegate_task`）；`ask_user` 仅 REPL+TTY（交互 REPL 为 5）；`team_*` 5 个仅在 `team.enabled: true` 时注册（共 9）；配置 `mcp_servers` 后额外注册 `mcp__<server>__<tool>`（数量动态，4 + N）。别急着加第四个能力工具。
- **状态**：alpha，pre-MVP。未实现的能力一律标注，不写进正文。
- **0.2 状态**：多 agent Kernel（Host / Scheduler / Transport）与模块 subpath exports **已实现**（`release/0.2`，未随版本发布）；`AgentRuntime` 仍是单 agent loop，Host 不重写循环。边界见 [ADR-037](docs/adr/ADR-037-modular-agent-runtime.md) 与 [ARCHITECTURE §14](docs/ARCHITECTURE.md)。
- **0.3 状态**：durable run、MCP 插件、远程监听 / TLS **已实现**（`release/0.3`，未随版本发布）；默认关闭 / 显式 opt-in。决策边界见 ADR-039 / 040 / 041。
- **0.4 状态**：workflow、evals、飞书渠道、metrics / 事件历史 / pruneRuns **已实现**（`release/0.4`，未随版本发布）；三个能力全部是插件、默认关闭；0.4 只做发布干跑，不 tag / publish / 合并 `main`。决策边界见 ADR-042 / 043 / 044 / 045。

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
- 版本线：`main` → `release/0.4` → `0.4.0-<role>`（`release/0.1` / `release/0.2` / `release/0.3` 已冻结）；发布由 tag `v*` 触发，不由分支名触发。0.4 只干跑，不 tag、不 publish、不合并 `main`。

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

## 别做什么

- 别把插件对象塞进 runtime 构造函数（走 `plugins` 或 `pluginHost` 注入）。
- 别在 core 里引用 `tui` / `config` / `plugins`（依赖方向是单向的）。
- 别为了加能力去改 loop 或扩接口——先证明 Tool / Hook / Guardrail / 事件都做不到。
- 别给模型再加一个能干的、能与 bash 等价的事的工具。
- 别写 harness 层面的 skills 扫描 / 解析 / 注入通道——skills 就是文件，经消息进来。
- 别把 MCP / workflow / evals / feishu 塞进 core（它们都是插件）；durable 只做 core 的 `RunStore` port；workflow 不注册模型工具；多租户仍是非目标；team 仍默认 off、显式 opt-in。
- 别在日志 / 事件 / 报告里输出飞书的 `app_secret` 或完整 `app_id`；只允许前 4 位 + `***`。
- 别在 workflow 的 `type: tool` 步骤里期待 guardrail / hook——它直接调 handler；需要 guardrail 用 `type: agent`。
- 别默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环不得匿名。
- 别给 MCP 工具设默认 `allow`；除非在 `auto_approve_tools` 里按原始工具名精确列出。
- 别让 Host 与成员 runtime 同时写同一个 run 的 checkpoint（唯一写者是 `AgentRuntime`，Host store 优先）。
- 别在文档里描述一个不存在的架构。
- 别绕过 PR 直接 push main。
