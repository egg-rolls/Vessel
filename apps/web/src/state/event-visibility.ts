/**
 * 事件可见性三档表（**唯一分类表**）。
 *
 * 判据只有一句：档位由**内容性质**决定，不由「默认想不想藏」决定。
 * - `content`：用户要读的对话内容（正文 / 工具 / 输入 / run 终态 / 真失败）—— 永远可见；
 * - `internal`：run 内部状态同步与过程信号 —— 默认隐藏，`ui.showInternalEvents` 或
 *   `verbosity: debug` 时可见（`showsInternalEvents` 的「或」语义，ADR-080/082）；
 * - `observe`：会话 / 成员元数据审计与观察面诊断 —— 聊天与团队时间线**永不**出现
 *   （与开关无关），只在 Observe / Runs 看。
 *
 * 为什么要有这张表：旧实现是两张黑名单（`INTERNAL_EVENT_TYPES` / `CHAT_HIDDEN_EVENT_TYPES`）
 * 加一句「不在表里 ⇒ 可见」，于是**新增事件名 + 忘了登记 = 把 payload 原文推进聊天时间线**
 * （`agent.retired` / `agent.rotate.approved` / `agent.reply.stale` 就是这么漏的）。
 * 现在翻成白名单 + 三档，并且：
 *
 * - **未登记（`tierOf` 返回 `undefined`）按 `internal` 处理**：默认隐藏，展开时渲染成
 *   一条「未知类型 · 已折叠」notice（`buildGroup` 的 `default` 分支 + `EventRow` 的
 *   `noticeView`），**绝不落裸 JSON 卡**。这是对门禁管不到的边界（第三方插件 / 上游事件 /
 *   旧 trace）的兜底 —— 漏登记最坏也只是一行折叠的内部提示。
 * - **失败类永不进 `observe`**：任何集合都在 `ui.errorLevel` 之前过滤，塞进静默档等于
 *   静默真失败。`scripts/check-event-visibility.ts` 的 fixture 钉死这条（`observe` 里
 *   出现 `isErrorEventType` 就 FAIL）。
 *
 * **口径契约**：新增事件 → 先在这里登记（`live: true`），再在
 * `docs/architecture/events.md` 的 `event-visibility` marker 表里写一行；
 * `bun run check:event-visibility` 把「扫到未登记的事件名」「表里有、代码里没有」
 * 「文档与表不一致」「双链（团队日志 vs `SYSTEM_KEYS`）漂移」都变成 FAIL。
 * **不要在渲染层（`EventRow` / `StreamItems` / `run-detail`）另写可见性判断**。
 */
import { type ErrorVisibility, errorLevelOf, isErrorEventType } from './error-visibility';

export type EventTier = 'content' | 'internal' | 'observe';

/**
 * 承接方式 —— 「这条事件藏掉之后，用户还能在哪看到它」。
 *
 * 这是「能不能藏」的唯一依据：没有承接的 `content` 事件等于丢信息（`agent.reply.stale`
 * 就是反例：它是「旧身体那一轮回复为何作废」的唯一解释，所以必须 `content` + notice）。
 */
export type EventCarrier = 'notice' | 'card' | 'team-log' | 'dto';

/** 团队日志面的写入方式（服务端 `team-service.ts`）：system 行 / reply 行 / 不写。 */
export type EventTeamLog = 'system' | 'reply' | 'none';

export interface EventSpec {
  tier: EventTier;
  /** 本仓还有生产者。`false` = 只读历史（门禁的「表腐烂」反向断言用它）。 */
  live: boolean;
  /** 有 typed notice / 专用卡片 / 团队日志行 / DTO 承接（决定「能不能藏」）。 */
  承接?: EventCarrier;
  /** 团队日志面：服务端会不会为它写一行（默认 `none`）。 */
  teamLog?: EventTeamLog;
  /**
   * 保留原始事件行（`kind: 'event'`）是**正确的**。
   *
   * 只给 `guardrail.blocked` 这种「内容要在时间线上看到、但明细只能是原始事件」的类型；
   * 其余 `content` 类型必须有专用卡片或 typed notice（门禁 fixture 据此断言）。
   */
  rawCard?: true;
}

