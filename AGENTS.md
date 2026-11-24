# AGENTS.md

## 🚨 开工前必须先做：检索设计元信息（否则会违反已定设计）

**任何实现/重构前，先按下面的顺序检索，读完再动手：**

1. `bun run scripts/docs-find.ts --goal "<你的目标>" --paths <你要改的路径>` —— 取 top 3 架构模块；
2. **必读** [docs/architecture/message-invariants.md](docs/architecture/message-invariants.md)：**两条产品核心不变量**
   （可见性对等 / 请求 messages append-only），以及**分段模型只有 `new` 与 `pop`**、
   **系统提示词 / 环境块 / 工具集在会话存续期间不可就地修改**（变化只能用「追加一条环境信息消息」表达；
   只有换会话、压缩、以及超出硬性上限（上下文长度）才允许开新段）。
3. 每条架构文档头部都有 **frontmatter 元信息**（`title` / `kind` / `triggers` / `paths`）——
   这是给 RAG 与 `docs-find` 检索用的**唯一入口**；改文档时必须同步维护它，
   **新增文档必须带 frontmatter 并登记 `docs/architecture/INDEX.md`**。
4. 与既有设计冲突时：**以设计文档为准**，代码是待修的一端；若认为设计该改，先改文档 + 说明理由，
   不要用「实现方便」反过来改设计。

