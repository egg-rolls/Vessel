---
title: 消息与运行时 API
kind: current
triggers: [RunOptions, messages, injection, agent runtime, context, at-path, skills]
paths: [packages/core/src/runtime/**, packages/core/src/types/**]
---

# 消息与运行时 API
> Stage 4 已落地：`Runtime` 是 per-node 无状态工厂，`ExecutionUnit` 是 per-session，`WorkingContext` 归每次 Run。目标模型见 [0.34-target.md](0.34-target.md)，决策见 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)。

<a id="messages"></a>

## 消息组装：`RunOptions.messages`

core 的通用注入位。调用方把**任何要进语言空间的文本**拼成消息传进来：

```ts
export interface RunOptions {
  signal?: AbortSignal;
  branch?: string;
  /**
   * 本轮请求前置注入的消息。core 不解释其来源与语义——
   * skill 内容、附件、引用文件、项目约定，任何要进语言空间的文本都走这里。
   * 写入顺序：注入消息在前，用户输入在后；两者都持久化进 WorkingContext。
   */
  messages?: Message[];
}

run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string>;
```

语义边界：

- **顺序**：注入消息在前，用户输入在后。
- **持久化**：注入消息与用户输入一样进本 Run 的 `WorkingContext`（是本轮真实对话历史的一部分，不是一次性遮罩）。
- **Input guardrail 先于写用户消息**：注入消息写入后、用户消息写入前执行；被阻断的输入不进入上下文（已写入的注入消息保留）。`replacement` 是字符串时，改写后的内容才是持久化的用户消息（PII 脱敏语义）。
- **会话标题**：取首轮最后一条 `user` 消息；注入消息在前，不抢标题。
- **core 不解释语义**：core 不知道哪条是 skill、哪条是附件。它只按序 `addContext`。
- **谁负责组装**：前端。REPL 发送前扫描输入里的 `@<路径>`：
  1. `@` 必须位于**行首或空白之后**（`a@b.com` 不触发）；
  2. 取其后**连续非空白字符**作为 token；
  3. 在该段**第一个全角标点处截断**，再**剥掉尾部的半角/全角标点**，得到路径。

  每个命中文件读为一条 user 注入消息（`<file path="...">内容</file>`，>100KB 截断并在末尾标注），读取失败则跳过并给一条 warning，**用户原文一字不改**。经 `RunOptions.messages` 传给 `run()`。headless 侧的对应入口是 `--run @file`。

  > **为什么要有「全角标点截断」这一步**：中文里路径与标点之间没有空白——`@skills/x.md，请按这个来` 的 token 尾字符是汉字，只剥尾部标点剥不掉 `，` 及其后面的句子；而半角标点**不能**当截断符（会把 `@skills/code-writing.md` 在第一个 `.` 处打断）。所以规则是：**全角标点截断，半角标点只剥尾部**。
- **skills 不是一条加载通道**：harness 不扫描、不解析、不注入 skills 目录。技能就是 markdown 文件，放两个位置——仓库 `skills/`（项目级，随仓库提交、团队共享）与 `~/.vessel/skills/`（用户级，跨项目复用）。这是纯约定，代码里零硬编码。前端负责查找与引用，core 只收消息。

当前内置使用者：`@path` 文件引用（TUI/headless）与成员来源标注 `vessel:source`
（`packages/agent`）。两者都持久化，且都在用户输入之前。

`BeforeLlm` 的注入是**另一件事**：system 冻结，hook 只能读 `ctx.systemPrompt`、
往 `ctx.messages` 追加尾部消息（持久化）；旧 `HookResult.additionalContext` 自动转成
`vessel:hook` 尾部消息。完整注入矩阵见 [context](context.md#injection)。

<a id="execution-unit"></a>

## `Runtime` 与 `ExecutionUnit` 公开面

`Runtime` 是 per-node 无状态工厂（只持单 node profile 与 `(内部单 id, sessionId)` EU 目录）；`ExecutionUnit` 是 per-session 长活对象。主执行面与成员都经 `getOrCreateExecutionUnit`；同 key 返回同一对象，`agentId` 不一致抛 `execution_unit_binding_conflict`。

| API | 语义 |
|---|---|
| `registerProfile(profile)` | 同内部单 id 幂等；冲突抛错。profile：`tenantId`（内部单 id）/ `providerFactory` / `model` / `plugins` / `pluginHostFactory?` / `limits?` / `termination?` / `includeReasoning?` / `context{maxTokens?,autoCompact?,summarizer?}` / `systemPrompt?` / `permission?` / `journalFactory` |
| `getOrCreateExecutionUnit(req)` | 请求：`tenantId`（内部单 id）/ `sessionId` / `agentId?` / `session?` / `events` / `eventLog?` / `leaseService?` / `bindingLease?` / `pluginHost?` / `plugins?` / `contextFactory?` / `overrides?` |
| `getExecutionUnit` / `retireExecutionUnit` / `listExecutionUnits` / `profileCount` | 诊断与 ControlPlane 生命周期；retire 幂等 |

```ts
class ExecutionUnit {
  static create(opts: ExecutionUnitOptions): Promise<ExecutionUnit>;
  readonly events: EventStream;         // headless / 外部订阅者入口
  readonly pluginHost: PluginHost;      // 工具与插件的唯一来源
  run(input, sessionId?, opts?): Promise<string>;
  resumeRun(record: RunRecord, opts?): Promise<string>;  // 调用方负责 load / 路由
  resumeSession(sessionId, input, opts?): Promise<string>;
  interrupt(reason?): void;
  dispose(): Promise<void>;
}

interface ExecutionUnitOptions {
  provider: LLMProvider; model: string;
  contextFactory: (init: { sessionId: string }) => WorkingContext;  // 每次 Run 新建
  events: EventStream; limits: UsageLimits; termination: TerminationPolicy;
  plugins?: Plugin[]; pluginHost?: PluginHost; limitChecker?: LimitChecker;
  session?: SessionStore;
  journalFactory: RunJournalFactory;   // 事实事件 / RunRecord / SessionState 唯一写端口
  agentId?: string; systemPrompt?: string; permission?: RuntimePermissionConfig;
  eventLog?: SessionEventLogPort;      // 只读；写由 journal 承担
  leaseService?: LeaseServicePort;     // EU 持有/续租，Run 不持
}
```

`create()` 是异步静态工厂（插件安装 fail-fast，ADR-023）；装配层不再直接调用，单 bundle 与成员 host 都经 `Runtime`。

run 级状态收敛在 `Run`（`runId` / `sessionId` / `branch` / 计时 / `stats` / `workingContext`）。`run()` / `resumeRun()` 共用 `activeRun` 槽位并在首个 await 前同步占位；已有 active run 抛 `RunAlreadyRunningError`。公开 `RunnableAgent.resumeRun?(runId)` 仍是门面签名，per-session 门面负责 `runStore.load` 后调 `EU.resumeRun(record)`。

Kernel 侧：`AgentService.resume(runId)` 加载 checkpoint、解析 agent / body，再用 `ScheduledTask.runId` 经 Scheduler 排队；resume 只接受 `running` / `interrupted`，并发恢复首个成功、后续 `run_already_running`（ADR-040 / ADR-097）。