/**
 * 108 条（审计报告的 §2 全集）+ 6 条门禁扫出来的真实名字（`team.budget.override` /
 * `tool.permission.expired` / `delegate.*` 四条），共 114 条。
 *
 * 顺序按域分组（run/llm/tool → 上下文 → 会话/进程 → agent → 插件 → 子 agent），
 * 与 `docs/architecture/events.md` 的 marker 表同一顺序（门禁只比键集，顺序是人读的）。
 */
export const EVENT_TIERS: Readonly<Record<string, EventSpec>> = {
  // ── run / llm / tool：对话主体（content）
  'run.started': { tier: 'content', live: true, 承接: 'card' },
  'run.completed': { tier: 'content', live: true, 承接: 'card', teamLog: 'reply' },
  'run.failed': { tier: 'content', live: true, 承接: 'card', teamLog: 'system' },
  'run.cancelled': { tier: 'content', live: true, 承接: 'card', teamLog: 'system' },
  'run.finalize.failed': { tier: 'content', live: true, 承接: 'notice' },
  'user.message': { tier: 'content', live: true, 承接: 'card' },
  'llm.stream.chunk': { tier: 'content', live: true, 承接: 'card' },
  'tool.call.started': { tier: 'content', live: true, 承接: 'card' },
  'tool.call.completed': { tier: 'content', live: true, 承接: 'card' },
  'tool.call.failed': { tier: 'content', live: true, 承接: 'card' },
  // 工具 / 输入 / 输出被拦截：用户可理解的拦截结果，明细只有原始事件（保留原始行）。
  'guardrail.blocked': { tier: 'content', live: true, rawCard: true },
  'guardrail.error': { tier: 'content', live: true, 承接: 'notice' },
  // 限流 / 预算 80% 预警：用户必须能据此行动，**不要**降档。
  'agent.limit.warning': { tier: 'content', live: true, 承接: 'notice' },
  // 「旧身体这一轮回复产出过、但被 epoch fencing 丢弃」的唯一解释。团队日志对已退役
  // Binding 的 `run.completed` 是显式抑制的（`team-service.ts` `isRetiredBinding`），
  // 所以它必须默认可见，且以 typed notice 呈现（不得是裸 JSON，也不得静默藏掉）。
  'agent.reply.stale': { tier: 'content', live: true, 承接: 'notice' },

  // ── run / llm / tool 的内部信号（internal）
  // 协议遗留的裸错误事件（`ErrorPayload`）：今天靠 `errorLevel` 兜，显式登记只为将来换代。
  error: { tier: 'internal', live: false },
  // 单 hook 抛错后继续执行：过程信号，失败正文由 run / tool 终态承担。
  'hook.failed': { tier: 'internal', live: true },
  'hook.error': { tier: 'internal', live: true },
  'hook.started': { tier: 'internal', live: true, 承接: 'notice' },
  'hook.completed': { tier: 'internal', live: true, 承接: 'notice' },
  'hook.system_prompt_ignored': { tier: 'internal', live: true, 承接: 'notice' },
  'hook.additional_context_deprecated': { tier: 'internal', live: true, 承接: 'notice' },
  'llm.request': { tier: 'internal', live: true },
  'llm.response': { tier: 'internal', live: true },
  'llm.stream.summary': { tier: 'internal', live: true },
  'llm.retry': { tier: 'internal', live: true },
  'run.checkpoint': { tier: 'internal', live: true },
  'run.resumed': { tier: 'internal', live: true },

  // ── 上下文 / prompt / 上限：run 内部状态同步（internal）
  'context.changed': { tier: 'internal', live: true },
  'context.pressure': { tier: 'internal', live: true, 承接: 'notice' },
  'context.compacted': { tier: 'internal', live: true, 承接: 'notice' },
  // 上下文裁剪（工具结果被清）是 run 内部状态同步；用户可行动信号由 `context.compacted`
  // 与消息投影承担。
  'context.cleared_tool_result': { tier: 'internal', live: true },
  'message.injected': { tier: 'internal', live: true },
  'message.compaction': { tier: 'internal', live: true },
  'limit.blocked': { tier: 'internal', live: true },
  'prompt.prefix_changed': { tier: 'internal', live: true },
  'replay.started': { tier: 'internal', live: true },
  'replay.completed': { tier: 'internal', live: true },

  // ── 会话 / 持久化 / 进程（internal：诊断与状态同步）
  'session.saved': { tier: 'internal', live: true },
  'session.log.failed': { tier: 'internal', live: true },
  'process.error': { tier: 'internal', live: true },
  'shutdown.failed': { tier: 'internal', live: true },
  // 「trace 不完整」的标记；名字不以 `.failed` 结尾，靠后缀的 errorLevel 兜不住。
  'trace.write.failed': { tier: 'internal', live: true },
  'trace.overflow': { tier: 'internal', live: true },
  'plugin.failed': { tier: 'internal', live: true },
  'plugin.init.failed': { tier: 'internal', live: true },
  'plugin.dispose.failed': { tier: 'internal', live: true },
  'runtime.notice': { tier: 'internal', live: true },
  // 团队预算：预警 / 阻断 / 人工覆盖都是「同一笔预算怎么被改」的审计。有会话归属，
  // 所以是**真外泄**面；本轮按 `internal`（展开可见）落档，若产品要「可行动」应比照
  // `agent.limit.warning` 升成 notice —— 属产品裁决，先在表里显式声明。
  'team.budget.warning': { tier: 'internal', live: true },
  'team.budget.blocked': { tier: 'internal', live: true },
  'team.budget.override': { tier: 'internal', live: true },

  // ── agent 域：会话 / 成员元数据审计（observe）与生命周期诊断（internal）
  // 旧身体退役审计：`reason`（rotate / restart / close / 回收）**服务端 DTO 里没有**
  // （`packages/agent/src/types.ts` 的 `BindingHistoryEntry` 只有 `retired_at`），
  // 直接藏掉会让「为什么换身体」在 UI 里彻底不可见 —— 所以它是 `internal`
  // （默认隐藏、展开可见）**且带 typed notice**：notice 直接从事件 data 取
  // `reason` / `body_id` / `epoch` 渲染，不为它加跨包 DTO（`BindingHistoryEntry.reason`
  // 另开单）。
  'agent.retired': { tier: 'internal', live: true, 承接: 'notice' },
  // rotate 审批决策审计：批没批已由同一次工具调用的结果承接（工具卡，content 档）。
  'agent.rotate.approved': { tier: 'observe', live: true },
  'agent.rotate.denied': { tier: 'observe', live: true },
  'agent.updated': { tier: 'observe', live: true, 承接: 'dto' },
  'agent.role.changed': { tier: 'observe', live: true, 承接: 'dto' },
  'agent.rejoined': { tier: 'observe', live: true, 承接: 'dto', teamLog: 'system' },
  // body 退役导致权限请求失效：交互卡由 `interactions.list` 收口。
  'agent.permission.cancelled': { tier: 'observe', live: true },
  'agent.spawned': { tier: 'observe', live: true, 承接: 'team-log', teamLog: 'system' },
  'agent.closed': { tier: 'observe', live: true, 承接: 'team-log', teamLog: 'system' },
  'agent.message.queued': { tier: 'observe', live: true },
  'agent.message.notified': { tier: 'observe', live: false },
  'agent.message.sent': { tier: 'observe', live: false },
  'agent.stale': { tier: 'observe', live: true },
  'agent.permission.requested': { tier: 'observe', live: false },
  'agent.permission.responded': { tier: 'observe', live: false },
  'agent.session.activated': { tier: 'observe', live: true },
  'agent.queue.entered': { tier: 'observe', live: true },
  'agent.queue.left': { tier: 'observe', live: true },
  // 生命周期诊断里有 typed notice 的几条：notice 在 `EventRow.noticeView`，归 internal。
  'agent.rotating': { tier: 'internal', live: false, 承接: 'notice' },
  'agent.rotated': { tier: 'internal', live: false, 承接: 'notice', teamLog: 'system' },
  'agent.compact_forked': { tier: 'internal', live: false, 承接: 'notice' },
  'agent.restarting': { tier: 'internal', live: true, 承接: 'notice' },
  'agent.restarted': { tier: 'internal', live: true, 承接: 'notice' },
  // 失败类一律 internal（失败永不进静默档）：create 失败只做审计，但它是失败。
  'agent.create.failed': { tier: 'internal', live: true },
  'agent.rotate.failed': { tier: 'internal', live: false },
  // 旧 fork 事件只读（0.39 起 create 走 sessions.create），且团队日志有 `fork` 行承接：
  // 归 `observe`（与今天「永不进聊天」等价，不额外放宽）。
  'agent.forked': { tier: 'observe', live: false, 承接: 'team-log', teamLog: 'system' },

  // ── 会话 / 审批交互（observe：已有专用 UI 承接，原始行只是重复噪声）
  'session.created': { tier: 'observe', live: true },
  'session.activated': { tier: 'observe', live: false },
  'session.rewound': { tier: 'observe', live: false },
  'session.forked': { tier: 'observe', live: false },
  'session.titled': { tier: 'observe', live: true },
  'session.deleted': { tier: 'observe', live: true },
  'tool.permission.request': { tier: 'observe', live: true, 承接: 'card' },
  'tool.permission.response': { tier: 'observe', live: true, 承接: 'card' },
  'tool.permission.expired': { tier: 'observe', live: false, 承接: 'card' },
  'ask.user.requested': { tier: 'observe', live: true, 承接: 'card' },
  'ask.user.answered': { tier: 'observe', live: true, 承接: 'card' },
  'ask.user.timeout': { tier: 'observe', live: true, 承接: 'card' },

  // ── 装配 / 插件 / 联邦 / 观测（observe：不在会话叙事里）
  'config.loaded': { tier: 'observe', live: true },
  'plugin.loaded': { tier: 'observe', live: true },
  'plugin.changed': { tier: 'observe', live: true },
  'update.available': { tier: 'observe', live: true },
  'rpc.result_invalid': { tier: 'observe', live: true },
  'federation.received': { tier: 'observe', live: true },
  'federation.rejected': { tier: 'observe', live: true },
  // 遗留类型：只有 `EventRow` 的摘要分支认它，本仓已无生产者。
  'guardrail.modified': { tier: 'observe', live: false },
  'mcp.server.connected': { tier: 'observe', live: true },
  'mcp.server.disconnected': { tier: 'observe', live: true },
  'mcp.resource.read': { tier: 'observe', live: true },
  'mcp.tool.called': { tier: 'observe', live: true },
  'mcp.warning': { tier: 'observe', live: true },
  // MCP / 渠道的失败类是 `internal`（显式条目压过 `mcp.` / `channel.feishu.` 家族）：
  // 失败只对观测面有意义，但「永不出现」的 observe 档不允许放失败。
  'mcp.server.failed': { tier: 'internal', live: true },
  'mcp.tool.failed': { tier: 'internal', live: true },
  'channel.feishu.connected': { tier: 'observe', live: true },
  'channel.feishu.disconnected': { tier: 'observe', live: true },
  'channel.feishu.message.received': { tier: 'observe', live: true },
  'channel.feishu.reply.sent': { tier: 'observe', live: true },
  'channel.feishu.error': { tier: 'internal', live: true },
  'eval.run.started': { tier: 'observe', live: true },
  'eval.run.completed': { tier: 'observe', live: true },

  // ── 子 agent：前缀剥离后的名字（TUI 侧 `baseType()` 去 `subagent.` 后再 switch）
  // 线上名是 `subagent.delegate.started` 这一族（由下面的家族覆盖），这四条只是 TUI /
  // 旧 trace 里的消费形态，本仓没有独立生产者。档位跟随 `subagent.` 家族 = internal。
  'delegate.started': { tier: 'internal', live: false },
  'delegate_task.started': { tier: 'internal', live: false },
  'delegate.completed': { tier: 'internal', live: false },
  'delegate.failed': { tier: 'internal', live: false },
};

