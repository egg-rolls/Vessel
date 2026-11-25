# q-hire-prompt 设计：hire/create 加可选 startup_prompt（步骤①调研+schema）

任务：agent hire/create 加可选 `startup_prompt`，创建时即投递首条 user message（任务），
一步到位无需二次 send；与 rotate 的 startup_prompt 语义对齐。omit = 现行为（idle 等消息）。

## 1. 现态全链（调研结论）

### 1.1 创建链（与任务书锚点的出入）

hire/create 的 handler **不在 team-service.ts**（那是 Team 实体的 create/members），
而在 `packages/agent/src/service.ts` 的 `AgentServiceImpl.create → createOne`：

```
agent tool (tool.ts create/hire 分支, mapDerived 字段映射)
  → AgentService.create(CreateMemberInput | CreateBatchInput)
    → createOne：校验 → team 绑定 → 同名复用(reused:true) → 冻结/上限闸
      → MemberRecord → spawnRecord → agent.spawned → session.created 事件
      → nameNewSession（title/spawnedBy）→ statusFor 返回
```

- `createOne` 今天**不投递任何消息**（service.ts ~L1407 注释明言「create / hire 不发消息」）。
- 同名复用分支：`title` 已有先例——复用成员上声明 title 直接 `invalid_input` 拒绝。
- batch 入口 `create()` 有「单条字段 vs members 互斥」检查（单条字段清单不含 title）。
- seeded 分支 `createFromSource`（from_session_id）独立路径，尾部同样 nameNewSession 后返回。

### 1.2 rotate 的 startup_prompt 先例（投递机制的真源）

`tool.ts rotate 分支 → service.createSession(SessionCreateInput.startup_prompt)`，
createSession 尾部（service.ts ~L5876-5905）：

```ts
const startupPrompt = raw.startup_prompt === undefined ? undefined : readContent(raw, 'startup_prompt');
if (startupPrompt !== undefined) {
  const handoffName = allowActiveRun ? rotateHandoffInputName(epoch) : undefined;
  try {
    await this.admitInternal(
      { content: startupPrompt, agent_id: record.id, session_id: newSessionId,
        from: SYSTEM_PRINCIPAL, channel: 'direct',
        conversation_id: generateConversationId(this.newId), strict: false },
      { startup: true, ...(handoffName !== undefined ? { inputName: handoffName } : {}) },
    );
  } catch (error) { this.logger.warn('agent.session_create.startup_failed', {...}); }
}
```

`admitInternal` 的 `internal.startup: true`（service.ts ~L2746 注释）：
**启动嘱托直接作为 run input，不进 inbox**，不受 rotate 窗口守卫影响。
即：首条 user message 直接触发首轮 run；后续 send 正常排队 —— 恰好满足
「startup 先，send 排队后」。restart / activate 同机制（L6136 / L6304）。

身份渲染裁定（types.ts ~L290 注释）：`input_name` 只由生产者声明；
rotate（allowActiveRun）标 `rotate:handoff:<epoch>` 交接卡；
**create / restart / activate 的 startup_prompt 是调用方写的开场白，按正文渲染，不标**。

### 1.3 wire 链（CLI / RPC 共用一个入口）

```
CLI args.ts parseAgentArgs(create) → agent-command.ts methodParams
  → owner RPC / 远端 gateway（同一份方法定义）
  → packages/serve/src/gateway/methods/agents.ts 'agents.create'
    （params_schema 白名单 + handler 逐分支 optionalEntryString 映射）
  → src/agent/agent-control.ts create()（AgentCreateLikeInput → CreateMemberInput）
  → AgentService.create
```

- `AgentCreateLikeInput` 定义在 `packages/serve/src/agent-control.ts` L76。
- gateway handler 有 6 个 input 分支（seeded / kind=peer / kind=contractor /
  workspace / team_id / legacy 缺省），`title` 的先例是**分支前读一次**、各分支透传。
- CLI **没有 hire 子命令**（只有 create|send|inbox|close|list|dispatch）；
  hire 仅存在于 agent tool。CLI 侧落在 `agent create`。
- `--policy-file` 先例：args.ts 只存路径 + 互斥校验，命令层 readFile（team-command.ts L355）。

### 1.4 成员侧 schema

`runtime.ts` `MEMBER_AGENT_PROPERTIES` 是父级 tool.ts schema 的 fallback
（正常路径沿用父级同名字段）；`startup_prompt` / `members` 两处描述需与父级同步改。

## 2. schema 设计

### 2.1 agent tool（tool.ts）

- 顶层 `startup_prompt`（已存在，rotate 专用）描述扩为：
  `create/hire: optional first user message (the task) delivered at creation — the new
  member starts its first run at once, no follow-up send needed; omit = created idle.
  rotate: required; ...（原文保留）`
