---
adr: 98
title: 术语与分层：Agent / Session / Runtime / Loop / Run
status: accepted
date: 2026-11-01
related: [7, 15, 23, 33, 37, 40, 54, 81, 85, 88, 91, 92, 95, 97]
tags: [agent, session, runtime, loop, run, layering, terminology, control-plane, lease, migration]
---

## ADR-098：术语与分层：Agent / Session / Runtime / Loop / Run

- **上下文**：现态代码里同一个词同时指两件事——`AgentRuntime` 既当「执行框架」，又当「某个 Session
  的活执行对象」；`body` / `BodyEntry` / `AgentBodyRecord` / `PersistedBodyRecord` 各自指持久绑定与
  活状态；`RunState` 同时承载 Session 元数据与 run 进度；`ContextManager` 在多次 run 之间存活。
  持久实体（可落库）与运行时瞬时对象（内存、执行期销毁）混在一起，导致三处长期误读：
  ① 谁拥有 `WorkingContext`；② 谁写 `SessionEventLog` / `RunRecord`；③ 租约由谁持有、Run 能否直接
  访问。术语不稳则分层不稳，分层不稳则迁移无法分期验证。本 ADR 冻结五词、附属词、分层、层边界、
  C1–C4 决策、四连接语义、三条配套铁律与迁移分期，作为 Stage 0 的唯一权威文本。