/**
 * 前缀家族（集合不可穷举，必须显式登记）。
 *
 * `subagent.<inner>` 是唯一已知的动态家族（`SubagentTranscript` 用 `slice` 还原内层名）；
 * 插件自定 `<domain>.*` 由各插件自己在 `EVENT_TIERS` 里登记，**不**在这里开家族。
 * 顺序有意义：先匹配者胜（`subagent.tool.call.started` 必须命中 `subagent.` 而不是
 * `tool.call.`）。家族里的失败类若要进 `internal`，必须写显式条目（条目优先于家族）。
 */
export const EVENT_TIER_FAMILIES: readonly { prefix: string; tier: EventTier }[] = [
  // 子 agent 的执行细节：默认隐藏，展开可见（`SubagentTranscript` 自己还有一层归一）。
  { prefix: 'subagent.', tier: 'internal' },
  { prefix: 'tool.call.', tier: 'content' },
  { prefix: 'mcp.', tier: 'observe' },
  { prefix: 'channel.feishu.', tier: 'observe' },
  { prefix: 'eval.run.', tier: 'observe' },
];

/** 事件类型 → 档位（未登记返回 `undefined`，由调用方按 `internal` 处理）。 */
export function tierOf(type: string): EventTier | undefined {
  const spec = EVENT_TIERS[type];
  if (spec !== undefined) return spec.tier;
  for (const family of EVENT_TIER_FAMILIES) {
    if (type.startsWith(family.prefix)) return family.tier;
  }
  return undefined;
}