- `members` 数组描述：`[{name?, model?, system_prompt?, visibility?, title?, startup_prompt?}]`。
- `mapDerived` 增拷 `startup_prompt`（值不做类型校验，service 逐条拒绝，batch 不整批抛错）。
- create/hire 分支 `singles` 互斥清单加 `'startup_prompt'`（顶层与 members 混用显式拒绝）。
- 工具 description 的 create/hire 句补一句 startup_prompt 语义。

### 2.2 service 契约（packages/agent/src/types.ts）

`CreateMemberInput` 加 `startup_prompt?: string`（wire snake_case，与 from_session_id 同例）。

### 2.3 service 实现（service.ts）

- `create()` batch 互斥清单加 `record.startup_prompt`。
- `createOne()`：
  - 早期 `readContent` 校验（非空 + MAX_MESSAGE_BYTES 上限），早于任何副作用；
  - 同名复用分支：startup_prompt 存在 → `invalid_input`
    「startup_prompt cannot be delivered to a reused member; use send」（title 同例）；
  - spawn + session.created + nameNewSession 之后，按 createSession 同形投递：
    `admitInternal({content, agent_id, session_id: record.sessionId, from: SYSTEM_PRINCIPAL,
    channel:'direct', conversation_id, strict:false}, {startup:true})`；
    **不标 input_name**（开场任务按正文渲染，沿用 §1.2 裁定）；
    best-effort：失败只 warn `agent.create.startup_failed`，不回滚已提交的创建
    （与 rotate 的 startup_failed 同口径）。
  - 更新 L1407 附近「create / hire 不发消息」注释为「缺省不发消息；显式 startup_prompt 才投递」。
- `createFromSource()`：同样支持（尾部同形投递），避免 seeded 路径出现任意限制；
  复用拒绝逻辑不适用（seeded 不复用）。

### 2.4 wire（serve + gateway + agent-control）

- `packages/serve/src/agent-control.ts` `AgentCreateLikeInput` 加 `startup_prompt?: string`。
- `src/agent/agent-control.ts` create() 映射加一行透传。
- gateway `agents.create`：params_schema items 加 `startup_prompt: { type: 'string' }`；
  handler 在 title 旁读一次 `optionalEntryString(entry, 'startup_prompt', ...)`，
  6 个 input 分支各加条件透传。

### 2.5 CLI

- `args.ts`：`AgentCommand create` 加 `startupPrompt?: string; startupPromptFile?: string`；
  parse 加 `--startup-prompt <text>` / `--startup-prompt-file <path>`，互斥校验（policy 先例）。
- `agent-command.ts`：create 分支读文件（readFile，失败 → exit 1 错误文案），
  params.agents[0] 加 `startup_prompt`。
- `help-spec.ts` / `completion-spec.ts`：agent create flags 补两个旗标。
- CLI 无 hire 子命令 —— 不新造子命令，落在 create（任务书「hire/create」的 CLI 等价物）。

## 3. 兼容性与边界

- omit = 现行为逐字节不变（不投递、不新增事件字段）。
- startup_prompt 与后续 send 共存：startup 直投 run input 先跑，send 排队后。
- 空串 / 超 MAX_MESSAGE_BYTES → invalid_input（readContent 既有判据）。
- 同名复用 + startup_prompt → 显式拒绝（不静默丢任务）。
- batch：逐条独立投递 / 逐条失败隔离（settleBatch 既有语义）。
- 不改 Web UI（agent-form 不在本单范围）；不改 rotate 既有行为。

## 4. 改动文件清单（步骤②③④）

| 步骤 | 文件 | 改动 |
|---|---|---|
| ② | packages/agent/src/types.ts | CreateMemberInput.startup_prompt |
| ② | packages/agent/src/service.ts | create 互斥 / createOne 校验+复用拒绝+投递 / createFromSource 投递 / 注释 |
| ③ | packages/agent/src/tool.ts | mapDerived / singles / schema 描述 |
| ③ | packages/agent/src/runtime.ts | MEMBER_AGENT_PROPERTIES 两处描述同步 |
| ③ | packages/serve/src/agent-control.ts | AgentCreateLikeInput.startup_prompt |
| ③ | src/agent/agent-control.ts | create 映射透传 |
| ③ | packages/serve/src/gateway/methods/agents.ts | schema + handler 6 分支 |
| ③ | src/cli/args.ts | create 旗标解析 |
| ③ | src/cli/commands/agent/agent-command.ts | 读文件 + params |
| ③ | src/cli/help-spec.ts, src/cli/completion-spec.ts | 旗标登记 |
| ④ | bun run build | 唯一门禁（exit 0 + 产物读数） |

并发域：本单只动 agent service/tool/CLI agent 命令 + serve agents.create wire，
与 q-msg-visibility（config/runtime-visibility）、q-chat-index（ChatView）、
q-skills-ui（plugins/skills）无交集。