- **决策**：

  #### 1. 五词（冻结）

  | 词 | 定义 | 代码落点 |
  |---|---|---|
  | **Agent** | 持久身份 + 能力档位 + membership/visibility 指针；不持有会话绑定、执行状态或 run | `AgentRecord`（原 `MemberRecord`） |
  | **Session** | 持久对话事实：append-only 事件 + 元数据壳（标题、预览、seq 游标、时间） | `SessionEventLog` + `SessionInfo` |
  | **Runtime** | 嵌入式执行框架/工厂：provider 注册表、工具集、插件引用、loop 模板；无状态、per-node、不绑定任何 Session | `Runtime`（无状态工厂，别名 `RuntimeFactory`） |
  | **Loop** | Run 内的纯函数/闭包：LLM 迭代编排（请求组装、工具 pipeline、终止判定）；零策略、无跨 run 状态、不碰持久化 | `ToolCallingLoop` |
  | **Run** | 一次执行：瞬时对象 + 增量 checkpoint 的 `RunRecord`；拥有 `WorkingContext` | `Run` + `RunRecord`（原 `RunCheckpoint`） |

  五词是外部口径。`Agent` / `Session` 是持久实体，`Runtime` 是无状态工厂，`Loop` 是 Run 内部实现
  细节，`Run` 是一次执行——四者不在同一抽象层级，不得互相平替。

  #### 2. 附属词（不进五词）

  | 词 | 定义 |
  |---|---|
  | **ControlPlane** | 管理面：Agent / Session / Binding / Team / Inbox / Conversation 生命周期、准入、路由、Scheduler、LeaseService |
  | **BindingRecord** | Agent ↔ Session 的 durable 绑定：epoch / primary / retired / 历史；**不持有有效、可用于续租的活跃租约**；仅留存 leaseId 与最后 renew 快照用于审计追溯 |
  | **ExecutionUnit** | per-session 活执行对象（原 `AgentRuntime`）；持有 Session 引用、只读事件句柄、lease 句柄、`activeRun`、abort |
  | **WorkingContext** | Run 从 `SessionEventLog` 生成的可重建窗口（消息切片、token 预算、压缩标记、检索游标）；**per-run 瞬时，不落库** |
  | **LeaseService** | 单节点本地租约服务；颁发/续租/回收 `BindingLease` + `SessionLease`；租约带 tenant 标签 |
  | **Scheduler / PluginHost / Inbox / Team / Conversation** | 保留原名与职责，不因本 ADR 改名 |

  #### 3. 分层（冻结）

  ```text
  Shells（CLI / TUI / WebUI / Gateway / Remote）
    → Assembly（src/ 唯一装配点）
      → ControlPlane（Agent / Session / Binding / Team / Inbox / Conversation / Scheduler / LeaseService）
        → Runtime（无状态工厂，per-node）
          → ExecutionUnit（per-session 长活）
            → Run（per-execution 瞬时）
              → ToolCallingLoop（Run 内闭包）

  Persistence：SessionEventLog（唯一真相）· RunRecord（增量 checkpoint）· EventStream（观察）
  Extensions：PluginHost → providers / tools / hooks / MCP
  Federation / Node：Node（部署实例）· Hub（全局目录/指针）· Federation（node→node team 投递）
  Cross-cutting：Config · Permission · Observability
  Tenant：数据隔离标签，渗透服务/存储，不画成组件
  ```

  - **Persistence**：`SessionEventLog` 是唯一 append-only 真相源；`RunRecord` 是 run 的增量
    checkpoint（状态 / token / 游标 / 错误）；`EventStream` 只是观察流，可丢弃、不可重放，不得作为
    恢复依据。
  - **Extensions**：`PluginHost` 是全局插件 / 工具 / 护栏注册中心，向下供给 providers、tools、
    hooks 与 MCP；插件不感知 Run 内部状态。
  - **Federation / Node**：Node 是 Vessel 部署实例，`node_id` 是寻址键；Hub 是独立顶层全局目录
    （目录 / 配对 / 指针 / presence），不代理正文、不做业务授权；Federation 是 node→node 的 team
    消息投递。
  - **Cross-cutting**：Config / Permission / Observability 横切所有层，不作为某个层的子组件。
  - **Tenant**：数据隔离标签，渗透所有服务与存储；它不是组件，任何架构图都不得把它画成节点。

  #### 4. 层边界（硬，10 条）

  1. **Gateway = Shell/Entrypoint 适配器**；transport 在 Assembly；Gateway 不含执行逻辑。
  2. **Hub = 独立顶层全局目录服务**；不属于单节点 ControlPlane；不代理正文、不做业务授权。
  3. **Node = Vessel 部署实例**；`node_id` 是寻址键；Tenant 是隔离标签。
  4. **Team / Inbox / Conversation = ControlPlane 托管的领域聚合**；Execution plane 不感知 Team。
  5. **WebUI → Gateway**；TUI/CLI 可进程内直连 bootstrap；远程/跨节点强制 Gateway。
  6. **ExecutionUnit per-session 长活**；同一 Session 多次 Run 复用 EU；Run 瞬时。
  7. **Runtime per-node 无状态**；Node 内多 tenant 共享。
  8. **LeaseService per-node 本地**；租约带 tenant 标签；跨节点迁移靠旧租约过期。
  9. **Federation 入站强制经过本节点 ControlPlane admit**（权限 / team / tenant / 防重放），之后才写
     Inbox / Team 日志。
  10. **WorkingContext 只读当前 SessionEventLog**；跨 Session 记忆是独立插件，不进主链路。

  #### 5. C1–C4（冻结）

  | # | 决策 |
  |---|---|
  | **C1** | **RunRecord 增量 checkpoint**：run 开始写 `status=running`；LLM/工具安全点更新 `event_cursor / iteration / usage`；结束 finalize。`WorkingContext` 不落库，resume 从 `SessionEventLog` + cursor 重建。 |
  | **C2** | **两级 lease**：`BindingLease`（binding_id，ControlPlane 授权 / LeaseService 颁发 / EU 持有并续租，归属保活）→ `SessionLease`（session_id，EU 在 Run 前获取，独占/append fencing）。顺序 binding → session；EU retire 时逆序释放；Run 不访问 LeaseService；读路径不需要租约。 |
  | **C3** | **`ToolCallingLoop` = Run 内纯函数/闭包**：不导出、无策略、不持租约/持久化；复杂时可降级为 Run 内局部类，禁止提升到 EU 方法。 |
  | **C4** | **`AgentRuntime` 整体改名 `ExecutionUnit`**；新建 `Runtime`（无状态工厂，别名 `RuntimeFactory`）；代码中不再出现 `AgentRuntime`。 |

  C1 之所以把 checkpoint 前置到 run 开始，是因为「durable run / run 可 resume」这一既有口径要求
  crash 后能找到 run 记录；只在结束时写与 resume 直接冲突。C2 的授权者（ControlPlane）与持有者
  （EU）分离，是「Run 不接触 LeaseService」得以成立的前提：Run 只收到 EU 注入的 fencingToken。

  > **Stage 3 补充（用户 2026-11-01）**：`restart` / `compactFork` 的 `conflict` payload 带
  > `run_id` / `session_id` / `lease_token`；`compactFork` 旧 primary EU/lease retire，新 lease
  > fence 必须更高，旧 token 写 `SessionEventLog` / `RunRecord` 被拒；生命周期事件带
  > `epoch` + `fencing_token`；`FileLeaseService` 仅单节点，不做集群共识。详见目标架构文档 §5。

  > **上下文 v2 补充（0.34）**：手动 `/compact`（live EU 或 idle 瞬态）是 Session 级控制操作，
  > 写 `message.compaction` + `SessionState`，**不写 `RunRecord`、不启动 Run**；是对「正常执行
  > 路径 Run 唯一写者」的显式受控例外。详见目标架构文档 §5。

  #### 6. 四连接语义（冻结）

  1. **Loop 不碰持久层**：`LOOP → RUN` 交还 facts / usage；`RUN → SessionEventLog` 追加事实、
     `RUN → RunRecordStore` 写 checkpoint；`LOOP → EventStream` 只发 observation。
     **`SessionEventLog` / `RunRecord` 的正常执行路径唯一写者 = Run**；ControlPlane 生命周期转移
     （`queued → cancelled`、`running → interrupted`）是受控例外，见目标架构文档。
  2. **EU → SessionEventLog 只读**：EU 只持 session 引用 / 只读句柄；不追加事实、不写 checkpoint。
  3. **租约链路**：ControlPlane 授权 → LeaseService 颁发 → ExecutionUnit 持有并续租；Run 不接触
     LeaseService；`RunRecord` 记 `fencingToken`，由 EU 启动 Run 时注入。**fencingToken 来自 EU
     当前持有的有效 SessionLease**，不是 Run 自行生成。
  4. **联邦逻辑边 vs 物理边**：图中 `TeamService A ↔ TeamService B` 是**逻辑边**；物理路径 =
     `TeamService A → federation client → Gateway B → ControlPlane B admit → TeamService B`。

  #### 7. 三条配套铁律

  1. **持久端口注入顺序**：`PersistencePorts` 只注入 Runtime 工厂层和 Run；EU 只拿只读 EventLog
     句柄；Loop 不注入任何 `PersistencePort`。
  2. **租约依赖隔离**：`LeaseService` 只被 ControlPlane 和 ExecutionUnit 引用；Run / Loop / Plugin
     不得持有 `LeaseService`。
  3. **逻辑边 vs 物理边**：跨节点连线默认是业务逻辑边；文档必须标注真实物理路由，禁止把逻辑边
     当作进程直连。

  #### 8. 迁移分期

  | Stage | 内容 | 行为变化 |
  |---|---|---|
  | **0** | ADR-098 + 旧 ADR 的 Errata + 架构页迁移指针；术语表 / 分层 / C1–C4 / 10 项层边界 / 4 连接语义 / 3 铁律 | 无（纯文档） |
  | **1a** | 纯改名：`AgentRuntime → ExecutionUnit`、body → `BindingRecord`；不含 `Runtime` / `RuntimeFactory`；不移动文件职责、不抽逻辑 | 无 |
  | **1b** | 抽 `ToolCallingLoop`（Run 内闭包） | 无（等价搬移） |
  | **2** | 类型拆分：`RunState` → Session 元数据 + `RunRecord`；`SessionBackend` 拆端口；`ContextManager` → `WorkingContext`；resume 拆词 | 有 |
  | **3** | 生命周期：rotate / restart / compactFork / fork；两级 lease；`serialKey` → `session_id` | 有 |
  | **4** | Runtime 框架化：新增 `Runtime`（无状态工厂，别名 `RuntimeFactory`）、Runtime 与 EU 分离、`WorkingContext` per Run、成员 run durable | 有 |

  0.34 顺序：Stage 0 → 1a → 1b → S2 → S1 → S5；0.35 续 Stage 2 → 3 → 4 与上下文 v2 B。

  **wire / 磁盘 / 事件名不变**：`session_id` / `run_id` / `body_id`（过渡期保留）/ `run.*` /
  `runtime.notice` 全部保持；**Stage 1a 不做任何 schema / 协议变更**，改名只发生在源码符号层。

  #### 9. 本 ADR 的效力边界（必须显式声明）

  - **ADR 是决策记录，不代表已实现。** 本 ADR 中的类名、端口名、分层图在 Stage 0 时点均未落到代码。
  - **架构页正文仍描述现态**；ADR-098 只描述目标态与迁移分期。架构页顶部只放迁移指针，正文随
    Stage 1a/2/3/4 落地逐页更新，共享文档只写已实现状态。
  - **本文不 supersede 任何旧 ADR**；旧 ADR 原文保留不改，差异见各 ADR 文末的
    `## Errata（0.34 术语与分层）` 段落。