/** 事件类型 → 完整元信息（家族命中的类型合成一份 `live: true` 的临时 spec）。 */
export function eventSpecOf(type: string): EventSpec | undefined {
  const spec = EVENT_TIERS[type];
  if (spec !== undefined) return spec;
  for (const family of EVENT_TIER_FAMILIES) {
    if (type.startsWith(family.prefix)) return { tier: family.tier, live: true };
  }
  return undefined;
}

export interface ChatVisibility {
  /** 已是 `showsInternalEvents()` 的结果（`showInternalEvents || verbosity === 'debug'`）。 */
  showInternal: boolean;
  errorLevel?: ErrorVisibility;
}

/**
 * 单条事件在会话时间线里是否可见（`groupEvents` / `EventGroupCache` 共用这一个判据）。
 *
 * - `content` ⇒ 恒可见；
 * - `observe` ⇒ 恒不可见（与开关无关）；
 * - `internal` / **未登记** ⇒ 仅 `showInternal` 时可见；`ui.errorLevel: all` 仍按旧语义
 *   放出 internal 级的失败类（非失败类的内部事件不因此解禁）。
 */
export function isVisibleInChat(type: string, options: ChatVisibility): boolean {
  const tier = tierOf(type);
  if (tier === 'observe') return false;
  if (tier === 'content') return true;
  if (options.showInternal) return true;
  const level = options.errorLevel ?? 'user';
  return level === 'all' && isErrorEventType(type) && errorLevelOf(type) === 'internal';
}
