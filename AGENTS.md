# AGENTS.md

> Vessel 仓库的 AI 行为约定。与代码冲突时以代码为准，并顺手改掉本文档。
> 领域细节按路径读 `docs/agents/`；未命中时以本文件的硬安全规则为准。

## 先读什么

- 先读本文件与任务相关的 `docs/architecture/` 模块（从 [INDEX](docs/architecture/INDEX.md) 命中）；契约查 `docs/adr/` 的具体编号，不整读全部 ADR。
- 开工先 `bun run scripts/docs-find.ts --goal "<目标>" --paths <路径>` 取 top 3 模块；退出码 1（无命中）回落本文件硬规则。
- 历史决策查 ADR，当前版本查 [docs/versions/CURRENT.md](docs/versions/CURRENT.md)；实现事实以代码为准，文档冲突时顺手改文档。
- 读代码先 grep 定位再读片段，不整读超过 300 行的文件；一次只加载当前任务需要的文档。
- 过程产物（计划、报告、临时脚本）不进本仓库；文档只写已实现的能力。

## 项目是什么

- **可嵌入的多 agent 平台 runtime**：极简核心（稳定接口 + 1 个通用 tool-calling loop + 扩展插槽）、Provider 无关；TUI / CLI / Web / Gateway 是参考 harness 外壳。
- TypeScript + Bun；bun workspaces monorepo：`packages/{core,agent,config,permission,tui,serve}` + `plugins/` + `apps/web`。`@vessel-agent/core` 是零 UI 依赖的库，`@vessel-agent/agent` 是成员能力层，TUI / serve / web 是应用层外壳。
- **能力工具只有 `bash` / `read` / `edit`**，别急着加第四个（不提供 `grep` / 文件操作 / meta-tools）。插件工具 `subscribe`（显式文件订阅：变更只发短通知，按需 `inspect`）/ `agent` / `ask_user` 按入口注册，MCP 工具经插件注册；工具口径与动作表见 [docs/architecture/tools.md](docs/architecture/tools.md#tools)。

## 硬安全规则（不可协商）

- **路径边界**：`read` / `edit` / `bash cwd` 统一走 `evaluatePath`；内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）是硬 `deny`；`allowed_roots` 只把越界降级为 `ask`；`deny_paths` 只能追加；比较基于 realpath。`bash` 文本匹配是 **best-effort，不是沙箱**（ADR-055/083）。
- **密钥**：不输出 / 不记录解析后的密钥；`app_secret` 永不打印，`app_id` 只允许前 4 位 + `***`；trace / 事件 / 日志 / `config show` 经 redactor；core 不给默认厂商 Key / Base URL / 价格（ADR-050/069）。
- **权限**：默认无限等待，不得重新引入 120s / 固定 TTL；只有显式正数 `timeoutMs` 才超时；abort 优先于超时。只有 human / policy 能答，没有 agent 审批人，不提供 `allow-after`（ADR-077/079/091）。
- **数据写入**：session / checkpoint 一律 `atomicWrite`，默认 `durable: true`；损坏 ≠ 不存在，抛 `SessionCorruptError`、不 unlink；一个 tenant 一个写者，锁冲突返回 `tenant_locked` / `session_locked` / `run_locked`（ADR-056/086）。
- **单 run**：同一个 `AgentRuntime` 同时只允许一个 active run；第二个 run 抛 `run_already_running`；不要另写终态持久化 / 事件发布路径（ADR-054）。
- **发布纪律**：1.0 前只做干跑，不 tag、不 publish、不 force-push；1 本地 squash 到 `main` 后直接 push，PR 只在用户明确要求时开；CI 异步，不作为 push 前置；tag `v*` 只有 1 打。
- **插件信任**：默认加载外部插件，启动时向 stderr 告警；`VESSEL_NO_EXTERNAL_PLUGINS=1` 只加载仓库插件；显式 `plugins:` 即信任；外部插件以完整进程权限运行，P0-3 只做到缓解——不可信仓库务必 opt-out。
- **远程**：不默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环必须 TLS；`serve.allowed_origins` 只接受显式 http(s) origin，禁止 `*` / path / query。
- **MCP**：MCP 工具默认不 `allow`；只按 `auto_approve_tools` 的原始工具名精确放行（ADR-039）。
- **evals**：默认离线；真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控。

## 核心架构红线

- **core 保持小**：不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）；`dependencies` 保持为空；重依赖只进插件包。
- **唯一扩展机制**：一切走 `Plugin` + `PluginHost`；Module 是构造期边界，禁止 `ModuleHost` / `ModuleRegistry`。
- 依赖方向单向 `core ← 其它`，由 `scripts/check-deps.ts` 检查；不引入 LangChain / LangGraph。
- 事件名一律开放字符串 `<domain>.<action>.<event>`，不新增常量 / 枚举；全异步，不写 sync-in-async；不留半成品 stub。
- **诊断**：走 Logger（stderr），不得 `console.log` 到 stdout（stdout 只留命令结果 / JSON / UX）。
- 别为了加能力去改 loop 或扩接口——先证明 Tool / Hook / Guardrail / 事件都做不到。

## 领域告诫（按路径命中）

改对应路径前读一篇即可；未命中时以本文件硬安全规则为准。

- [core](docs/agents/core.md) — `packages/core/**`、`packages/config/**`：core 边界、tool pipeline、compaction、config resolver。
- [agent](docs/agents/agent.md) — `packages/agent/**`：AgentService、成员/team、dispatch。
- [serve](docs/agents/serve.md) — `packages/serve/**`、`src/rpc/**`：gateway/RPC/远程/hub。
- [web](docs/agents/web.md) — `apps/web/**`：i18n、token 存储、内联交互卡。
- [tui](docs/agents/tui.md) — `packages/tui/**`、`src/i18n/**`、`src/ui-style.ts`、`src/commands/**`：TUI + CLI 终端面。
- [plugins](docs/agents/plugins.md) — `plugins/**`、plugin loader：发现/信任/生命周期/MCP。
- [gov](docs/agents/gov.md) — `docs/**`、根文档、`.github/**`、`scripts/**`：文档生命周期、角色路径、发布/CI。

## 文件与目录

- 共享侧 / 个人侧分工、目录结构、角色独占路径、分支与发布规则见 [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)。共享侧只放源码、长期文档与 CI。
- 每个角色只写自己的独占路径；跨路径改动先与 1 协商。引用路径前先确认存在（`docs/specs/`、`docs/role/`、`docs/api/`、`docs/guides/`、`processes/`、`legacy/` 已删除）；当前版本见 [docs/versions/CURRENT.md](docs/versions/CURRENT.md)。

## 怎么跑与门禁

```bash
bun install
bun run typecheck
bunx @biomejs/biome ci .
VESSEL_MOCK=1 bun run src/cli.ts
VESSEL_MOCK=1 bun run src/cli.ts --run "hello"
bun run src/cli.ts --tools
bun run src/cli.ts doctor --deep
bun run src/cli.ts gateway start --daemon
bun run src/cli.ts gateway status --json
bun run src/cli.ts gateway stop
bun run scripts/version.ts --check
bun run scripts/release-dry-run.ts
```

仓库**没有自动化测试套件**：门禁只有 `bun run typecheck` + `bunx @biomejs/biome ci .`（加 `scripts/check-*.ts` 静态断言），运行时正确性靠一条端到端烟测 `VESSEL_MOCK=1 bun run src/cli.ts --run "hello"`。
改完代码至少跑 typecheck 与 biome；CI 异步，不作为 push 前置。收口额外门禁 `check-deps` / `smoke-subpaths` / `check-docs` / `version --check` / `release-dry-run` 只在用户要求或发布检查点。
完整命令见 [README.md](README.md) 的「快速开始」；CI / 发布见 [docs/operations/CI-CD.md](docs/operations/CI-CD.md) 与 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。

## 分层与能力准入

进 core 必须全部满足：大多数 harness 都需要、领域无关、可接口化、不绑 Provider 或厂商 SDK、能被多个应用复用。**拿不准就选插件，不选 core。** core 只放领域无关的运行时；其余做成 `plugins/<category>/<name>/`（放文件夹即注册；目录只在进程启动时扫描一次）。应用层外壳不往 core 反推需求。

判断“要不要动 core”：能做成 Tool（`registerTool`）/ Hook / Guardrail / 事件（开放字符串），或能由 `bash` + 模型自己组合出来 → 不进 core。单个 agent 的 tool-calling loop 仍由 `AgentRuntime` 实现，不要在 Host 再写一套 loop。