- **备选**：
  - **(a) 只改名、不写分层与连线语义（否决）**：`AgentRuntime` 一词同时指框架与 per-session 活对象，
    只做 rename 会把「谁持有 WorkingContext」「谁写 EventLog」「Run 能否访问 LeaseService」三个歧义
    原样留在代码里，Stage 2/3/4 仍要重新裁决一遍。
  - **(b) 用一份完整架构规范取代 ADR（否决）**：规范属于 architecture 页，而架构页只写已实现状态
    （仓库既有纪律）。目标态与迁移分期没有别处可放，且本决策不新增目录、脚本或字段，沿用既有
    ADR 机制成本最低。
  - **(c) 保留 `AgentRuntime` 作为框架名、另造 per-session 类型（否决，即 C4 的推荐 A）**：
    `Runtime` 一词就与五词口径冲突，读者会持续误以为框架持有 Session；且 body/binding 改名已
    是 breaking，再叠加一层命名错位收益为零。
  - **(d) 只保留 `SessionLease`、去掉 `BindingLease`（否决）**：会失去节点保活语义——节点失效后
    Binding 归属无法被其他 ControlPlane 接管，只能靠 Session 层 fencing 事后发现，接管链路被
    拉长到下一次写入。

- **后果**：
  - **正面**：持久实体与运行时瞬时对象分开后，「谁写真相」有唯一答案（Run）；三类对象的生命周期
    各自独立可测；迁移可按 Stage 逐步验证，Stage 0/1a/1b 行为零变化。
  - **代价**：Stage 1a 是大面积符号改名（`AGENTS.md` 中「单个 agent 的 tool-calling loop 仍由
    `AgentRuntime` 实现」这类硬规则文本也要随之更新）；Stage 2–4 有真实行为变化，需逐阶段回归。
  - **兼容风险**：`body_id` 在过渡期保留为 wire 键，`BindingRecord` 是内部符号——存在「符号已改名、
    线上字段未改」的窗口期，文档与代码读者必须按 Stage 判断当前口径。
  - **风险点**：`WorkingContext` 不落库意味着 resume 必须能从 `SessionEventLog` + cursor 完整重建；
    若压缩不可逆，Stage 2 的 resume 必须记录重建所需的游标语义，否则恢复出的窗口与原窗口不一致。
  - **回归保护**：仓库不保留自动化测试套件，本次以 `check-docs` / `typecheck` / `biome` 与逐 Stage
    的 parity 走查覆盖；Stage 0 的验收要求 `git diff --stat` 只出现 `docs/**` 与根 `*.md`。

