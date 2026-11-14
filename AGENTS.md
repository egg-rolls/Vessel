# AGENTS.md

> Vessel 仓库的 AI 行为约定。与代码冲突时以代码为准，并顺手改掉本文档。
> 领域细节按路径读 `docs/agents/`；未命中时以本文件的硬安全规则为准。

> 0.34 Stage 4 已落地：分层为 `Assembly → Runtime（per-node 无状态工厂）→ ExecutionUnit（per-session）→ Run（瞬时，持 WorkingContext）→ ToolCallingLoop`；架构页正文描述该已实现状态。目标模型见 [docs/architecture/0.34-target.md](docs/architecture/0.34-target.md)，决策见 [ADR-098](docs/adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)（accepted；tenant 部分已被 ADR-100/T0–T5 取代）。

## 先读什么

- 先读本文件与任务相关的 `docs/architecture/` 模块（从 [INDEX](docs/architecture/INDEX.md) 命中）；契约查 `docs/adr/` 的具体编号，不整读全部 ADR。
- 开工先 `bun run scripts/docs-find.ts --goal "<目标>" --paths <路径>` 取 top 3 模块；退出码 1（无命中）回落本文件硬规则。
- 历史决策查 ADR，当前版本查 [docs/versions/CURRENT.md](docs/versions/CURRENT.md)；实现事实以代码为准，文档冲突时顺手改文档。
- 读代码先 grep 定位再读片段，不整读超过 300 行的文件；一次只加载当前任务需要的文档。
- 过程产物（计划、报告、临时脚本）不进本仓库；文档只写已实现的能力。
- 文档 / handoff 不写死读数（写命令；确需写值带 `sha` + 时间戳）见 [gov](docs/agents/gov.md)。
- 事件重放等价（replay 作 oracle，含 SSE `since` 续传 / 重复 / 缺口）见 [events](docs/architecture/events.md)。

## 项目是什么