> 这条写在最前面，是因为「不知道规矩的 agent」会静默破坏核心设计：前缀缓存被打掉、模型记忆被改写、
> 用户看不到 agent 看到的东西 —— 这些都不会报错，只会慢慢烂掉。

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
- **能力工具是 `bash` / `read` / `edit` / `write`**（`write`：建文件 / 整体替换 / 追加，**逐字节落盘、不经 shell**）。加第五个之前先证明它不能被现有四个表达出来。
  - 按用途选：**建文件 / 追加 / 整体替换 ⇒ `write`**；**局部改代码 ⇒ `edit`**（逐字符唯一匹配，改不中会报错）；**执行命令 ⇒ `bash`**（不要用它写文件：heredoc 与重定向会把内容交给 shell，反引号和 `$(` 会被先展开）。
  - 不提供 `grep` / 文件操作 / 注册型 meta-tools。插件工具 `subscribe`（显式文件订阅 + edit/write 自动订阅所改文件 + read 自动订阅所读行范围（line-level），`subscribe:false` 可 opt-out 该次调用的自动订阅；订阅变更只发短通知，按需 `inspect`）/ `agent` / `ask` 按入口注册，MCP 工具经插件注册；装配层常驻 `vessel` 控制面桥（单工具面，不注册工具，只桥接既有注册表与 RPC，见 [tools.md](docs/architecture/tools.md#vessel-bridge)）。工具口径与动作表见 [docs/architecture/tools.md](docs/architecture/tools.md#tools)。
  - **写协调（蜂群 Phase 1）**：`write` mode=overwrite 可选 `expected_content`（写前逐字节比对当前内容，不符报错不写；不传 = 旧行为）；edit/write 写临界区前持 `<baseCwd>/.vessel/write.lock` 工作区单锁（跨进程串行化写动作，合作式协议；bash/IDE/git 非合作写入者不受约束）。设计依据见个人侧 `docs/dev/research/swarm-shared-workspace-collaboration.md`。
  - **工具名一律 snake_case**（`^[a-z][a-z0-9_]*$`，≤64）：`web_search` / `pii_reveal` / `bash`，不要 `webSearch` / `piiReveal`。判据唯一真源是 `packages/core/src/runtime/tool-name.ts`，注册期不合规直接抛错（带 `badName → bad_name` 建议），装配期还有一道全量审计；MCP 等**外部名字原样透传**、只告警不阻断。改名必须登记进 `TOOL_NAME_ALIASES`（旧名保留一版别名，命中时结果里附一行弃用提示，不静默）。规则见 [docs/architecture/tools.md](docs/architecture/tools.md#tool-name-rule)。

## 硬安全规则（不可协商）

- **路径边界**：`read` / `edit` / `bash cwd` 统一走 `evaluatePath`；内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）是硬 `deny`；`allowed_roots` 只把越界降级为 `ask`；`deny_paths` 只能追加；比较基于 realpath。`bash` 文本匹配是 **best-effort，不是沙箱**（ADR-055/083）。
- **密钥**：不输出 / 不记录解析后的密钥；`app_secret` 永不打印，`app_id` 只允许前 4 位 + `***`；trace / 事件 / 日志 / `config show` 经 redactor；core 不给默认厂商 Key / Base URL / 价格（ADR-050/069）。
- **权限**：默认无限等待，不得重新引入 120s / 固定 TTL；只有显式正数 `timeoutMs` 才超时；abort 优先于超时。只有 human / policy 能答，没有 agent 审批人，不提供 `allow-after`（ADR-077/079/091）。
- **插件优先**：能做成插件的一律做成插件，**核心只留不变量与基座**（判据见 [docs/constitution/13-plugin-first.md](docs/constitution/13-plugin-first.md)）：新增能力先问「能不能做成插件」；答「能」就不往核心写；横跨两侧时按「机制在核心、实现在插件」切开。
- **授权分级**：「这点小事能不能不问就做」按 [docs/constitution/12-autonomy.md](docs/constitution/12-autonomy.md) 自己判，不再逐次请示：`allow` 直接做并在 commit message / 回报里注明依据，`ask` 用 ask 工具一次问全，`deny` 不做并说明命中哪条；顺序 deny → ask → allow，**未知按 ask**，冲突从重。
- **数据写入**：session / checkpoint 一律 `atomicWrite`，默认 `durable: true`；损坏 ≠ 不存在，抛 `SessionCorruptError`、不 unlink；单公司 data-dir 写意图锁（`src/data/data-lock.ts`），冲突返回 `data_locked` / `session_locked` / `run_locked`；运行时不再获取写者锁（ADR-056/086）。
- **单 run**：同一个 `ExecutionUnit` 同时只允许一个 active run；第二个 run 抛 `run_already_running`；不要另写终态持久化 / 事件发布路径（ADR-054）。
- **发布纪律**：1.0 前只做干跑，不 tag、不 publish、不 force-push；1 本地 squash 到 `main` 后直接 push，PR 只在用户明确要求时开；CI 异步，不作为 push 前置；tag `v*` 只有 1 打。
- **插件信任**：内置插件（随 release 发布）可信；外部插件从项目 `./.vessel/plugins` 与用户 `~/.vessel/plugins` 发现，默认不可信，安装时必须展示其声明的 `permissions`（`fs` / `net` / `process` / `secrets` / `events` / `rpc`），未声明能力默认拒绝；体验插件跑在子进程但**不是安全沙箱**，能力插件仍在 in-process、拥有完整进程权限；`VESSEL_NO_EXTERNAL_PLUGINS=1` 只加载内置插件（ADR-099）。
- **远程**：不默认开启远程监听或 TLS；远程必须显式 opt-in 且带 token；非回环必须 TLS；`serve.allowed_origins` 只接受显式 http(s) origin，禁止 `*` / path / query。
- **MCP**：MCP 工具默认不 `allow`；只按 `auto_approve_tools` 的原始工具名精确放行（ADR-039）。
- **evals**：默认离线；真实 provider 需 `config.evals.allowNetwork` + CLI `--allow-network` 双门控。

## 核心架构红线

- **core 保持小**：不出现业务概念（skills、记忆、资产、文档、代码审查、OCR、PDF、图片、向量、浏览器、IAM、计费）；`dependencies` 保持为空；重依赖只进插件包。
- **唯一 plugin 机制**：只有一个 plugin loader / manifest / 生命周期，一切经 `Plugin` + `PluginHost`；贡献面（pages / commands / settings / rpc / events / panels）由 harness 层扩展，不属于第二套扩展机制；Module 是构造期边界，禁止 `ModuleHost` / `ModuleRegistry`（[ADR-099](docs/adr/ADR-099-plugin-contribution-surfaces-and-trust.md)）。
- 依赖方向单向 `core ← 其它`（评审时人工核对各包 `package.json` 的层间依赖，仓库里没有自动脚本）；不引入 LangChain / LangGraph。
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
- [tui](docs/agents/tui.md) — `packages/tui/**`、`src/i18n/**`、`src/cli/**`：TUI + CLI 终端面。
- [plugins](docs/agents/plugins.md) — `plugins/**`、plugin loader：发现/信任/生命周期/MCP。
- [gov](docs/agents/gov.md) — `docs/**`、根文档、`.github/**`、`scripts/**`：文档生命周期、角色路径、发布/CI。
- **src 归类规则** — [docs/architecture/src-layout.md](docs/architecture/src-layout.md)：src 顶层只留 `cli.ts`，新文件按领域关键词表进 `src/<domain>/`（≥3 文件簇必进目录、新子系统 ≥3 文件必建目录）。

## 文件与目录

- 共享侧 / 个人侧分工、目录结构、角色独占路径、分支与发布规则见 [docs/FILE-MANAGEMENT.md](docs/FILE-MANAGEMENT.md)。共享侧只放源码、长期文档与 CI。
- 每个角色只写自己的独占路径；跨路径改动先与 1 协商。引用路径前先确认存在（`docs/role/`、`docs/api/`、`docs/guides/`、`processes/`、`legacy/` 已删除）；当前版本见 [docs/versions/CURRENT.md](docs/versions/CURRENT.md)。
- **文档就是 prompt**：写意图与允许的例外，不写会被字面执行的绝对禁令；ADR 的 `status` 与 `supersedes` / `related` 必须写在 frontmatter（没有脚本校验，靠评审），不能只写在正文。
- **提交可追溯**：squash / revert 提交带 `Squash-of:` / `Reverts:` / `Contract:` / `Decision:` trailer；合并以 tree-sha 为证据，不用“看起来一致”。

## 怎么跑与门禁

> **本仓无门禁 / 无测试 / 无探针**（宪法第三、四条）。**权威顺序**：**不做什么以个人侧宪法为准**；
> **做什么 / 怎么做以本文件（共享侧）为准**；两者冲突时**以「不干」为准** —— 共享侧任何条款若授予
> 宪法**禁止**的能力（例如允许存在测试 / 探针 / 门禁脚本），该条款**当场失效并删除**，不留「待补」、
> 不留作历史。自检：能改写成「不许 X」的是禁止条款（个人侧优先）；只能写成「要 X / 用 X」的是
> 操作条款（本文件优先）。

```bash
bun install
bun run build                                # = typecheck + lint（biome ci .）
VESSEL_MOCK=1 bun run src/cli.ts             # 本地 mock 起来看看，不连模型
VESSEL_MOCK=1 bun run src/cli.ts --run "hello"
bun run src/cli.ts --tools
bun run src/cli.ts doctor --deep
bun run src/cli.ts gateway start --daemon    # status --json / stop 同理
bun run src/cli.ts gateway status --json
bun run src/cli.ts gateway stop
bun run src/cli.ts stop --yes               # 舰队级停（清点 + 确认；--yes 跳过；--connect 远程）
bun run scripts/version.ts --check                        # 版本一致性（发版检查点）
bun run scripts/docs-find.ts --goal "add RPC method"      # 按目标检索文档
```

**本仓没有 gate / test / probe，也不要再造。** 宪法第三、四条：废除全部 gate / test / probe；
`*.test.*` / `*.spec.*` / `__tests__/` / 测试夹具一律不进仓库，存量随触碰删除、不补等价物；
🔴 **「不写测试」= 任何位置都不写测试文件**（2026-11-18 用户裁定）：仓库外、盘符根目录、
`D:/tmp` 等临时目录同样禁止，「不进仓库」不是「放仓库外」的许可证；诊断用临时脚本只放个人侧
`docs/dev/tmp/<slice>/` 且收尾即删，数据处理优先内联命令；
AI 自写的验证脚本不作为正确性依据。**「把某条命令跑一遍、全绿」不构成验收**；也不要往仓库里加
测试、探针或静态断言脚本 —— 别照旧文档重建（旧文档里那些条目已经作废）。
上面清单里 `bun run build` 是**唯一**的构建期检查（`typecheck` 覆盖根 + `examples/`，`lint` 是
`bunx @biomejs/biome ci .`）；其余都是工具 / 手工冒烟。CI 异步，不作为 push 前置。
完整命令见 [README.md](README.md) 的「快速开始」；CI / 发布见 [docs/operations/CI-CD.md](docs/operations/CI-CD.md) 与 [docs/operations/RELEASE.md](docs/operations/RELEASE.md)。

### 验收形态（唯一正确的做法）

**静态门禁由实施切片的 N 跑，1 / main 不亲自跑。** N 收尾逐条跑 typecheck / lint / build
（各自独立看 exit code，不 `&&` 串联后只看 tail），回报只留 **exit code + 失败摘要**
（摘要必须含首个错误的原文，不许只说「红了」）；日志落个人侧 `docs/dev/tmp/<slice>/gates.log`，
成功不贴日志。

🔴 **行为验证由用户本人做**（宪法第四条；2026-11-08 裁定，2026-11-18 重申）：不派 verifier / QA
子 agent，不起临时进程 / 服务 / 临时端口 / 临时 data dir，不跑探针 / 烟测 / 反例注入。
需要真实行为证据时**只读**真实日志与数据文件；**绝不写** `~/.vessel`，绝不重启 8642/8644。

- **别只信退出码**：本机（WSL → Windows bun）实测 `process.exit(3)` 与未捕获异常都可能返回
  `0`。所以除了 exit code，还要贴**失败摘要或产物读数**（构建类要有产物证据，例如
  `apps/web/dist` 存在且非空）。CI 的 Linux bun 才稳定按退出码生效。
- **不变量要有 owner 与 oracle**：谁守、怎么判真；判真落在用户行为验证与构建产物读数上
  （产物、真实数据形态、用户可见行为），不在仓库里落成脚本。
- **Web 时间线可见性的唯一判定点**：`apps/web/src/domains/chat/chat-visibility.ts`（`minimal / normal / debug`），live 与 history 必须共用同一份判定（旧 bug：live 藏、history 落盘后又冒出来）。
- **历史工具配对的唯一表示层**：`apps/web/src/domains/chat/history-tools.ts` 按 `tool_call_id` 把 assistant 的 `tool_calls[]` 与 `role:'tool'` 配对；「有调用无结果不得空白」「孤立结果不丢输出」是既有约定。时间线卡片的唯一表示层是 `domains/chat/StreamCard.tsx`（运行态与终止态共用）。
- **不变量分两级**：硬不变量零容忍；软不变量只许收敛、不许新增，每一项都要有 owner 与到期日，不做永久 allowlist（不落 baseline 脚本，比对靠用户验证与产物读数）。
- **模型审查是 search，不是 gate**：review 产出证据与契约修正；验收结论必须落在可复现的读数上（构建产物、真实数据形态、用户可见行为），不能落在「我跑过一遍」上。
- **工具版本以锁文件为准**：`bun install --frozen-lockfile` 或 `bunx <pkg>@<lock 版本>`，不用漂移的本地版本定义基线。

## 工作区（git worktree）

一个任务一个 worktree，做完立刻删 —— 单个 `node_modules` 是 259 MB / 11,287 个文件，而源码加起来只有 18 MB；留 N 个废弃 worktree 就是 260 MB × N / 百万文件。细节与沙箱实测见 docs 仓的 `docs/lessons/L-048-no-shared-node-modules-in-worktrees.md`（本仓 `docs/` 下没有 lessons 目录）。

- **位置与分支**：`worktrees/<topic>`（仓库目录**之外**的同级目录，与现有 `worktrees/*` 一致；别建在仓库里），分支名 `feat|fix|chore/<topic>`，从**本地 `main`** 起。
- **不共享依赖**：worktree 里自己 `bun install`（`apps/web` 另需 `bun install --cwd apps/web`）。**不得**用 junction / 硬链接 /「共享副本」把 `node_modules` 指回主仓：worktree 里写 `.cache` 或装包会改**主仓**，而 `git status` 仍然是干净的（node_modules 被 gitignore）⇒ 静默污染，等下次构建报错才发现；并且 `import.meta.resolve('@vessel-agent/core')` 会解析到**主仓的 `packages/core`** ⇒ 在分支里跑的验证验的是 main 的代码。
- **收尾必删**：任务结束立刻 `git worktree remove --force <path>`（实测连 `node_modules` 一起删，是该场景下安全的删法）。
- **删 worktree 的禁区**：不要用 `rm -rf <wt>/node_modules/`（**尾斜杠**）或 `rm -rf <wt>/node_modules/*`（**glob**）—— 这两个会**清空主仓 `node_modules`**。只用这四种：`git worktree remove --force <path>`、`Remove-Item <wt>/node_modules -Recurse -Force`、`cmd rd /s /q <wt>/node_modules`、`git clean -xdff`（后三种只删链接本体）。
- **批量清理废弃 worktree**：先按「分支是否已合进 main」分类（`git branch --merged main`），已合的直接删；对不上分支的先把源码打包（**排除 `node_modules`**）再删。**不要用文件 mtime 判断** —— `git checkout` 会刷新 mtime，实测会把全部误判成「要保留」。
- **大量删除别在 WSL / git-bash 里跑**：`/mnt/d` 上的海量小文件（`node_modules`）比原生慢几十倍，用原生 Windows（`cmd /c rd /s /q` 或 `robocopy <空目录> <目标> /MIR`）。

## 消息不变量（2026-11-14 用户裁定，**产品核心设计，两条都不得违反**）

1. **可见性对等**：用户在 UI 看到的消息，必须包含**会话中 agent 看到的全部消息**（不许有「agent 知道、用户看不见」的信息）。
   这意味着任何对模型侧内容的变形（脱敏 / 占位符 / 补充说明）都必须在**用户侧同样可见**，否则就是信息不对称。
2. **请求消息列表 append-only**：发给大模型的 messages 列表**只能追加，不许修改中间任何一条**。
   理由：一旦改写中间内容，从那条开始的整段 prefix 失效，**提示词缓存率被打掉**（长会话里代价极高）。

**推论（实现层，必须照此设计）**：
- 脱敏（PII/密钥）**不能在请求构造时改写历史**——那违反第 2 条；**必须在「消息 append 的那一刻」完成**，让存档与请求永远逐字一致。
- 真值保留在内存句柄仓库，UI 与模型看到**同一个占位符**；要真值走**审批解锁**（第 1 条允许的「多看到」必须由用户显式触发，而不是默认不对称）。
- 「引用已失效」这类状态变化**只能以「追加一条新消息」的方式表达**，不许回改旧消息；且按 session 去重、只讲状态、不含真值。
- 验收方向（不是仓库里的脚本）：由用户对真实会话断言「本次请求 messages 是上一版
  的前缀延伸」，任何中间差异都算违反第 2 条。

## 分层与能力准入

进 core 必须全部满足：大多数 harness 都需要、领域无关、可接口化、不绑 Provider 或厂商 SDK、能被多个应用复用。**拿不准就选插件，不选 core。** core 只放领域无关的运行时；其余做成 `plugins/<category>/<name>/`（放文件夹即注册；目录只在进程启动时扫描一次）。应用层外壳不往 core 反推需求。

判断“要不要动 core”：能做成 Tool（`registerTool`）/ Hook / Guardrail / 事件（开放字符串），或能由 `bash` + 模型自己组合出来 → 不进 core。单个 agent 的 tool-calling loop 仍由 per-session `ExecutionUnit` 实现，不要在 Host 再写一套 loop。

**Stage 4 分层红线**：`Runtime` 只持单 node profile 与内部单 id 的 `(id, sessionId)` EU 目录，不持 Session / Run / WorkingContext / lease / RunRecordStore；唯一 EU 构造入口是 `Runtime.getOrCreateExecutionUnit`。事实事件 / RunRecord / SessionState 只由 Run 经 `RunJournal` 写，EU 只持只读 EventLog；`WorkingContext` 每次 Run 新建。事件 / 配置 / RPC 不再有 tenant 维度；唯一例外是正交的 `AgentVisibility='tenant'` 与内部持久化单 id。