- **关联**：
  - [ADR-007](ADR-007-streaming-as-event-subscription.md)：`EventStream` 仍是可丢弃的观察流，
    ADR-098 只是把它在分层里定格为「不参与恢复」，不改订阅模型。
  - [ADR-015](ADR-015-no-loop-strategy-abstraction.md)：C3「Loop 零策略、不导出」是该决策的直接
    延续——`ToolCallingLoop` 是 Run 内闭包，不是可替换策略层。
  - [ADR-023](ADR-023-async-constructor-static-factory.md)：`Runtime` / `RuntimeFactory` 的工厂形态
    沿用「静态工厂替代异步构造函数」的口径。
  - [ADR-033](ADR-033-dependency-injection-and-orchestration.md)：C4 的 `ExecutionUnit` 承接其依赖
    倒置与编排外推的边界；依赖注入顺序由三条铁律之一的「持久端口注入顺序」钉死。
  - [ADR-037](ADR-037-modular-agent-runtime.md)：`Runtime` 作为无状态可嵌入框架，落实「modular
    agent runtime」的原始意图，但不再绑定 Session。
  - [ADR-040](ADR-040-durable-run-store-checkpoint-resume.md)：C1 把 `RunStore` checkpoint 细化为
    增量写入（`status=running` → 安全点 → finalize），`RunCheckpoint` 更名为 `RunRecord`。
  - [ADR-054](ADR-054-run-execution-and-failure-isolation.md)：`RunExecution` 收敛为瞬时的 `Run`，
    「同一执行对象同时只允许一个 active run」的口径不变，主语换到 `ExecutionUnit`。
  - [ADR-081](ADR-081-host-parity-and-serializable-snapshot.md)：`WorkingContext` 取代
    `ContextManager` 并降为 per-run 瞬时对象，可序列化快照的口径不变。
  - [ADR-085](ADR-085-compaction-retention-and-chunked-summary.md)：压缩产物只服务 `WorkingContext`
    的窗口重建，不改变「`SessionEventLog` 是唯一真相」。
  - [ADR-088](ADR-088-agent-service-package.md)：ControlPlane 与 Execution plane 的分层是该包边界
    的正式化，`AgentService` 归 ControlPlane，`Runtime` 归 Execution。
  - [ADR-091](ADR-091-agent-body-and-presence.md)：Agent / Body 关系不变，持久侧改称
    `AgentRecord` / `BindingRecord`，活状态由 `ExecutionUnit` 承接。
  - [ADR-092](ADR-092-agent-rotate-and-epoch-fencing.md)：epoch fencing 的判定对象由 body 改称
    binding，两级 lease 的 fencingToken 是同一机制的延伸。
  - [ADR-095](ADR-095-agent-spawn-and-contractors.md)：peer / contractor 的派生仍走 ControlPlane
    准入，本次改名不触碰派生规则。
  - [ADR-097](ADR-097-unified-agent-body-model.md)：单执行路径与 `run.*` 生命周期口径不变，本 ADR
    在其之上区分「框架 / 活对象 / 单次执行 / 迭代算法」四层。
  - **本文不 supersede 任何 ADR；旧 ADR 原文保留，与本文的差异见各 ADR 的
    `## Errata（0.34 术语与分层）` 段落。**