- **可嵌入的多 agent 平台 runtime**：极简核心（稳定接口 + 1 个通用 tool-calling loop + 扩展插槽）、Provider 无关；TUI / CLI / Web / Gateway 是参考 harness 外壳。
- TypeScript + Bun；bun workspaces monorepo：`packages/{core,agent,config,permission,tui,serve}` + `plugins/` + `apps/web`。`@vessel-agent/core` 是零 UI 依赖的库，`@vessel-agent/agent` 是成员能力层，TUI / serve / web 是应用层外壳。
- **能力工具只有 `bash` / `read` / `edit`**，别急着加第四个（不提供 `grep` / 文件操作 / meta-tools）。插件工具 `subscribe`（显式文件订阅：变更只发短通知，按需 `inspect`）/ `agent` / `ask` 按入口注册，MCP 工具经插件注册；工具口径与动作表见 [docs/architecture/tools.md](docs/architecture/tools.md#tools)。

## 硬安全规则（不可协商）

- **路径边界**：`read` / `edit` / `bash cwd` 统一走 `evaluatePath`；内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）是硬 `deny`；`allowed_roots` 只把越界降级为 `ask`；`deny_paths` 只能追加；比较基于 realpath。`bash` 文本匹配是 **best-effort，不是沙箱**（ADR-055/083）。
- **密钥**：不输出 / 不记录解析后的密钥；`app_secret` 永不打印，`app_id` 只允许前 4 位 + `***`；trace / 事件 / 日志 / `config show` 经 redactor；core 不给默认厂商 Key / Base URL / 价格（ADR-050/069）。
- **权限**：默认无限等待，不得重新引入 120s / 固定 TTL；只有显式正数 `timeoutMs` 才超时；abort 优先于超时。只有 human / policy 能答，没有 agent 审批人，不提供 `allow-after`（ADR-077/079/091）。
- **数据写入**：session / checkpoint 一律 `atomicWrite`，默认 `durable: true`；损坏 ≠ 不存在，抛 `SessionCorruptError`、不 unlink；单公司 data-dir 写意图锁（`src/data-lock.ts`），冲突返回 `data_locked` / `session_locked` / `run_locked`；运行时不再获取写者锁（ADR-056/086）。
- **单 run**：同一个 `ExecutionUnit` 同时只允许一个 active run；第二个 run 抛 `run_already_running`；不要另写终态持久化 / 事件发布路径（ADR-054）。
- **发布纪律**：1.0 前只做干跑，不 tag、不 publish、不 force-push；1 本地 squash 到 `main` 后直接 push，PR 只在用户明确要求时开；CI 异步，不作为 push 前置；tag `v*` 只有 1 打。
- **插件信任**：内置插件（随 release 发布）可信；外部插件从项目 `./.vessel/plugins` 与用户 `~/.vessel/plugins` 发现，默认不可信，安装时必须展示其声明的 `permissions`（`fs` / `net` / `process` / `secrets` / `events` / `rpc`），未声明能力默认拒绝；体验插件跑在子进程但**不是安全沙箱**，能力插件仍在 in-process、拥有完整进程权限；`VESSEL_NO_EXTERNAL_PLUGINS=1` 只加载内置插件（ADR-099）。
- **远程**：不默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环必须 TLS；`serve.allowed_origins` 只接受显式 http(s) origin，禁止 `*` / path / query。
- **MCP**：MCP 工具默认不 `allow`；只按 `auto_approve_tools` 的原始工具名精确放行（ADR-039）。
- **evals**：默认离线；真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控。

## 核心架构红线

- **core 保持小**：不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）；`dependencies` 保持为空；重依赖只进插件包。
- **唯一 plugin 机制**：只有一个 plugin loader / manifest / 生命周期，一切经 `Plugin` + `PluginHost`；贡献面（pages / commands / settings / rpc / events / panels）由 harness 层扩展，不属于第二套扩展机制；Module 是构造期边界，禁止 `ModuleHost` / `ModuleRegistry`（[ADR-099](docs/adr/ADR-099-plugin-contribution-surfaces-and-trust.md)）。
- 依赖方向单向 `core ← 其它`，由 `scripts/check-deps.ts` 检查；不引入 LangChain / LangGraph。
- 事件名一律开放字符串 `<domain>.<action>.<event>`，不新增常量 / 枚举；全异步，不写 sync-in-async；不留半成品 stub。
- **诊断**：走 Logger（stderr），不得 `console.log` 到 stdout（stdout 只留命令结果 / JSON / UX）。
- 别为了加能力去改 loop 或扩接口——先证明 Tool / Hook / Guardrail / 事件都做不到。
- **API surface = prompt surface**：新增 tool / action / field / event 都是每轮请求的固定 token 税；设计评审要论证“模型必须知道它”，不只看代码实体多少。

## 领域告诫（按路径命中）

索引见 [docs/agents/INDEX.md](docs/agents/INDEX.md)。改对应路径前读一篇即可；未命中时以本文件硬安全规则为准。

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
- **文档就是 prompt**：写意图与允许的例外，不写会被字面执行的绝对禁令；ADR 的 `status` 与 `supersedes` / `related` 由 `check-docs` 校验，不能只写在正文。
- **提交可追溯**：squash / revert 提交带 `Squash-of:` / `Reverts:` / `Contract:` / `Decision:` trailer；合并以 tree-sha 为证据，不用“看起来一致”。

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

仓库默认不维护通用测试套件：纯核心窄属性测试与有状态探针属于验证纪律的例外（见下）。**当前没有自动 test gate**，接入前只能一次性 / 定向运行验证；门禁只有 `bun run typecheck` + `bunx @biomejs/biome ci .`（加 `scripts/check-*.ts` 静态断言），运行时正确性靠一条端到端烟测 `VESSEL_MOCK=1 bun run src/cli.ts --run "hello"`。
改完代码至少跑 typecheck 与 biome；CI 异步，不作为 push 前置。收口额外门禁 `check-deps` / `smoke-subpaths` / `check-docs` / `version --check` / `release-dry-run` 只在用户要求或发布检查点。
完整命令见 [README.md](README.md) 的「快速开始」；CI / 发布见 [docs/operations/CI-CD.md](docs/operations/CI-CD.md) 与 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。

- **能机械判定的规则写成门禁**：不变量要有 owner（谁守）、oracle（怎么判真）与门禁层级；没有门禁的只能标成建议。
- **不要只看退出码**：本机（WSL → Windows bun）实测 `process.exit(3)` 与未捕获异常都返回 `0`。判定一律看输出文本（`Found N error` / `FAIL` / `passed`），或把断言写进输出里；CI 的 Linux bun 才会按退出码生效。历史上因此漏过 `check-docs` 的「文档行数超上限」。
- **Web 时间线可见性门禁**：`bun run check:chat-visibility`（`scripts/check-chat-visibility.ts`）。`minimal / normal / debug` 的判定唯一在 `apps/web/src/domains/chat/chat-visibility.ts`，live 与 history 必须共用；fixture 断言「运行中与已终态判定一致」（旧 bug 是 live 藏、history 落盘后冒出来）。
- **历史工具配对门禁**：`bun run check:history-tools`（`scripts/check-history-tools.ts`）。`apps/web/src/domains/chat/history-tools.ts` 按 `tool_call_id` 把 assistant 的 `tool_calls[]` 与 `role:'tool'` 配对；fixture 钉死「有调用无结果不得空白」「孤立结果不丢输出」。时间线卡片的唯一表示层是 `domains/chat/StreamCard.tsx`（运行态与终止态共用）。它是**唯一被批准能进 gates 的测试形态**（纯函数 + 可机械判定的不变量 + 能进 CI）：不要照着扩成浏览器测试，也不要为它追覆盖率。
  另一类允许存在的证据是 `src/*.test.ts` 的**窄属性测试**（`refs-notice-hook` / `member-cwd` / `self-card-delta` / `ask-attribution`）：定向运行、**不进 gates**、不追覆盖率 —— 它证明「某个行为变更确实被验过」，不是回归套件的起点。
- **不变量分两级**：硬不变量零容忍；软不变量用 baseline + delta，只要求不新增；例外必须有 owner 与到期日，不做永久 allowlist。
- **验证分两层**：纯核心用窄属性测试；有状态外壳用不变量探针（状态矩阵 / 失败注入 / replay 等价）。不追覆盖率；“当前没有 test gate”不是不写验证的理由——每项行为变更要有针对它的证据。
- **模型审查是 search，不是 gate**：review 产出证据、探针与契约修正；合并 / 验收结论必须落在确定性门禁上。
- **门禁断言产物与反例**：exit 0 不够——构建类门禁还要断言产物存在（如 `apps/web/dist`），并至少做一次“改坏必须红”的负向验证。
- **门禁分级并钉版本**：阻断级与观测级分开，warnings 收紧只在 CI 生效；工具版本以锁文件为准（`bun install --frozen-lockfile` 或 `bunx <pkg>@<lock 版本>`），不用漂移的本地版本定义基线。

## 消息不变量（2026-11-14 用户裁定，**产品核心设计，两条都不得违反**）

1. **可见性对等**：用户在 UI 看到的消息，必须包含**会话中 agent 看到的全部消息**（不许有「agent 知道、用户看不见」的信息）。
   这意味着任何对模型侧内容的变形（脱敏 / 占位符 / 补充说明）都必须在**用户侧同样可见**，否则就是信息不对称。
2. **请求消息列表 append-only**：发给大模型的 messages 列表**只能追加，不许修改中间任何一条**。
   理由：一旦改写中间内容，从那条开始的整段 prefix 失效，**提示词缓存率被打掉**（长会话里代价极高）。

**推论（实现层，必须照此设计）**：
- 脱敏（PII/密钥）**不能在请求构造时改写历史**——那违反第 2 条；**必须在「消息 append 的那一刻」完成**，让存档与请求永远逐字一致。
- 真值保留在内存句柄仓库，UI 与模型看到**同一个占位符**；要真值走**审批解锁**（第 1 条允许的「多看到」必须由用户显式触发，而不是默认不对称）。
- 「引用已失效」这类状态变化**只能以「追加一条新消息」的方式表达**，不许回改旧消息；且按 session 去重、只讲状态、不含真值。
- 门禁方向（待补）：`check:request-append-only` —— 断言「本次请求 messages 是上一版的前缀延伸」，任何中间差异都必须红。

## 分层与能力准入

进 core 必须全部满足：大多数 harness 都需要、领域无关、可接口化、不绑 Provider 或厂商 SDK、能被多个应用复用。**拿不准就选插件，不选 core。** core 只放领域无关的运行时；其余做成 `plugins/<category>/<name>/`（放文件夹即注册；目录只在进程启动时扫描一次）。应用层外壳不往 core 反推需求。

判断“要不要动 core”：能做成 Tool（`registerTool`）/ Hook / Guardrail / 事件（开放字符串），或能由 `bash` + 模型自己组合出来 → 不进 core。单个 agent 的 tool-calling loop 仍由 per-session `ExecutionUnit` 实现，不要在 Host 再写一套 loop。

**Stage 4 分层红线**：`Runtime` 只持单 node profile 与内部单 id 的 `(id, sessionId)` EU 目录，不持 Session / Run / WorkingContext / lease / RunRecordStore；唯一 EU 构造入口是 `Runtime.getOrCreateExecutionUnit`。事实事件 / RunRecord / SessionState 只由 Run 经 `RunJournal` 写，EU 只持只读 EventLog；`WorkingContext` 每次 Run 新建。事件 / 配置 / RPC 不再有 tenant 维度；唯一例外是正交的 `AgentVisibility='tenant'` 与内部持久化单 id。