## Addendum（0.50 落地状态，2026-11-09）

本 ADR 的分层 / 术语 / C1–C4 / 连接语义 / 铁律已在 0.34–0.49 落地，故将 `status` 从
`proposed` 改为 `accepted`。落地证据：

- **Stage 4 分层**：`Runtime` 是 per-node 无状态工厂（`packages/core/src/runtime/runtime.ts:98`）；
  `ExecutionUnit` 是 per-session 长活对象（`packages/core/src/runtime/execution-unit.ts:264`）；
  `Run` 是瞬时执行，`WorkingContext` 每次 Run 新建（`execution-unit.ts:267`）；
  `ToolCallingLoop` 是 Run 内闭包函数（`packages/core/src/runtime/tool-calling-loop.ts:128`）；
  代码中已无 `AgentRuntime`。
- **C1**：`RunRecord` 增量 checkpoint，`WorkingContext` 不落库，resume 从
  `SessionEventLog` + cursor 重建（`docs/architecture/runtime-lifecycle.md`）。
- **C2**：两级 lease（`BindingLease` → `SessionLease`），EU 持有并续租，Run 不持
  `LeaseService`，fencingToken 由 EU 注入（`execution-unit.ts:366-368`）。
- **C3**：`runToolCallingLoop` 是 Run 内闭包，不导出策略、不碰持久化
  （`tool-calling-loop.ts:128`）。
- **C4**：`AgentRuntime` 已改名为 `ExecutionUnit`；`Runtime` 作为无状态工厂存在。
- **写者铁律**：事实事件 / `RunRecord` / `SessionState` 全部经 `RunJournal`；EU 只持
  只读 EventLog（`docs/architecture/runtime-lifecycle.md`）。
- **T3 单执行面**：一个 Node 服务一家公司，tenant 运行时抽象已移除
  （`docs/architecture/topology.md:19`；ADR-100 / ADR-049 Errata；T0–T5）。
  `TenantRuntimeProfile` 保留为内部单 id 类型（`runtime.ts:31`、`host.md:52`），
  不再表示多租户隔离。

**Errata（tenant 条款）**：本文 §2「LeaseService 租约带 tenant 标签」、§3「Node 内多
tenant 共享」、§4 边界 7/8 的 tenant 表述，已被 ADR-100（node=company）与 0.49 T0–T5
（tenant 抽象移除）取代；这些条款不再作为现态约束。其余分层与执行语义继续有效。

**命名差异**：本文 §1 的 `AgentRecord` 在代码中落为 `PersistedAgentRecord` +
`MemberRecord`（`packages/agent/src/types.ts:143`）；`RuntimeFactory` 别名未单独导出，
代码只导出 `Runtime`（`packages/core/src/runtime/index.ts:27`）。这两项不改变语义。

## 目标架构文档

详细分层、Mermaid 图与后续演进见 [docs/architecture/0.34-target.md](../architecture/0.34-target.md)。本 ADR 只记录决策；目标文档随 Stage 更新。
