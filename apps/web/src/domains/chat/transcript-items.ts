/**
 * 时间线的**单一 item 流**（纯函数，无 React / DOM）。
 *
 * 渲染不再分「运行态」与「终止态」两条路径：事件流和 sessions.get 都只是 item 的来源，
 * 同一个逻辑对象在两边都存在时是**同一个 item**（身份靠 key，不靠状态推断）。
 * 工具运行→结束只改 item 的字段，不产生新 item、不重挂。
 *
 * 身份命名：
 * - msg:<绝对下标>            历史消息（绝对下标 = detailWindow.start + 窗口内下标，前插不变）
 * - run:<runId>:text:<seq>    一次 run 的正文段（seq = 该段**首个** delta 的 wire seq；
 *                             流式尾巴与 flush 后是**同一个** seq，不因分段增多而换号）
 * - run:<runId>:reasoning:<seq> 第 n 段思考（同上，锚定首个 reasoning_delta 的 seq）
 * - tool:<callId>             工具调用（live 与 history 共用；无 callId 时 tool:run:<runId>:<key>）
 * - tool:orphan:<绝对下标>     只有结果、没有调用的历史 tool 消息
 * - notice:<item.key>         上下文 / 原始事件行
 * - ask-answered:<requestId>  已答提问的答复卡（服务端 answered 记录；不是消息，没有绝对下标）
 * - run:<runId>:input         run 的输入：人的输入（气泡）/ agent 投递（agent 卡）/
 *                             运行时上下文输入（`vessel:*` → 环境信息卡）/
 *                             rotate 交接嘱托（`rotate:handoff[:<epoch>]` → 交接卡）；
 *                             落盘后一律让位给历史那份
 * - run:<runId>:failure       一次 run 的失败卡（事件流优先，会话记录快照兜底）
 *
 * 段 key 为什么锚 seq 而不是段序（`text:<n>`）：段序是「第几个段」，回填把更早的一段插进来
 * 会让后面所有段换号 → React 整段重挂（动画重播）+ 认领错位。seq 是段在 wire 上的坐标，
 * 一个逻辑段的生命周期内恒定，且字典序 = 事件顺序 = `buildGroup` 的顺序。
 *
 * 去重 = **认领（claiming）**：按轮次顺序一对一匹配，每个 run 最多认领一条用户消息，
 * 每条消息最多被一个 run 认领；被认领的历史消息不再单独成 item（run 是权威来源）。
 * 认领的键分两层：**消息身份**（落盘消息的 `run_id` + `run_segment`，live 侧的
 * `segmentIndex`）优先 —— 它不受「正文被 Output guardrail 改写」影响，内容不同也让位，
 * 屏上以落盘那份为准；身份缺失（旧数据）或不唯一时才退回**内容相等**，那时认不出来
 * 就两边都渲染 —— 宁可重复，绝不吞消息。
 */
import type { Message, MessageRef, RunEvent } from '../../gateway/types';
import type { SessionDetail } from '../../gateway/types/sessions';
import type { ErrorMeta } from '../../state/error-visibility';
import type { RunGroup } from '../../state/events';
import type { HandoverRequest } from '../../state/live-items';
import { agentSenderOfName } from './agent-sender';
import {
  ASK_ANSWER_MESSAGE_NAME,
  type AskAnswerCard as AskAnswerData,
  askAnswerCard,
  isAskAnswerMessage,
} from './ask-answer';
import type { AnsweredAsk } from './ask-answered';
import {
  type EnvNoticeCard,
  envNoticeCard,
  isEnvNoticeKind,
  mergeEnvNoticeCards,
} from './env-notice';
import { buildHistoryToolItems } from './history-tools';
import { type RotateHandoff, rotateHandoffOf } from './rotate-handoff';
import { compareTimelineEntries } from './timeline-order';
import { type ChatRenderItem, foldToolItems, type ToolCardStatus } from './tool-cards';

export type TranscriptSpeaker = 'user' | 'assistant' | string;

/** 排序与分组共用的信封字段。 */
interface ItemMeta {
  key: string;
  /** 排序用的权威时间（可被窗口夹取掉）。 */
  ts?: number;
  /** 同 ts 的稳定回退（该 run 的首个 wire seq）。 */
  seq?: number;
  /**
   * 段 / 卡片在 wire 上的锚点 seq（= 该 item 首个事件的 seq）。
   *
   * 只有 live 侧有（历史消息没有 wire seq）。两个用途：
   * - **认领让位**的精确身份：`ClaimDecision.yieldedAnchors` 按它判定这一段要不要让位
   *   （段正文继续增长也不换号，所以让位结论一旦成立就稳定）；
   * - **交棒删除**的精确身份：`HandoverRequest.segments` 就是这些锚点。
   */
  anchorSeq?: number;
  /** 连续同发言人：本条是否是这一段的开头；非消息类没有这个字段。 */
  speaker?: TranscriptSpeaker;
  groupStart?: boolean;
}

export interface MessageItem extends ItemMeta {
  kind: 'message';
  absIndex: number;
  message: Message;
  /**
   * A2A 来源地址：从紧邻的 vessel:source 消息吸进来的。
   * 来源行不再单独成行，改为挂在这张 agent 卡的 meta 上。
   */
  sourceText?: string;
}

/**
 * 运行时提示（`vessel:notice` / `vessel:source` / 裸文本 `[inbox] …`）的可见形态。
 *
 * 它是**独立的 item kind**（不是 message）：这样它不可能落进用户气泡分支，
 * 与 hook 通知 / 原始事件行共用 notice 卡的观感。
 *
 * 两种显示方式（用户裁决）：`env` 有值 = 「环境信息」卡（默认可见，`vessel:notice`，
 * 见 `env-notice.ts`）；没有 `env` 的仍按 `isHidden` 跟随 `ui.showInternalEvents`。
 */
export interface RuntimeNoticeItem extends ItemMeta {
  kind: 'runtime-notice';
  /** `runtimeMessageKind` 的种类（notice / source / subscription / other …）。 */
  noticeKind: string;
  text: string;
  /** 该消息的绝对下标（可回链到 sessions.get，便于将来做详情/跳转）。 */
  absIndex?: number;
  /**
   * live 侧独有：这条上下文是某个 run 的**输入**（`run:<runId>:input`）。
   *
   * 有 runId 时它在历史落盘后让位（同一份输入由历史侧的 `notice:<下标>` 渲染），
   * 与 `RunInputItem` 的认领口径同一条规则 —— 否则同一条输入会出现两张卡。
   */
  runId?: string;
  /** 环境信息卡的解析结果（scope / 摘要 / 展开行 / 折叠条数）；非 notice 没有。 */
  env?: EnvNoticeCard;
}

export interface RunInputItem extends ItemMeta {
  kind: 'run-input';
  runId: string;
  text: string;
  /**
   * 这一轮的附件引用（0.52；只有路径）。来自 `user.message.message.refs`，
   * 与落盘后气泡上方那行 chip 是同一个组件、同一份数据。
   */
  refs?: MessageRef[];
  /**
   * 输入是 agent 投递时的发送者 alias（来自 `run.started.input_name` /
   * `user.message.message.name`，判定见 `agent-sender.ts`）。
   *
   * 有值 ⇒ 渲染 agent 卡；无值 ⇒ 用户气泡。渲染层不再自己判身份。
   */
  sender?: string;
}

/**
 * 「待批答复」item：async `ask` 的答案（0.52）。
 *
 * 身份来自 `Message.name === 'ask:answer'`（历史侧）与 `run.started.input_name`
 * （运行态）；解析失败时调用方**不产出这个 kind**，退回普通用户气泡 —— 宁可少一张卡，
 * 也不吞正文。它有 `runId` 是为了参与「run 的用户输入被历史消息认领后让位」那条规则。
 */
export interface AskAnswerItem extends ItemMeta {
  kind: 'ask-answer';
  /** 运行态来自 run 分组；历史消息没有 runId。 */
  runId?: string;
  /** 这条消息的完整正文（回退展示 / 复制用，与用户气泡同一份数据）。 */
  text: string;
  card: AskAnswerData;
}

/**
 * 「rotate 交接」item：新身体的第一条启动嘱托。
 *
 * 身份来自 `Message.name` 的 `rotate:handoff[:<epoch>]` 前缀（历史侧）与
 * `run.started.input_name`（运行态），解析见 `rotate-handoff.ts`。这条消息仍然是
 * **正常落盘的 user 消息**：它是该轮真实输入，正文就是新身体这一轮唯一的工作指令。
 * 本 item 只换表示层（交接卡而不是用户气泡），不复制、不改写正文。
 *
 * 有 `runId` 是为了参与「run 的用户输入被历史消息认领后让位」那条规则：同一个逻辑
 * 对象在 live 与历史里必须是同一个 item（同 ask-answer 的口径）。`epoch` 缺省 =
 * 消息名没带 / 读不懂，渲染层不写 epoch（不猜）。
 */
export interface RotateHandoffItem extends ItemMeta, RotateHandoff {
  kind: 'rotate-handoff';
  /** 运行态来自 run 分组；历史消息没有 runId。 */
  runId?: string;
  /** 这条消息的完整正文（与 `Message.content` 一字不差）。 */
  text: string;
}

/**
 * 「已答提问」item：sync ask 答完之后的那张可读答复卡（0.51 用户裁决）。
 *
 * 数据来源是**服务端 answered 记录**（`interactions.list{status:'answered'}`，见
 * `ask-answered.ts`），不是任何一条消息 —— 所以它没有 `absIndex`：`state.messages` 里
 * 没有哪一条是它，为它编一个绝对下标会让撤回 / 重试 / 认领这些按 messages 下标工作的
 * 逻辑把它当成一条真实存在的消息，那是往 0.50 收口的核心不变量里塞脏数据。
 *
 * 落位只靠 ts（= `answered_at`）：与消息 item 走同一个 `compareTimelineEntries`，
 * 同 `prompt-context` / `run-failure` 这两张同为「非消息来源」的卡一条规则。
 *
 * 身份 = `ask-answered:<requestId>`：requestId 是服务端落盘时盖的，重建（刷新 / 重连 /
 * 换端）读回同一条记录就是同一个 key，卡片不重挂、动画不重播。
 */
export interface AskAnsweredItem extends ItemMeta {
  kind: 'ask-answered';
  requestId: string;
  card: AskAnswerData;
}

export interface RunTextItem extends ItemMeta {
  kind: 'run-text';
  runId: string;
  text: string;
  /**
   * 这段正文是**本 run 的第几段**（0 起，只数正文段）。
   *
   * 与落盘消息的 `run_segment` 同一把尺子（0.51 消息身份）：内容被 Output guardrail
   * 改写之后，认领只能按身份认这一段（见 `ClaimSegment.segmentIndex`）。
   * 来自 fold 的计数器而不是 items 下标 —— 交棒删段 / 折叠砍项都不会让它前移。
   */
  segmentIndex?: number;
  /**
   * 这段正文是否仍在流式收字。
   *
   * 只影响 Markdown 的渲染策略（分档节流 + 未闭合块的保守降级，见
   * components/Markdown.tsx）；**不再**决定 Markdown vs 纯文本 —— 流式与落盘共用
   * 同一个组件，否则 run 结束那一刻整段会重排。
   */
  streaming: boolean;
}

export interface RunReasoningItem extends ItemMeta {
  kind: 'run-reasoning';
  runId: string;
  text: string;
  streaming: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface ToolItem extends ItemMeta {
  kind: 'tool';
  callId?: string;
  name: string;
  args?: unknown;
  output?: unknown;
  status: ToolCardStatus;
  /** live 侧来自哪个 run（历史工具无 runId）。 */
  runId?: string;
  error?: string;
  durationMs?: number;
  truncated?: boolean;
  startedAt: number;
  /** false = 有调用无结果 / 孤立结果（渲染 outputMissing）。 */
  paired: boolean;
}

export interface NoticeItem extends ItemMeta {
  kind: 'notice';
  event: RunEvent;
}

/**
 * 环境快照卡（**环境信息的一种，scope `context`**）的数据：`prompt.system_context` 事件的
 * 解析结果（**模型真正看到的那份系统消息**）。0.52 起它不再是「另一种卡」。
 *
 * 宗旨：**让模型可以看到的内容，用户也一样应该看到**，只不过用各种方法去让其简化
 * （UX、可收缩）。基底 system prompt + Self Card 以前只在请求组装时拼进 system
 * prompt，用户完全看不到；这条事件把原文落盘，这张卡把它折叠着摆到时间线上。
 *
 * 为什么是独立 item kind 而不是普通 notice 行：用户要的是「默认可见、但默认折叠的一张
 * 卡」，展开体是**两段原文**（不是 markdown，也不是原始 JSON 载荷）。notice 行承载不了
 * 这种层级（它的展开体是原始载荷）。
 *
 * 历史侧（刷新后）没有对应 message：它是事件，不是消息（`sessions.get.messages` 里
 * 永远不会有它）。刷新后仍能看到它，靠的是**事件回放时投影出同一个 item** —— 见
 * `buildLiveItems` 里 `prompt.system_context` 的分支。
 */
export interface PromptContextData {
  /** 系统消息的稳定摘要（sha256 前 16 位）：卡头短号 + 同 hash 去重的依据。 */
  hash: string;
  /** 基底 system prompt 原文（缺省 = 这一层没有基底 system）。 */
  systemPrompt?: string;
  /** Self Card 原文（≤400 tokens；缺省 = 未注入 Self Card）。 */
  selfCard?: string;
  /** 这一轮使用的模型 id。 */
  model?: string;
  /** 本次请求的消息条数（含 system）。 */
  messageCount?: number;
  /** 本次请求的工具个数。 */
  toolsCount?: number;
  /** 上下文窗口的 token 估算。 */
  estimatedTokens?: number;
  /** 上下文窗口上限（运行时真值）。 */
  contextMax?: number;
  /**
   * 与上一份快照差在哪（additive，0.52）：只列变了的项。
   *
   * **缺省 = 不知道**（该会话第一份快照 / 0.52 之前落盘的旧事件），卡片一律退回全量快照；
   * 只有拿到非空数组时才渲「N 项变更」。空数组在这里等价于缺省 —— 「没有变化」根本不会
   * 落成一条事件（同快照只发一次），所以「0 项变更」这个结论在线上并不存在。
   */
  changed?: string[];
  /** 上一份快照的 hash（additive；缺省同上 = 不知道）。 */
  previousHash?: string;
}

/** 环境快照卡 item：`prompt:<事件 key>`（key 稳定锚在事件 seq 上）。 */
export interface PromptContextItem extends ItemMeta, PromptContextData {
  kind: 'prompt-context';
  /**
   * live 侧来自哪个 run（这张卡按 run 归属）。
   *
   * detail 派生那条（刷新 / 重启后补出来的）只在服务端给了 `run_id` 时才有 —— 缺省表示
   * 「知道内容、但不知道是哪一轮」（那种情况下按 ts 落位就够，卡本身仍然可读）。
   */
  runId?: string;
}

/**
 * `prompt.system_context` → 卡片数据（**宽松解析**）。
 *
 * 载荷不成形（旧日志 / 第三方改写 / 缺 hash、或两段原文都没有）时返回 `undefined`，
 * 调用方退回普通 notice 行 —— 宁可少一张卡，也不吞掉这条事件、更不猜内容。
 * 不在这里做长度截断：原文就是模型看到的原文，截断等于改事实（渲染侧负责滚动）。
 */
export function promptContextOfEvent(event: RunEvent): PromptContextData | undefined {
  if (event.type !== 'prompt.system_context') return undefined;
  const data = event.data as Record<string, unknown> | null | undefined;
  if (data === null || typeof data !== 'object') return undefined;
  const hash = data.hash;
  if (typeof hash !== 'string' || hash.length === 0) return undefined;
  const rawSystem = data.system_prompt;
  const rawCard = data.self_card;
  const systemPrompt =
    typeof rawSystem === 'string' && rawSystem.length > 0 ? rawSystem : undefined;
  const selfCard = typeof rawCard === 'string' && rawCard.length > 0 ? rawCard : undefined;
  // 两段原文都没有 = 没有可展示的内容（只有 hash 的卡是空壳，不给用户看）。
  if (systemPrompt === undefined && selfCard === undefined) return undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;
  const model = data.model;
  const messageCount = num(data.message_count);
  const toolsCount = num(data.tools_count);
  const estimatedTokens = num(data.estimated_tokens);
  const contextMax = num(data.context_max);
  const changed = textListOf(data.changed);
  const previousHash =
    typeof data.previous_hash === 'string' && data.previous_hash.length > 0
      ? data.previous_hash
      : undefined;
  return {
    hash,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(selfCard !== undefined ? { selfCard } : {}),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(toolsCount !== undefined ? { toolsCount } : {}),
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(contextMax !== undefined ? { contextMax } : {}),
    ...(changed !== undefined ? { changed } : {}),
    ...(previousHash !== undefined ? { previousHash } : {}),
  };
}

/**
 * 只认「非空字符串数组」（`changed` 的宽松解析）；其它一律 `undefined` = 不知道。
 *
 * 空数组当「不知道」而不是「0 项变更」：两者给人看到的是完全不同的结论，前者是「没有
 * 可比对象」，后者是「对比过、没变化」。线上根本不会发「没变化」的事件。
 */
export function textListOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return undefined;
    list.push(item);
  }
  return list;
}

/** 失败卡的数据来源：事件流（`run.failed` 还在缓冲里）或会话记录快照（`sessions.get`）。 */
export type RunFailureSource = 'event' | 'session';

/**
 * 一次 run 的失败（时间线上唯一的失败卡数据）。
 *
 * 「同 run 只一张」由 key `run:<runId>:failure` 表达，两个来源共用同一个 key：
 * - `event`：`RunGroup` 的 `error` / `errorMeta`（`run.failed` 的原文 + 结构化 envelope）；
 * - `session`：`sessions.get` 投影的最近一次 run（`run_id` / `status` / `error` /
 *   `completed_at`）。**不新增 RPC**：这些字段服务端 `toSessionView` 早就在回，
 *   只是 Web 侧类型没收。
 *
 * 两个来源不会同时出场：`buildTranscriptItems` 只要发现事件流里有这个 runId 的
 * **任何**分组就以事件流为准（`source: 'event'`），见那里的去重注释。
 */
export interface RunFailure {
  runId: string;
  /** 该 run 的会话归属（运行详情深链用）。 */
  sessionId?: string;
  /** 错误原文；服务端没给时缺失（卡片回退「无错误详情」，不伪造文案）。 */
  error?: string;
  /** 结构化 envelope（只有 `run.failed` 事件带；快照路径没有）。 */
  errorMeta?: ErrorMeta;
  /** 终态时刻 = 失败卡的排序依据（事件 ts / 会话记录 `completed_at`）。 */
  completedAt?: number;
  source: RunFailureSource;
}

/** 失败卡 item：`run:<runId>:failure`。`runId` 在顶层，才能参与认领的 ts 夹取。 */
export interface RunFailureItem extends ItemMeta, RunFailure {
  kind: 'run-failure';
}

export type TranscriptItem =
  | MessageItem
  | RuntimeNoticeItem
  | RunInputItem
  | AskAnswerItem
  | AskAnsweredItem
  | RotateHandoffItem
  | RunTextItem
  | RunReasoningItem
  | ToolItem
  | NoticeItem
  | PromptContextItem
  | RunFailureItem;

/**
 * 事件流分组 → 失败卡数据（`undefined` = 这一组不是失败）。
 *
 * 只认 `status === 'failed'`：`run.completed` 会把 `error` 显式清掉（见
 * `state/events.ts` 的终态覆盖注释），所以「先 failed 又 completed」的 run 不会
 * 留下一条假的失败卡 —— 终态以最后一次为准。
 */
export function runFailureOfGroup(group: RunGroup): RunFailure | undefined {
  if (group.status !== 'failed') return undefined;
  return {
    runId: group.runId,
    ...(group.sessionId !== undefined ? { sessionId: group.sessionId } : {}),
    ...(group.error !== undefined ? { error: group.error } : {}),
    ...(group.errorMeta !== undefined ? { errorMeta: group.errorMeta } : {}),
    ...(group.completedAt !== undefined ? { completedAt: group.completedAt } : {}),
    source: 'event',
  };
}

/**
 * 会话详情（`sessions.get`）→ 失败卡数据（`undefined` = 最近一次 run 不是失败）。
 *
 * 为什么需要：历史（`sessions.get.messages`）里没有失败信息，事件缓冲又是有界的
 * （最新 1 MiB / 2000 条 per run、10000 条总量），刷新页面或切会话后 `run.failed`
 * 可能已经不在回放窗口里 —— 那时时间线上就什么都不剩了。会话投影里的最近一次 run
 * 是**落盘的**，因此刷新后仍在。
 *
 * 只认 `failed`：`interrupted`（挂起 / Host 中断）是可恢复状态，续跑入口在运行详情页
 * （`runs.resume`），不在聊天时间线上伪装成失败；`completed` / `cancelled` 同理。
 */
export function sessionFailureOfDetail(
  detail: SessionDetail | null | undefined,
): RunFailure | undefined {
  if (detail === null || detail === undefined) return undefined;
  if (detail.status !== 'failed') return undefined;
  const runId = detail.run_id;
  if (typeof runId !== 'string' || runId.length === 0) return undefined;
  const completedAt = detail.completed_at ?? detail.updated_at;
  const error = detail.error;
  return {
    runId,
    sessionId: detail.session_id,
    ...(typeof error === 'string' && error.length > 0 ? { error } : {}),
    ...(typeof completedAt === 'number' && Number.isFinite(completedAt) ? { completedAt } : {}),
    source: 'session',
  };
}

/**
 * 会话详情里的系统消息（`sessions.get.system_context`）→ 卡片数据。
 *
 * 比 `PromptContextData` 多两件只在 detail 路径上出现的东西：
 * - `runId`：服务端给了 `run_id` 时带上（客户端据此可以挂在那一轮上）；
 * - `at`：那条事件的时刻（detail 派生的 item 用它当排序 ts，否则只能沉到会话末尾）。
 */
export type SessionPromptContext = PromptContextData & { runId?: string; at?: number };

/**
 * 会话详情（`sessions.get.system_context`）→ 卡片数据（`undefined` = 没有可用数据）。
 *
 * 为什么需要：`prompt.system_context` 是**事件**，不是消息（`messages` 里永远没有它）。
 * 会话页正常运行靠 live 事件流（gateway 的内存环形缓冲回放），刷新 / 切会话 / 重连
 * 没问题；但**回放窗口淘汰 / 进程重启**之后，事件流里就没有它了 —— 那时只剩服务端从
 * 会话事件日志尾窗派生的这一个字段（`sessions.get`，见 `src/system-context.ts`）。
 *
 * 粒度：服务端只回**最近一条**（与失败卡的「最近一次 run 快照」对齐），所以这里补出来的
 * 也只有最新那一轮。**已知限制（不是 bug）**：更早轮次的卡刷新后不会回来。
 *
 * 与失败卡同一套去重规则：事件流里已经有**同 hash** 的卡就不再补 —— 两路同时存在时
 * 只出一张（hash 就是「同一份系统消息」的稳定身份，比 run id 更准：同一轮可能因为
 * 配置热应用换过一次）。
 */
export function sessionSystemContextOfDetail(
  detail: SessionDetail | null | undefined,
): SessionPromptContext | undefined {
  if (detail === null || detail === undefined) return undefined;
  const raw = detail.system_context;
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  if (typeof raw.hash !== 'string' || raw.hash.length === 0) return undefined;
  const systemPrompt =
    typeof raw.system_prompt === 'string' && raw.system_prompt.length > 0
      ? raw.system_prompt
      : undefined;
  const selfCard =
    typeof raw.self_card === 'string' && raw.self_card.length > 0 ? raw.self_card : undefined;
  // 两段原文都没有 = 空壳卡（服务端也会把这种当「没有数据」，这里再兜一层）。
  if (systemPrompt === undefined && selfCard === undefined) return undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;
  const model = raw.model;
  const runId = raw.run_id;
  const messageCount = num(raw.message_count);
  const toolsCount = num(raw.tools_count);
  const estimatedTokens = num(raw.estimated_tokens);
  const contextMax = num(raw.context_max);
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined;
  // 增量视图：缺省 = 不知道（旧数据 / 首次），卡片退回全量快照，不编「0 项变更」。
  const changed = textListOf(raw.changed);
  const previousHash =
    typeof raw.previous_hash === 'string' && raw.previous_hash.length > 0
      ? raw.previous_hash
      : undefined;
  return {
    hash: raw.hash,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(selfCard !== undefined ? { selfCard } : {}),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(toolsCount !== undefined ? { toolsCount } : {}),
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(contextMax !== undefined ? { contextMax } : {}),
    ...(typeof runId === 'string' && runId.length > 0 ? { runId } : {}),
    ...(at !== undefined ? { at } : {}),
    ...(changed !== undefined ? { changed } : {}),
    ...(previousHash !== undefined ? { previousHash } : {}),
  };
}

/** 一次 build 的输入。historyIndex / liveItems 由调用侧 memo 后传入（见文件头性能说明）。 */
export interface TranscriptBuildInput {
  /** 已加载的历史窗口（按消息顺序）。 */
  messages: readonly Message[];
  /** messages[0] 在完整 state.messages 里的绝对下标。 */
  messageIndexOffset: number;
  /** 事件缓冲里的 run 分组（可含未落盘的）。 */
  liveGroups: readonly RunGroup[];
  /** 可见窗口首条消息的 ts：更早的 live item 落到末尾。 */
  windowStartTs?: number;
  /** 历史消息是否应被隐藏（runtime 上下文可见性开关）；隐藏的仍参与下标与认领。 */
  isHidden?: (message: Message) => boolean;
  /** 这条消息属于哪种运行时提示（vessel:* 的种类）；返回 undefined = 普通消息。 */
  noticeKindOf?: (message: Message) => string | undefined;
  /** 预计算的历史索引（按 messages 引用 memo）；缺省内部现算。 */
  historyIndex?: HistoryIndex;
  /** 预计算的 live item（按 group 引用 memo）；缺省内部现算。 */
  liveItems?: readonly TranscriptItem[];
  /**
   * 会话记录快照里的失败（`sessions.get` 的最近一次 run，见 `sessionFailureOfDetail`）。
   *
   * 只在事件流里**没有**这个 runId 的任何分组时才会渲染 —— 事件流是实时事实，
   * 快照可能比它旧（同 run 只出一张卡，事件流优先）。
   */
  sessionFailure?: RunFailure;
  /**
   * 会话记录快照里的「模型这一轮看到了什么系统消息」（`sessions.get.system_context`，
   * 见 `sessionSystemContextOfDetail`）。
   *
   * 补的是**刷新 / 进程重启**这条路径：事件流里有同 hash 的卡时不再补（同 hash 只出一张）。
   * 服务端只回最近一条 ⇒ 更早轮次的卡不回补（已知限制）。
   */
  sessionSystemContext?: SessionPromptContext;
  /**
   * 服务端 answered 记录（`ask-answered.ts` 的映射结果，按 `answeredAt` 升序）。
   *
   * 为什么要走这条输入而不是像以前那样由会话页在时间线之后另画一段：已答提问是**历史上
   * 真发生过的一件事**，它的位置就是 `answered_at` 那个时刻 —— 堆在会话末尾等于把
   * 「几小时前答的一问」摆到最新消息之后（用户裁决：不接受这个额外段落）。
   *
   * 纯输入、不改任何既有判据：这里只多一种**没有 absIndex** 的 item kind，认领 /
   * 下标 / `hideInput` 的逻辑一行不碰（见 `AskAnsweredItem` 的说明）。
   */
  answeredAsks?: readonly AnsweredAsk[];
  /**
   * 认领结论（见 `HistoryIndex.claims`；两者给一个即可，`claims` 优先）。
   *
   * 通常是 `undefined`：装配面把结论挂在 `historyIndex.claims` 上（那条路不用改
   * `TranscriptWindow` 的签名）。本字段留给门禁与一次性调用直传。
   */
  claims?: ClaimDecision;
}

/** 历史侧索引：item 与「认领」用的反查表。 */
export interface HistoryIndex {
  /** 历史消息 item（不含被历史内部配对消耗掉的 tool 消息）。 */
  items: TranscriptItem[];
  /** 用户消息：内容 → 绝对下标（升序）。 */
  userByContent: Map<string, number[]>;
  /** 绝对下标 → 该消息里的 tool_call id 集合（assistant）。 */
  callIdsByIndex: Map<number, string[]>;
  /** 绝对下标 → 正文（assistant，用于和 run 输出比对）。 */
  contentByIndex: Map<number, string>;
  /** 绝对下标 → 消息（认领时回读）。 */
  messageByIndex: Map<number, Message>;
  /** 历史里出现过的 tool_call id（判断 run 是否已落盘）。 */
  callIds: Set<string>;
  /**
   * 段身份 → 落盘正文（0.51 消息身份）：`run_id` + `run_segment` 拼出来的键。
   *
   * 只收**会渲染的 assistant 正文**（隐藏消息 / 空正文 / 缺身份的旧数据都不进表）——
   * 身份认领的前提永远是「历史那份确实在屏上」，否则让位就是吞内容。
   */
  textBySegment: Map<string, string>;
  /**
   * 出现两次以上的段身份：同一个 `(run_id, run_segment)` 有两条消息 = 身份不可信。
   *
   * 这种数据只可能来自手改 / 半成品迁移。认领遇到它**按内容走**（既有路径），
   * 因为按身份让位会让其中一段被永久隐藏 —— 那是唯一不可恢复的方向。
   */
  ambiguousSegments: Set<string>;
  /** `run_id` → 该 run 的用户消息绝对下标（同一 run 可能有多条：注入消息 + 真实输入）。 */
  inputsByRun: Map<string, number[]>;
  /**
   * 认领结论（`ClaimLedger` 一次性判定 + 单调粘住的结果）。
   *
   * 为什么挂在索引上：认领**就是**「历史消息 ⇄ live run」的配对，`buildHistoryIndex`
   * 产出的反查表正是它的输入，而这份索引是调用侧唯一已经传到装配面（`TranscriptWindow`
   * → `buildTranscriptItems`）的历史侧对象。挂在别处（新增一层 prop）等于为了一个字段
   * 改三个文件；放在这里，纯函数侧的读取路径与「没有账本时现算一遍」的兜底完全同构。
   *
   * 缺省（undefined）= 一次性路径（门禁 / 子 agent 详情）：`buildTranscriptItems` 现算
   * 一遍同一段判据，只是不粘住。
   */
  claims?: ClaimDecision;
}

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

/**
 * 文本归一化后再比较「live 与历史是否同一段」：真实回放里常只差尾空白、CRLF 或多一个空行，
 * 直接相等判定会把重复段当成新段（正文/思考就出现两份）。
 */
function normalizeText(value: string | undefined): string {
  const unified = (value ?? '')
    .split(CR + LF)
    .join(LF)
    .split(CR)
    .join(LF);
  const out: string[] = [];
  let blanks = 0;
  for (const line of unified.split(LF)) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      blanks += 1;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(trimmed);
  }
  return out.join(LF).trim();
}
function trimText(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * runtime 上下文消息（模型侧上下文：来源行 / 提示 / 订阅 / 预算 / 压缩标记）的消息名前缀。
 *
 * 口径**必须**与 `state/runtime-visibility.ts` 的 `runtimeMessageKind` 一致（那边是权威：
 * `vessel:` 前缀，未知后缀归 other，非前缀返回 undefined）。这里不 import 它：本模块是
 * 纯函数（无 React / DOM / store），而 runtime-visibility 依赖 React + configStore，一旦
 * 引入就把 zustand / React 拖进纯计算与门禁脚本。改前缀时两边必须对账 —— 门禁 O8 守这条。
 */
export const RUNTIME_MESSAGE_PREFIX = 'vessel:';

/** A2A 来源行的消息名（与 runtimeMessageKind 的 source 种类一致）。 */
export const SOURCE_MESSAGE_NAME = `${RUNTIME_MESSAGE_PREFIX}source`;

/** 这条消息是不是 runtime 上下文（`vessel:*`）：模型侧上下文不是 turn 锚点。 */
export function isRuntimeContextMessage(message: Message): boolean {
  const name = message.name;
  return typeof name === 'string' && name.startsWith(RUNTIME_MESSAGE_PREFIX);
}

/**
 * 消息名 → runtime 上下文种类（`vessel:notice` → `notice`）；不是 runtime 上下文返回
 * undefined。live 侧的 run **输入**用它判身份（历史侧用 `runtimeMessageKind`）。
 *
 * 返回的是 `vessel:` 之后的后缀原文：渲染侧只关心「是不是 `notice`（环境信息卡）」，
 * 未知后缀仍会渲成运行时提示卡 —— 失败方向必须是「画成上下文」而不是「画成用户气泡」。
 */
function runtimeContextKindOfName(name: string | undefined): string | undefined {
  if (typeof name !== 'string' || !name.startsWith(RUNTIME_MESSAGE_PREFIX)) return undefined;
  const suffix = name.slice(RUNTIME_MESSAGE_PREFIX.length);
  return suffix.length > 0 ? suffix : 'other';
}

/** 从来源行正文取地址：location="a@node:team" → a@node:team。 */
export function sourceLocationOf(content: string): string | undefined {
  const match = /location="([^"]+)"/.exec(content);
  const value = match?.[1];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** 这条消息是否 A2A 来源行。 */
function isSourceMessage(message: Message): boolean {
  return message.name === SOURCE_MESSAGE_NAME;
}

/** 这条消息是否 agent 发来的（agent:<alias>）。判定只在 agent-sender.ts 一处。 */
function isAgentNamed(message: Message): boolean {
  return agentSenderOfName(message.name) !== undefined;
}

/**
 * 消息身份（0.51）：`run_id` + 段序 → 一个字符串键。
 *
 * 为什么段序要参与：一次 run 里可能有多段正文（每次带工具调用的迭代一段），只用
 * `run_id` 粒度太粗，会让第二轮正文去认第一轮那条消息。分隔符用不可能出现在 uuid /
 * 数字里的 `\u0000`，避免拼接歧义。
 */
function textSegmentKey(runId: string | undefined, segment: number): string | undefined {
  if (typeof runId !== 'string' || runId.length === 0) return undefined;
  return `${runId}\u0000${segment}`;
}

/** 消息的 `run_id`（空串 / 非字符串一律当「旧数据没有身份」）。 */
function identityRunId(message: Message): string | undefined {
  const runId = message.run_id;
  return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
}

/**
 * 这条 user 消息是不是**一张卡**而不是人打的字：A2A 投递（`agent:<alias>` → agent 卡）
 * 与 rotate 交接嘱托（`rotate:handoff[:<epoch>]` → 交接卡）。
 *
 * 身份判定复用**建 item 的同一组函数**（`agent-sender.ts` / `rotate-handoff.ts`），
 * 不在这里另写一份前缀匹配：名字判错就等于把卡当成人说的话，或者反过来。
 *
 * 给的第二处读点是 `Transcript.tsx` 的 `previousUserMessage`：这类消息不能当「前一条
 * 用户输入」（edit / retry 的锚点）—— 交接卡不是人打的字，能被编辑成别的内容或被重发，
 * 等于把伪造的改写伪装成一段真实发生的交接。**回退成普通消息的名字（例如
 * `rotate:handoffx`）不算卡**，与人打的字同等对待：它渲成气泡，也就该有气泡的操作。
 *
 * `vessel:*` 不在这里（它是运行时上下文，由 `runtimeMessageKind` / 可见性开关管）。
 */
export function isCardInputMessage(message: Message): boolean {
  if (agentSenderOfName(message.name) !== undefined) return true;
  return rotateHandoffOf(message.name) !== undefined;
}

/** 历史窗口 → item + 反查表（只依赖 messages 与 offset，调用侧可安全 memo）。 */
export function buildHistoryIndex(
  messages: readonly Message[],
  messageIndexOffset: number,
  isHidden?: (message: Message) => boolean,
  noticeKindOf?: (message: Message) => string | undefined,
): HistoryIndex {
  const items: TranscriptItem[] = [];
  const userByContent = new Map<string, number[]>();
  const callIdsByIndex = new Map<number, string[]>();
  const contentByIndex = new Map<number, string>();
  const messageByIndex = new Map<number, Message>();
  const callIds = new Set<string>();
  /** 段身份 → 落盘正文（认领的结构化一侧，见 `HistoryIndex.textBySegment`）。 */
  const textBySegment = new Map<string, string>();
  /** 出现两次以上的段身份（同 run 同段两条消息）⇒ 身份不可信（见 `ambiguousSegments`）。 */
  const ambiguousSegments = new Set<string>();
  /** `run_id` → 该 run 的用户消息绝对下标（认领时要求唯一，见 `HistoryIndex.inputsByRun`）。 */
  const inputsByRun = new Map<string, number[]>();
  /** 工具结果消息的时间（历史工具卡的权威 ts：结果落盘那一刻）。 */
  const toolResultTs = new Map<string, number>();

  // 可见性：隐藏的消息**不产生 item**，但仍要进 messageByIndex / contentByIndex
  // （绝对下标、认领、previous-user 都依赖它们）。
  const hidden = new Set<number>();
  if (isHidden !== undefined) {
    messages.forEach((message, index) => {
      if (isHidden(message)) hidden.add(messageIndexOffset + index);
    });
  }

  // A2A 来源行折叠：vessel:source 之后「下一条可见消息」是 agent 消息时，来源行不再
  // 单独成行，地址吸进那张 agent 卡（见 MessageItem.sourceText）。从后往前扫，O(n)。
  const foldedSourceByAgent = new Map<number, string>();
  const foldedSourceIndexes = new Set<number>();
  let nextVisible: { absIndex: number; message: Message } | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const absIndex = messageIndexOffset + index;
    const isHiddenMessage = hidden.has(absIndex);
    // 来源行的折叠与它自己是否可见无关：可见性只决定「不被吸收时它是否单独成行」，
    // 地址始终挂到后面那张 agent 卡上（用户要的是别丢信息，而不是别显示）。
    if (isSourceMessage(message)) {
      if (nextVisible !== undefined && isAgentNamed(nextVisible.message)) {
        const location = sourceLocationOf(message.content);
        if (location !== undefined) foldedSourceByAgent.set(nextVisible.absIndex, location);
        foldedSourceIndexes.add(absIndex);
        continue;
      }
      if (!isHiddenMessage) nextVisible = { absIndex, message };
      continue;
    }
    if (isHiddenMessage) continue;
    nextVisible = { absIndex, message };
  }

  // 历史工具消息：与 assistant 的 tool_calls 配对后各自成 item（tool:<callId>）。
  const historyTools = buildHistoryToolItems(messages);
  const toolByCallId = new Map<string, (typeof historyTools)[number]>();
  const orphanTools: { item: (typeof historyTools)[number]; index: number }[] = [];
  for (const tool of historyTools) {
    if (tool.callId !== undefined) {
      toolByCallId.set(tool.callId, tool);
      callIds.add(tool.callId);
    }
  }

  // ts carry：消息缺 timestamp（旧日志 / 迁移数据里的 assistant 段）时沿用**前一条**
  // （本遍历方向上最近的）已知 ts。不 carry 就会按「缺 ts 排最后」沉到末尾，把一轮对话
  // 的顺序拉反；前面没有任何已知 ts 时保持 undefined（缺省即未知，不造时间）。
  // carry 只喂给「消息自己的 item」（message / runtime-notice）：工具卡的时间走
  // toolResultTs / messageByIndex，认领回读（claimedUserTs）也不吃这份 carry。
  let carriedTs: number | undefined;

  messages.forEach((message, index) => {
    const absIndex = messageIndexOffset + index;
    // 先入索引：隐藏的消息仍要支撑绝对下标 / 认领 / previous-user 回读。
    messageByIndex.set(absIndex, message);
    // 隐藏 / 系统消息同样是日志里的一条：它们的 ts 就是时间轴上的前一个已知时刻。
    if (message.timestamp !== undefined) carriedTs = message.timestamp;
    const messageTs = message.timestamp ?? carriedTs;
    if (message.role === 'system') return;
    // 隐藏（runtime 上下文按可见性开关拦掉）：不进 item，也不参与用户输入认领。
    if (hidden.has(absIndex)) return;
    // 被 agent 卡吸收的来源行：不单独成行。
    if (isSourceMessage(message) && foldedSourceIndexes.has(absIndex)) return;

    if (message.role === 'tool') {
      const callId =
        typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
          ? message.tool_call_id
          : undefined;
      const paired = callId === undefined ? undefined : toolByCallId.get(callId);
      if (callId !== undefined && message.timestamp !== undefined) {
        toolResultTs.set(callId, message.timestamp);
      }
      if (paired !== undefined) {
        // 配对成功的 tool 消息由调用侧的 item 代表（下面根据 assistant 的 tool_calls 输出），
        // 这里只记录，不重复产出。
        return;
      }
      orphanTools.push({
        item: historyTools.find((tool) => tool.key === `history-tool-${index}`) ?? {
          key: `history-tool-${index}`,
          name: message.name ?? 'tool',
          output: message.content,
          status: 'neutral',
          paired: false,
        },
        index,
      });
      return;
    }

    if (message.role === 'user') {
      const text = trimText(message.content);
      const list = userByContent.get(text);
      if (list === undefined) userByContent.set(text, [absIndex]);
      else list.push(absIndex);
      // 身份：该 run 的用户消息下标（同一 run 可能有多条：注入消息 + 真实输入）。
      const userRunId = identityRunId(message);
      if (userRunId !== undefined) {
        const indexes = inputsByRun.get(userRunId);
        if (indexes === undefined) inputsByRun.set(userRunId, [absIndex]);
        else indexes.push(absIndex);
      }
    }

    const ids = (message.tool_calls ?? [])
      .map((call) => call.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) callIdsByIndex.set(absIndex, ids);
    for (const id of ids) callIds.add(id);
    if (message.role === 'assistant') {
      const content = trimText(message.content);
      contentByIndex.set(absIndex, content);
      // 身份：`(run_id, run_segment)` → 这一段正文的落盘版本（内容已被 guardrail 改写也照收）。
      // 同一个键出现第二条 ⇒ 身份不可信（标记成冲突，退回内容认领），绝不拿它去让人让位。
      const segment = message.run_segment;
      if (content.length > 0 && typeof segment === 'number' && Number.isFinite(segment)) {
        const key = textSegmentKey(message.run_id, segment);
        if (key !== undefined) {
          if (textBySegment.has(key)) ambiguousSegments.add(key);
          else textBySegment.set(key, content);
        }
      }
    }

    // 只有 tool_calls、没有正文的 assistant 消息不单独成 item（工具卡代表它）。
    const hasContent = trimText(message.content).length > 0;
    // 思考（thinking 模式的 reasoning_content）挂在**消息自己的 item** 上渲染（见
    // Transcript.tsx 的 TranscriptMessage），所以带思考的消息即使没有正文也要成 item，
    // 否则这段思考没有任何渲染入口 —— thinking 模式下「带工具调用的一轮」正文通常是空的，
    // 照旧跳过就等于把整轮思考吞掉（用户反馈的「丢了好几个思考内容」正是这个）。
    // 不画空气泡由渲染侧负责：没有正文时只渲思考块，不产出空正文节点。
    const hasReasoning =
      message.role === 'assistant' && trimText(message.reasoning_content).length > 0;
    const isAgentMessage = agentSenderOfName(message.name) !== undefined;
    if (message.role === 'assistant' && !hasContent && ids.length > 0 && !hasReasoning) return;
    if (!hasContent && message.role !== 'user' && !isAgentMessage && !hasReasoning) return;

    const sourceText = foldedSourceByAgent.get(absIndex);
    // 「rotate 交接」：新身体的第一条启动嘱托是**发起 rotate 的 agent** 写的
    // 交接书（内置 rotate 工具 → `input_name = rotate:handoff:<epoch>`），不是人打的字。
    // 数据照旧（那条 user 消息、正文一字不改），呈现换成交接卡；名字不合形状时退回
    // 普通消息（绝不吞正文）。
    const handoff = rotateHandoffOf(message.name);
    if (handoff !== undefined) {
      items.push({
        kind: 'rotate-handoff',
        key: `msg:${absIndex}`,
        text: message.content,
        ...handoff,
        ...(messageTs !== undefined ? { ts: messageTs } : {}),
      });
      return;
    }
    // 「待批答复」（0.52）：async ask 的答案是一条真正的 user 消息，但人是在待批页
    // 回答的 —— 数据照旧、呈现换成卡。解析不出来就当普通用户气泡（绝不吞正文）。
    const askAnswer = isAskAnswerMessage(message) ? askAnswerCard(message.content) : undefined;
    if (askAnswer !== undefined) {
      items.push({
        kind: 'ask-answer',
        key: `msg:${absIndex}`,
        text: message.content,
        card: askAnswer,
        ...(messageTs !== undefined ? { ts: messageTs } : {}),
      });
      return;
    }
    // 运行时提示（vessel:* 或裸文本 [inbox] …）：**独立成 notice 类 item**，
    // 不落进 message 分支 —— 否则它会以「用户气泡」出现（用户反馈的正是这条）。
    // 只看结构化的 name（vessel:*）：不按正文前缀猜 —— 用户可能自己粘一段以 [inbox] 开头的
    // 文本，按文本判定会把它吞成系统提示（隐藏或渲成通知卡）。
    const noticeKind = noticeKindOf?.(message);
    if (noticeKind !== undefined) {
      // 环境信息（vessel:notice）：解析成卡片数据（scope 标签 / 缩略 / 展开行）。
      // 解析失败（空正文 / 纯空白）时 env 缺省，渲染回退成整段文本的 notice 卡；
      // 老通道 `vessel:subscription`（0.52 起不再生产）走的正是这条兜底，仍是可读卡。
      const env = isEnvNoticeKind(noticeKind) ? envNoticeCard(message.content) : undefined;
      items.push({
        kind: 'runtime-notice',
        key: `notice:${absIndex}`,
        noticeKind,
        text: message.content,
        absIndex,
        ...(env !== undefined ? { env } : {}),
        ...(messageTs !== undefined ? { ts: messageTs } : {}),
      });
      return;
    }
    items.push({
      kind: 'message',
      key: `msg:${absIndex}`,
      absIndex,
      message,
      ...(sourceText !== undefined ? { sourceText } : {}),
      ...(messageTs !== undefined ? { ts: messageTs } : {}),
    });
  });

  // 历史工具 item：优先挂在「发起调用的 assistant 消息」位置（ts 用它的 timestamp）。
  for (const [absIndex, ids] of callIdsByIndex) {
    const message = messageByIndex.get(absIndex);
    for (const callId of ids) {
      const tool = toolByCallId.get(callId);
      if (tool === undefined) continue;
      // 历史没有事件流给的 duration：用「调用消息 -> 结果消息」的时间戳差推；
      // 两端缺一就不给（卡片头宁可不显示耗时，也不回退到绝对时间）。
      const durationMs =
        tool.startedAt !== undefined && tool.endedAt !== undefined
          ? Math.max(0, tool.endedAt - tool.startedAt)
          : undefined;
      items.push({
        kind: 'tool',
        key: `tool:${callId}`,
        callId,
        name: tool.name,
        ...(tool.args !== undefined ? { args: tool.args } : {}),
        ...(tool.output !== undefined ? { output: tool.output } : {}),
        status: 'done',
        startedAt: message?.timestamp ?? 0,
        paired: tool.paired,
        ...(durationMs !== undefined ? { durationMs } : {}),
        // ts 用「工具结果消息」的时间（历史侧的权威时刻）：比所属 assistant 消息的
        // timestamp 更贴近真实发生顺序（F19/F20 守这条）。
        ...((toolResultTs.get(callId) ?? message?.timestamp) !== undefined
          ? { ts: toolResultTs.get(callId) ?? message?.timestamp }
          : {}),
      });
    }
  }
  for (const { item, index } of orphanTools) {
    const absIndex = messageIndexOffset + index;
    items.push({
      kind: 'tool',
      key: `tool:orphan:${absIndex}`,
      name: item.name,
      ...(item.output !== undefined ? { output: item.output } : {}),
      status: 'done',
      startedAt: messageByIndex.get(absIndex)?.timestamp ?? 0,
      paired: false,
      ...(messageByIndex.get(absIndex)?.timestamp !== undefined
        ? { ts: messageByIndex.get(absIndex)?.timestamp }
        : {}),
    });
  }

  return {
    items,
    userByContent,
    callIdsByIndex,
    contentByIndex,
    messageByIndex,
    callIds,
    textBySegment,
    ambiguousSegments,
    inputsByRun,
  };
}

/**
 * 一条 live 渲染项自带的时间（用于推算 run 分组缺 ts 时的兜底定位）。
 *
 * 顺序调用下最先出现的工具/思考/事件时间就是这一组「最早发生」的时刻；正文流式段
 * 没有自身时间（它的时间等于 run 起始），所以不参与。
 */
function liveItemTs(item: ChatRenderItem): number | undefined {
  if (item.kind === 'tool' || item.kind === 'reasoning') return item.startedAt;
  if (item.kind === 'notice' || item.kind === 'event') return item.event.ts;
  return undefined;
}

/** run 分组 → live item（只依赖 group 对象，未变化的 group 可被调用侧 memo 命中）。 */
export function buildLiveItems(groups: readonly RunGroup[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const group of groups) {
    const folded = foldToolItems(group.items);
    // 组的定位时间：优先 run 起始；缺失时（事件被边界回放裁掉、只剩部分条目）
    // **用组内最早一个带时间的 item 兜底**，否则整组没有 ts → 排序规则「缺 ts 排最后」
    // 会把旧工具卡挂到比它们更新的内容后面（用户看到的「卡沉底」）。
    let baseTs = group.startedAt ?? group.firstTs;
    if (baseTs === undefined) {
      for (const item of folded) {
        const ts = liveItemTs(item);
        if (ts !== undefined && (baseTs === undefined || ts < baseTs)) baseTs = ts;
      }
    }
    // 每个 item 用**自己的事件时间**（真实发生时刻），不是组起始时间：
    // 统一披组起始 ts 会在历史回填时把整段 live 内容拽到 turn 开头，与历史侧
    // 的真实 ts 一对比就整段重排（用户看到的「上面一张卡、中间正文、下面更早的卡」）。
    const seqMeta = group.firstSeq !== undefined ? { seq: group.firstSeq } : {};
    // 段锚点表：`foldToolItems` 的输出是 `ChatRenderItem`（不带 anchorSeq），但 key 原样
    // 透传 —— 从 `group.items` 建一张 key → 首个 delta 的 seq 的表，段身份仍按 seq 走。
    const anchors = new Map<string, number>();
    // 段序表（同上理由：`ChatRenderItem` 可能不带 `segmentIndex`，但 key 透传）：
    // 身份认领要用「本 run 内第几段正文」，见 `ClaimSegment.segmentIndex`。
    const segmentsOf = new Map<string, number>();
    for (const item of group.items) {
      if (item.anchorSeq !== undefined) anchors.set(item.key, item.anchorSeq);
      if (item.kind === 'text' && item.segmentIndex !== undefined) {
        segmentsOf.set(item.key, item.segmentIndex);
      }
    }
    // 组内时间**单调**：每个 item 用自己事件时间，但不允许比前一个 item 更早
    // （时钟同毫秒/事件时间相同时用插入序，绝不因为 ts 抖动把顺序倒过来）。
    let monotonic: number | undefined;
    const itemTs = (own: number | undefined): number | undefined => {
      const candidate = own ?? baseTs;
      if (candidate === undefined) return monotonic;
      monotonic = monotonic === undefined ? candidate : Math.max(monotonic, candidate);
      return monotonic;
    };
    // run 的输入：历史里还没落盘时由它显示气泡；被历史消息认领后由 assemble 丢掉。
    // 身份随首个事件一起到（`run.started.input_name`）：agent 投递 = `agent:<alias>`
    // → agent 卡；运行时合成输入 = `vessel:*` → 运行时提示卡（环境信息），绝不画成
    // 用户气泡；rotate 交接嘱托 = `rotate:handoff[:<epoch>]` → 交接卡；
    // 都不是 = 人自己说的话 → 气泡。
    if (trimText(group.input).length > 0) {
      const text = group.input as string;
      const ts = itemTs(undefined);
      const tsPart = ts !== undefined ? { ts } : {};
      // rotate 交接嘱托在运行态就已知道身份（input_name = rotate:handoff:<epoch>），
      // 首帧就渲成交接卡，不会先闪一帧用户气泡。
      const handoff = rotateHandoffOf(group.inputName);
      // 0.52：async ask 的答案在运行态就已知道身份（input_name = ask:answer），
      // 首帧就渲成「待批答复」卡，不会先闪一帧用户气泡。
      const askAnswer =
        group.inputName === ASK_ANSWER_MESSAGE_NAME ? askAnswerCard(text) : undefined;
      // 运行时合成输入（idle 唤醒等）带 vessel:* 身份：渲成运行时提示卡（环境信息卡），
      // 绝不画成用户气泡。
      const noticeKind = runtimeContextKindOfName(group.inputName);
      if (handoff !== undefined) {
        items.push({
          kind: 'rotate-handoff',
          key: `run:${group.runId}:input`,
          runId: group.runId,
          text,
          ...handoff,
          ...tsPart,
          ...seqMeta,
        });
      } else if (askAnswer !== undefined) {
        items.push({
          kind: 'ask-answer',
          key: `run:${group.runId}:input`,
          runId: group.runId,
          text,
          card: askAnswer,
          ...tsPart,
          ...seqMeta,
        });
      } else if (noticeKind !== undefined) {
        const env = isEnvNoticeKind(noticeKind) ? envNoticeCard(text) : undefined;
        items.push({
          kind: 'runtime-notice',
          key: `run:${group.runId}:input`,
          // runId 让它在历史落盘后让位（同一条输入不出现第二张卡，见 assemble）。
          runId: group.runId,
          noticeKind,
          text,
          ...(env !== undefined ? { env } : {}),
          ...tsPart,
          ...seqMeta,
        });
      } else {
        const sender = agentSenderOfName(group.inputName);
        items.push({
          kind: 'run-input',
          key: `run:${group.runId}:input`,
          runId: group.runId,
          text,
          ...(sender !== undefined ? { sender } : {}),
          // 运行态气泡上方的 chip：与历史侧同一行组件，refs 到了就渲染。
          ...(group.inputRefs !== undefined ? { refs: group.inputRefs } : {}),
          ...tsPart,
          ...seqMeta,
        });
      }
    }
    let textIndex = 0;
    let reasoningIndex = 0;
    for (const item of folded) {
      if (item.kind === 'text') {
        const anchor = anchors.get(item.key);
        const segmentIndex = segmentsOf.get(item.key);
        items.push({
          kind: 'run-text',
          // 段身份 = 该段首个 delta 的 seq；没有锚点的手工分组退回段序（测试 / 子 agent 用）。
          key: `run:${group.runId}:text:${anchor ?? textIndex}`,
          runId: group.runId,
          text: item.text,
          streaming: false,
          // 段锚点：认领让位与交棒删除都按它认这一段（见 `ItemMeta.anchorSeq`）。
          ...(anchor !== undefined ? { anchorSeq: anchor } : {}),
          // 段序：与落盘消息的 `run_segment` 对身份用（0.51）。没有它的手工分组
          // （测试 / 子 agent）落回下面的局部 `textIndex`，行为与之前一致。
          segmentIndex: segmentIndex ?? textIndex,
          // 正文段用最后一个 delta 的时间（该段结束时刻）。
          ...(itemTs(item.endedAt ?? item.startedAt) !== undefined
            ? { ts: itemTs(item.endedAt ?? item.startedAt) }
            : {}),
          ...seqMeta,
        });
        textIndex += 1;
        continue;
      }
      if (item.kind === 'reasoning') {
        const anchor = anchors.get(item.key);
        items.push({
          kind: 'run-reasoning',
          key: `run:${group.runId}:reasoning:${anchor ?? reasoningIndex}`,
          runId: group.runId,
          text: item.text,
          streaming: false,
          // 段锚点（同上：让位与交棒按它认这一段）。
          ...(anchor !== undefined ? { anchorSeq: anchor } : {}),
          ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
          ...(item.endedAt !== undefined ? { endedAt: item.endedAt } : {}),
          // 思考段用最后一个 reasoning_delta 的时间（该段结束时刻）。
          ...(itemTs(item.endedAt ?? item.startedAt) !== undefined
            ? { ts: itemTs(item.endedAt ?? item.startedAt) }
            : {}),
          ...seqMeta,
        });
        reasoningIndex += 1;
        continue;
      }
      if (item.kind === 'tool') {
        items.push({
          kind: 'tool',
          key:
            item.callId !== undefined
              ? `tool:${item.callId}`
              : `tool:run:${group.runId}:${item.key}`,
          ...(item.callId !== undefined ? { callId: item.callId } : {}),
          runId: group.runId,
          name: item.name,
          ...(item.args !== undefined ? { args: item.args } : {}),
          ...(item.result !== undefined ? { output: item.result } : {}),
          status: item.status,
          ...(item.error !== undefined ? { error: item.error } : {}),
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          ...(item.truncated === true ? { truncated: true } : {}),
          startedAt: item.startedAt,
          paired: item.status !== 'running',
          // 卡片的锚点（交棒时按 callId 删，这里留一份便于诊断与门禁对拍）。
          ...(item.anchorSeq !== undefined ? { anchorSeq: item.anchorSeq } : {}),
          // 工具卡用自己的 tool.call.started 时间（真事件时间）。
          ...(itemTs(item.startedAt) !== undefined ? { ts: itemTs(item.startedAt) } : {}),
          ...seqMeta,
        });
        continue;
      }
      // `prompt.system_context`：「模型这一轮看到了什么系统消息」的专用卡（默认折叠）。
      // 这是**唯一**把该事件变成一张卡的地方 —— live 与回放（含刷新后的订阅回填）都走
      // 这条 `buildLiveItems`，所以两路出的是同一个 item、同一个 key。
      // 载荷不成形（旧日志 / 第三方改写）时退回普通 notice 行：宁可少一张卡，不吞事件。
      if (item.event.type === 'prompt.system_context') {
        const prompt = promptContextOfEvent(item.event);
        if (prompt !== undefined) {
          const promptTs = itemTs(item.event.ts);
          items.push({
            kind: 'prompt-context',
            // key 锚事件 seq（`item.key` = `ev-<seq>` / `notice-<seq>`）：回放重放同一事件
            // 不会换 key，卡片不重挂、动画不重播。
            key: `prompt:${item.key}`,
            runId: group.runId,
            ...prompt,
            ...(promptTs !== undefined ? { ts: promptTs } : {}),
            ...seqMeta,
          });
          continue;
        }
      }
      // notice / 原始事件：逐条一个 item，不参与分组。
      items.push({
        kind: 'notice',
        key: `notice:${item.key}`,
        event: item.event,
        ts: item.event.ts,
        ...(group.firstSeq !== undefined ? { seq: group.firstSeq } : {}),
      });
    }
    // 尾部未闭合段：key 用**它自己首个 delta 的 seq**（与 flush 后的同一段共用 key，
    // 见 check-transcript-items 的 F2）。没有锚点的手工分组退回段序。
    if (group.liveText !== undefined && group.liveText.length > 0) {
      items.push({
        kind: 'run-text',
        key: `run:${group.runId}:text:${group.liveTextAnchorSeq ?? textIndex}`,
        runId: group.runId,
        text: group.liveText,
        streaming: true,
        ...(group.liveTextAnchorSeq !== undefined ? { anchorSeq: group.liveTextAnchorSeq } : {}),
        ...(itemTs(group.lastTs) !== undefined ? { ts: itemTs(group.lastTs) } : {}),
        ...seqMeta,
      });
    }
    if (group.liveReasoning !== undefined && group.liveReasoning.length > 0) {
      items.push({
        kind: 'run-reasoning',
        key: `run:${group.runId}:reasoning:${group.liveReasoningAnchorSeq ?? reasoningIndex}`,
        runId: group.runId,
        text: group.liveReasoning,
        streaming: true,
        ...(group.liveReasoningAnchorSeq !== undefined
          ? { anchorSeq: group.liveReasoningAnchorSeq }
          : {}),
        ...(itemTs(group.lastTs) !== undefined ? { ts: itemTs(group.lastTs) } : {}),
        ...seqMeta,
      });
    }
    // 失败卡：一条 run 只会有一张（key 与快照路径共用 `run:<runId>:failure`）。
    // 位置 = `run.failed` 自己的事件时间（终态时刻），走 itemTs 的单调钳制，因此必然
    // 落在该 run 最后一个 item 之后，而同一条 **真实 ts** 又不会把它拽到整个会话底部
    // （「缺 ts 排最后」只在 completedAt 也没有时才发生，那时最后一格就是正确位置）。
    const failure = runFailureOfGroup(group);
    if (failure !== undefined) {
      const failureTs = itemTs(failure.completedAt);
      items.push({
        kind: 'run-failure',
        key: `run:${group.runId}:failure`,
        ...failure,
        ...(failureTs !== undefined ? { ts: failureTs } : {}),
        ...seqMeta,
      });
    }
  }
  return items;
}

/** 一段 live 正文 / 思考（认领与交棒的最小单位）。 */
export interface ClaimSegment {
  kind: 'text' | 'reasoning';
  text: string;
  /** 该段首个 delta 的 wire seq（段身份；没有锚点的手工分组才缺）。 */
  anchorSeq?: number;
  /**
   * 这一段是**本 run 的第几段正文**（0 起；只有 kind='text' 有）。
   *
   * 与落盘消息的 `run_segment` 同一把尺子：内容被 guardrail 改写后，只有它还能证明
   * 「live 这一段就是落盘那一条」。缺失（手工分组 / 旧事件回放）⇒ 该段只走内容认领。
   */
  segmentIndex?: number;
}

/**
 * run 侧认领事实（DESIGN.md §7.4 的 `RunFacts`）：**只从 `RunGroup` 派生**，不读
 * `entries`、不重建 item。
 *
 * 为什么是 `RunGroup` 而不是 `TranscriptItem`：认领要回答的是「这一轮的内容在历史里
 * 去哪了」，段 / 调用 / 输入 / 输出都能从 run 的 item 里读到；而组的读取路径与渲染
 * 同源（`useChatTranscript` 的 `renderedGroups`），所以装配面判一次就够，**不用为了
 * 判定再物化一份 item**（那正是本设计要消灭的「第二次投影」）。
 */
export interface ClaimRunFacts {
  runId: string;
  status: RunGroup['status'];
  /** 输入正文（trim 后）。空 = 这一轮没有可认领的输入。 */
  input: string;
  /** 输出（`run.completed.output`；缺失时用已流出的第一段正文兜底）。 */
  output: string;
  running: boolean;
  startTs?: number;
  /** live 里出现过的工具调用 callId（有历史同 key 卡片才算有替身）。 */
  callIds: readonly string[];
  /** live 的正文 / 思考段，按出现顺序。 */
  segments: readonly ClaimSegment[];
}

/** `RunGroup[]` → 认领事实（按 run 起始时间升序 = 认领的轮次顺序）。 */
export function claimRunFactsOf(groups: readonly RunGroup[]): ClaimRunFacts[] {
  const facts = groups.map((group) => {
    const cached = FACT_CACHE.get(group);
    if (cached !== undefined) return cached;
    const fact = claimRunFactsOfGroup(group);
    FACT_CACHE.set(group, fact);
    return fact;
  });
  return facts.sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
}

/**
 * 按 group 对象缓存事实：`RunGroup` 是**不可变快照**（`LiveItemStore.materialize` 只在
 * 该 run 脏时换新对象），所以流式期间只有正在跑的那几个 run 需要重算 —— 装配面每帧
 * 判一次认领的成本与「正在跑的 run 数」成正比，与历史轮数无关。
 */
const FACT_CACHE = new WeakMap<RunGroup, ClaimRunFacts>();

function claimRunFactsOfGroup(group: RunGroup): ClaimRunFacts {
  const callIds: string[] = [];
  const segments: ClaimSegment[] = [];
  let fallbackOutput = '';
  for (const item of group.items) {
    if (item.kind === 'tool') {
      if (item.callId !== undefined) callIds.push(item.callId);
      continue;
    }
    if (item.kind !== 'text' && item.kind !== 'reasoning') continue;
    segments.push({
      kind: item.kind,
      text: item.text,
      ...(item.anchorSeq !== undefined ? { anchorSeq: item.anchorSeq } : {}),
      ...(item.kind === 'text' && item.segmentIndex !== undefined
        ? { segmentIndex: item.segmentIndex }
        : {}),
    });
    // 正文：run.completed.output 缺失时用**已流出的第一段正文**兜底（同一段文本即可认领）。
    if (item.kind === 'text' && fallbackOutput.length === 0) fallbackOutput = item.text;
  }
  // 尾部仍在流式中的缓冲也算 live 内容（它同样可能已经落盘）。
  if (group.liveText !== undefined && group.liveText.length > 0) {
    segments.push({
      kind: 'text',
      text: group.liveText,
      ...(group.liveTextAnchorSeq !== undefined ? { anchorSeq: group.liveTextAnchorSeq } : {}),
      // 尾巴的段序由 fold 直接给（flush 之后是同一个号，不换号）。
      ...(group.liveTextSegmentIndex !== undefined
        ? { segmentIndex: group.liveTextSegmentIndex }
        : {}),
    });
  }
  if (group.liveReasoning !== undefined && group.liveReasoning.length > 0) {
    segments.push({
      kind: 'reasoning',
      text: group.liveReasoning,
      ...(group.liveReasoningAnchorSeq !== undefined
        ? { anchorSeq: group.liveReasoningAnchorSeq }
        : {}),
    });
  }
  const startTs = group.startedAt ?? group.firstTs;
  return {
    runId: group.runId,
    status: group.status,
    input: trimText(group.input),
    output: trimText(group.output).length > 0 ? trimText(group.output) : trimText(fallbackOutput),
    running: group.status === 'running',
    ...(startTs !== undefined ? { startTs } : {}),
    callIds,
    segments,
  };
}

/**
 * 认领失败 / 重复候选的**累计**计数（diagnostics 读这里 —— 它是「位置认领要不要打开」
 * 的取数依据，见 DESIGN.md §4.2-6）。
 *
 * 为什么必须记：位置认领（按 turn 位置而不是内容认领）唯一要权衡的是「重复 vs 吞内容」，
 * 而重复的量级今天没有任何数字支撑。这里把「内容对不上」按次累计，将来（加上真机样本）
 * 才有依据判断重复是不是到了「用户可感知」的量级。
 */
export interface ClaimStats {
  /** 判定次数（首次 + 每一次失效重判；账本粘住期间不增加）。 */
  decisions: number;
  /** 输入认领失败次数：run 有输入，但历史里找不到未被占用的同文消息。 */
  userMisses: number;
  /** 输出认领失败次数：run 有输出，但一条 assistant 消息都没认领上。 */
  assistantMisses: number;
  /** 终态 run 里**没让位**的正文段条数（= 潜在重复的两份渲染）。 */
  unclaimedSegments: number;
  /**
   * 按**身份**让位、但落盘正文与流式原文不同的段数（0.51）。
   *
   * 这就是「guardrail 改写被识别出来了」的痕迹：屏上展示的是落盘那份（打码后），
   * 差异本身不吞、也不在 UI 上喊 —— 计数在这里留底，是这条路径唯一的对外证据。
   * 身份缺失（旧数据）时不会增长（那时走内容比较）。
   */
  rewrittenSegments: number;
}

/**
 * 认领账本的一次判定结论（DESIGN.md §4.2）。
 *
 * 方向恒为「live 让位、历史永不隐藏」（I8）：这些集合只描述**live 这一份**要不要让位
 * / 能不能移出内存，没有任何字段能让历史那份消失。所以判错最坏是「多一份」（可见、
 * F5 可恢复），不会「少一份」（静默）。
 */
export interface ClaimDecision {
  /** 已认领的用户消息：run → 绝对下标（每轮最多一条，按轮次顺序一对一）。 */
  claimedUserByRun: ReadonlyMap<string, number>;
  /** 已认领的 assistant 消息（绝对下标）。 */
  claimedAssistant: ReadonlySet<number>;
  /**
   * 让位的 live **正文段 / 思考段**（按 `anchorSeq`）。
   *
   * 单调只增：live 内容继续增长**不会**让已成立的认领失效（消除「两帧之间来回让位」）。
   * 段身份锚定首个 delta 的 seq，所以重折叠 / 回填都不换号。
   */
  yieldedAnchors: ReadonlySet<number>;
  /** 让位的段正文（归一化后）：只给「没有 anchor 的手工分组」兜底。 */
  yieldedTexts: ReadonlySet<string>;
  /**
   * 可以移出 live 内存的 item（按 run 分组，`HandoverRequest` 直接就是 store 的入参）。
   *
   * 只有「已经让位的正文段 / 思考段」会进来；`notice` / `ev-` / 失败卡与工具卡永远不在
   * （前两者没有历史替身；工具卡的执行态历史侧不复现，见 `computeHandover` 的说明）。
   */
  handover: ReadonlyMap<string, HandoverRequest>;
  /** 累计计数（同一次判定内不变；见 `ClaimStats`）。 */
  stats: ClaimStats;
}

/** `ClaimLedger.decide` 的输入（历史侧 + live 侧事实 + 交棒前置条件）。 */
export interface ClaimDecideInput {
  /** 历史侧索引（认领的权威一侧）。 */
  history: HistoryIndex;
  /** live 侧事实（`claimRunFactsOf(renderedGroups)`）。 */
  facts: readonly ClaimRunFacts[];
  /**
   * detail 是否已经是「当前选中会话的、非 stale 的历史」。
   *
   * 交棒的四个前置之一（DESIGN.md §4.3）：detail 没到 / 已经 stale 时，历史那份可能
   * 只是旧副本，此时**一件都不许交棒**（屏上内容只能靠 live）。
   */
  detailReady: boolean;
  /** 会话快照里的失败 runId（失败卡替身判据：同 runId 才算有替身）。 */
  failureRunId?: string;
}

/**
 * 认领账本的身份（DESIGN.md §4.2 的失效条件）。
 *
 * 只有这五个字段变化才**丢弃**结论重判：
 * - `epoch` 变（重连 / 连接级 hello）；
 * - `history` 引用变（`reloadAfterHistoryChange`：`session.rewound` / `message.compaction`
 *   改写前缀，或 `mergeTailPage` 缩短尾部 —— 调用侧按 messages 引用 memo，所以「引用换了」
 *   就是「窗口换了一份历史」）；
 * - `sessionId` 变（切会话）；
 * - `windowStart` / `windowEnd` 变（历史窗口本身换了；`loadEarlier` 前插不改绝对下标，
 *   但窗口身份变了，重判一次最省心）。
 *
 * **不在**这里的东西（故意）：live 内容（正文长度 / 工具数量 / output 增长）。它们变了
 * 不重判 —— 这正是「已成立的认领不会因 live 增长而失效」。
 */
export interface ClaimIdentity {
  sessionId: string | null;
  epoch: number;
  windowStart?: number;
  windowEnd?: number;
  /** `buildHistoryIndex` 的结果（引用身份 = 「messages 窗口」的身份）。 */
  history: HistoryIndex;
}

function emptyClaimStats(): ClaimStats {
  return {
    decisions: 0,
    userMisses: 0,
    assistantMisses: 0,
    unclaimedSegments: 0,
    rewrittenSegments: 0,
  };
}

interface ClaimCore {
  claimedUserByRun: Map<string, number>;
  claimedAssistant: Set<number>;
  yieldedAnchors: Set<number>;
  yieldedTexts: Set<string>;
}

/**
 * 认领：把「live 里已经有的事件」与「历史里刚出现的那条消息」对成同一个逻辑对象。
 *
 * 一对一、按轮次顺序：每个 run 最多认领一条用户消息（同一句话连发两次时按顺序取
 * 未认领的下一条），每条消息最多被一个 run 认领；assistant 消息按 callId 子集或
 * 正文相等/包含认领，允许一个 run 认领它自己的多条迭代。
 *
 * ⚠️ **位置认领（按 turn 位置而不是内容认领）刻意没有打开**（main 裁决 3）：它能彻底
 * 消掉 guardrail 改写造成的重复，但风险是**对称的** —— 位置判错就是「吞内容」，而重复
 * 顶多让人看见两遍（I8 的方向恒为「宁可重复，绝不吞内容」）。打开它的前置条件缺一不可：
 * ① 服务端给 turn 边界一个权威 id（今天只有 `cursor` 可猜）；
 * ② 认领账本能证明「历史那份**确实会渲染**」（本账本：让位只发生在历史真的持有那段
 *    内容时，`stats.userMisses / assistantMisses` 是它的取数面）；
 * ③ 有 fixture 证明「位置认领 + guardrail 改写」不会让正文消失。
 *
 * **0.51：前置条件 ①②③ 现在由「消息身份」满足**，位置认领的近似物已经落地：落盘消息带
 * `run_id` + `run_segment`（服务端盖章，见 core `assignMessageIdentities`），live 段带
 * `segmentIndex`（fold 的计数器）。同一身份 ⇒ 同一段 ⇒ **内容不同也让位**（落盘权威，
 * 被 guardrail 打码过就展示打码后的），差异记进 `stats.rewrittenSegments` 留痕。
 * 身份缺失 / 不唯一（旧数据、注入消息与真实输入并存、撞号）⇒ 退回内容路径，**不猜**。
 */
function computeClaimCore(
  history: HistoryIndex,
  facts: readonly ClaimRunFacts[],
  stats: ClaimStats,
): ClaimCore {
  const claimedUser = new Set<number>();
  const claimedUserByRun = new Map<string, number>();
  let cursor = -Infinity;
  for (const fact of facts) {
    if (fact.input.length === 0) continue;
    // ① 身份认领：历史里属于**这个 run** 的用户消息只有一条时，它就是这一轮的输入。
    //    为什么要求唯一：一次 run 可以有多条 user 消息（`RunOptions.messages` 注入 +
    //    真实输入），拿错一条就会把真正的输入藏起来，而历史那条渲染的是别的内容。
    const byIdentity = uniqueInputOfRun(history, fact.runId, claimedUser);
    if (byIdentity !== undefined) {
      claimedUser.add(byIdentity);
      claimedUserByRun.set(fact.runId, byIdentity);
      cursor = Math.max(cursor, byIdentity);
      continue;
    }
    const candidates = history.userByContent.get(fact.input) ?? [];
    const target = candidates.find((index) => index >= cursor && !claimedUser.has(index));
    if (target === undefined) {
      // 内容对不上（guardrail 改写过正文 / 历史还没落盘）：**两边都渲染**，只计数。
      stats.userMisses += 1;
      continue;
    }
    claimedUser.add(target);
    claimedUserByRun.set(fact.runId, target);
    cursor = target;
  }

  const claimedAssistant = new Set<number>();
  for (const fact of facts) {
    const from = claimedUserByRun.get(fact.runId) ?? cursor;
    if (fact.output.length === 0) continue;
    let hits = 0;
    for (const [absIndex, content] of history.contentByIndex) {
      if (absIndex <= from || claimedAssistant.has(absIndex)) continue;
      if (content !== fact.output && !(content.length >= 8 && fact.output.includes(content))) {
        continue;
      }
      claimedAssistant.add(absIndex);
      hits += 1;
    }
    for (const [absIndex, ids] of history.callIdsByIndex) {
      if (absIndex <= from || claimedAssistant.has(absIndex)) continue;
      if (!(ids.length > 0 && ids.every((id) => fact.callIds.includes(id)))) continue;
      claimedAssistant.add(absIndex);
      hits += 1;
    }
    // 一条都没认领上 = 这一轮的正文可能与历史重复（两份都渲，但记一笔）。
    if (hits === 0) stats.assistantMisses += 1;
  }

  // 已落盘的 assistant 正文：live 的同文段让位（它就是那条消息，不许两份）。
  const claimedTexts = new Set<string>();
  for (const absIndex of claimedAssistant) {
    const content = history.contentByIndex.get(absIndex);
    if (content !== undefined && content.length > 0) claimedTexts.add(normalizeText(content));
  }
  // 已落盘的 assistant 思考：同样按内容让位（历史消息自己带 reasoning_content）。
  const claimedReasonings = new Set<string>();
  for (const message of history.messageByIndex.values()) {
    const reasoning = (message as { reasoning_content?: string }).reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
      claimedReasonings.add(normalizeText(reasoning));
    }
  }

  const yieldedAnchors = new Set<number>();
  const yieldedTexts = new Set<string>();
  for (const fact of facts) {
    // 本 run 内撞号的段序（同一个号出现两次）⇒ 这个号不可信，该号只走内容认领。
    const tripped = repeatedSegmentIndexes(fact.segments);
    let unclaimed = 0;
    for (const segment of fact.segments) {
      const text = normalizeText(segment.text);
      if (text.length === 0) continue;
      const identity =
        segment.kind === 'text'
          ? identityOfSegment(history, fact.runId, segment, tripped)
          : undefined;
      const byContent =
        segment.kind === 'text' ? claimedTexts.has(text) : claimedReasonings.has(text);
      if (!byContent && identity === undefined) {
        if (segment.kind === 'text') unclaimed += 1;
        continue;
      }
      // 内容路径命中时把正文也记进 `yieldedTexts`（没有锚点的手工分组靠它兜底）。
      // 身份命中**不**记正文：那会让「同一段文字」在别处也被藏起来，而身份只对本段成立。
      if (byContent) yieldedTexts.add(text);
      if (segment.anchorSeq !== undefined) yieldedAnchors.add(segment.anchorSeq);
      // 留痕：身份命中、但落盘正文与流式原文不同 = 这一段被 guardrail 改写过。
      if (identity !== undefined && normalizeText(identity) !== text) stats.rewrittenSegments += 1;
    }
    // 终态 run 里没让位的正文段 = 潜在的「live + 历史」两份渲染。
    if (fact.running || fact.output.length === 0) continue;
    stats.unclaimedSegments += unclaimed;
  }
  return { claimedUserByRun, claimedAssistant, yieldedAnchors, yieldedTexts };
}

/**
 * 身份认领的关键一问：这一轮（run）的输入在历史里是不是**唯一**一条 user 消息？
 *
 * 返回它的绝对下标；不唯一 / 没有 / 已被别的 run 认领 ⇒ undefined（调用侧退回内容认领）。
 */
function uniqueInputOfRun(
  history: HistoryIndex,
  runId: string,
  claimedUser: ReadonlySet<number>,
): number | undefined {
  const indexes = history.inputsByRun.get(runId);
  if (indexes === undefined || indexes.length !== 1) return undefined;
  const only = indexes[0];
  if (only === undefined || claimedUser.has(only)) return undefined;
  return only;
}

/** 这一段正文按身份能不能认出来：返回落盘正文（用了身份就返回，否则 undefined）。 */
function identityOfSegment(
  history: HistoryIndex,
  runId: string,
  segment: ClaimSegment,
  tripped: ReadonlySet<number>,
): string | undefined {
  const index = segment.segmentIndex;
  if (index === undefined || tripped.has(index)) return undefined;
  const key = textSegmentKey(runId, index);
  if (key === undefined || history.ambiguousSegments.has(key)) return undefined;
  return history.textBySegment.get(key);
}

/** 本 run 里出现两次以上的正文段序（撞号 = 身份不可信，见 `HistoryIndex.ambiguousSegments`）。 */
function repeatedSegmentIndexes(segments: readonly ClaimSegment[]): Set<number> {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const segment of segments) {
    if (segment.kind !== 'text' || segment.segmentIndex === undefined) continue;
    if (seen.has(segment.segmentIndex)) repeated.add(segment.segmentIndex);
    else seen.add(segment.segmentIndex);
  }
  return repeated;
}

/**
 * 交棒清单：哪些 item 已经有历史替身、可以移出 live 内存（DESIGN.md §4.3 / §8.1）。
 *
 * 逐 **item** 判定（不是整 run 丢弃），四个条件全部成立才进清单：
 * 1. `detailReady`（历史是当前会话的、非 stale 的那一份）；
 * 2. run 已终态（`running` 一律不交棒：它还会继续长）；
 * 3. 失败卡例外：`failed` 的 run 只有当**会话快照能提供同一张卡**
 *    （`sessionFailure.runId === run.runId`，key 相同 `run:<id>:failure`，故不重挂）
 *    时才允许交棒 —— 否则这一轮永远留在 live 侧（一张卡的内存换「失败永远可见」）；
 * 4. item 自己**确实有替身**：正文段 / 思考段已经让位（`yieldedAnchors`，历史那份
 *    正在渲染同一段正文）。
 *
 * **为什么只有正文 / 思考段**：交棒的硬要求是「屏幕上零变化」。一段正文让位之后 live
 * 这份**根本不在渲染**，删它按定义零变化；而工具卡的执行态（`status` / `durationMs` /
 * `truncated`）历史侧不复现（历史只有「调用 + 结果」两条消息，耗时是时间戳推算的），
 * 删掉 live 那份会让卡上的耗时 / 截断标记变样 —— 那不是零变化，所以这一档**不放开**
 * （要等服务端给出 run/段锚点，让历史侧能携带执行态；DESIGN.md 裁决 3 的触发条件 a）。
 * `notice` / `ev-` / `unknown-` 是运行过程，没有替身，永远不交棒。
 */
function computeHandover(
  facts: readonly ClaimRunFacts[],
  yieldedAnchors: ReadonlySet<number>,
  input: ClaimDecideInput,
): Map<string, HandoverRequest> {
  const handover = new Map<string, HandoverRequest>();
  if (!input.detailReady) return handover;
  for (const fact of facts) {
    if (fact.status === 'running') continue;
    if (fact.status === 'failed' && input.failureRunId !== fact.runId) continue;
    const segments: number[] = [];
    for (const segment of fact.segments) {
      if (segment.anchorSeq === undefined) continue;
      if (yieldedAnchors.has(segment.anchorSeq)) segments.push(segment.anchorSeq);
    }
    if (segments.length > 0) handover.set(fact.runId, { segments });
  }
  return handover;
}

/**
 * 一次性判定（无账本路径：门禁 / 子 agent 详情 / 缺省的 `buildTranscriptItems`）。
 *
 * 与账本走**同一段**判据，只是不粘住（每次调用都重新算）。它是纯函数，所以「增量 ==
 * 重建」的对拍仍然成立。
 */
export function oneShotClaims(
  history: HistoryIndex,
  facts: readonly ClaimRunFacts[],
): ClaimDecision {
  const stats = emptyClaimStats();
  stats.decisions = 1;
  const core = computeClaimCore(history, facts, stats);
  return {
    ...core,
    handover: new Map<string, HandoverRequest>(),
    stats,
  };
}

/**
 * 认领账本：**一次性判定 + 单调（sticky）+ 明确失效**（DESIGN.md §4.2）。
 *
 * 为什么必须粘住：今天每次渲染都用内容相等重算认领，而物化之后 live item 的生命周期
 * 变长了（不再随环裁剪消失）—— 于是 live 正文一继续增长（或 guardrail 改写正文），
 * 内容就不再相等，认领结论在两帧之间抖动：
 * - **重复**：认领失败 → live 与 history 各渲一份；
 * - **闪现**：同一段内容一会儿让位一会儿不让位（key 切换 = React 重挂）。
 *
 * 账本把这些结论**冻结**在「历史窗口变化」这一格上：只要 `ClaimIdentity` 没变（也没有
 * 出现新 run / 新终态），后续 live 内容怎么长都不影响已经成立的让位。
 *
 * 失效点（只有三个 + 两个一次性转换）：
 * 1. `epoch` 变（重连）；
 * 2. 历史窗口引用 / 窗口边界变（rewind / compaction / mergeTailPage）；
 * 3. `sessionId` 变（切会话）；
 * 4. 出现**新 run**（新的一轮必须能认领它自己的消息）；
 * 5. run **一次性**转终态 / 第一次拿到输入（这两个转换各只发生一次，不是内容抖动）。
 */
export class ClaimLedger {
  private identity: ClaimIdentity | null = null;
  private decision: ClaimDecision | null = null;
  private readonly seen = new Set<string>();
  private readonly settled = new Set<string>();
  private readonly fed = new Set<string>();
  private readonly counters = emptyClaimStats();

  /** 最近一次判定之后累计的计数（diagnostics 读这里；账本粘住时不增加）。 */
  get stats(): ClaimStats {
    return this.counters;
  }

  decide(identity: ClaimIdentity, input: ClaimDecideInput): ClaimDecision {
    const invalidated = this.identity === null || !sameClaimIdentity(this.identity, identity);
    const rerun = invalidated || this.needsRunRerun(input.facts);
    if (!rerun && this.decision !== null) return this.decision;
    this.counters.decisions += 1;
    const core = computeClaimCore(input.history, input.facts, this.counters);
    const handover = computeHandover(input.facts, core.yieldedAnchors, input);
    const fresh: ClaimDecision = { ...core, handover, stats: this.counters };
    // 身份没变（只是新 run / 终态 / 输入到达）：与上一次结论**取并集**，绝不撤销。
    this.decision =
      invalidated || this.decision === null ? fresh : unionClaimDecisions(this.decision, fresh);
    this.identity = identity;
    for (const fact of input.facts) {
      this.seen.add(fact.runId);
      if (fact.status !== 'running') this.settled.add(fact.runId);
      if (fact.input.length > 0) this.fed.add(fact.runId);
    }
    return this.decision;
  }

  /** 五个一次性转换（新 run / 转终态 / 首次拿到输入）：各只触发一次，不是内容抖动。 */
  private needsRunRerun(facts: readonly ClaimRunFacts[]): boolean {
    for (const fact of facts) {
      if (!this.seen.has(fact.runId)) return true;
      if (fact.status !== 'running' && !this.settled.has(fact.runId)) return true;
      if (fact.input.length > 0 && !this.fed.has(fact.runId)) return true;
    }
    return false;
  }
}

function sameClaimIdentity(a: ClaimIdentity, b: ClaimIdentity): boolean {
  return (
    a.history === b.history &&
    a.sessionId === b.sessionId &&
    a.epoch === b.epoch &&
    a.windowStart === b.windowStart &&
    a.windowEnd === b.windowEnd
  );
}

/** 单调合并：身份没变时的重判只许**加**，不许撤销已经成立的让位 / 交棒。 */
function unionClaimDecisions(previous: ClaimDecision, fresh: ClaimDecision): ClaimDecision {
  const claimedUserByRun = new Map(previous.claimedUserByRun);
  for (const [runId, absIndex] of fresh.claimedUserByRun) {
    if (!claimedUserByRun.has(runId)) claimedUserByRun.set(runId, absIndex);
  }
  const yieldedAnchors = new Set(previous.yieldedAnchors);
  for (const anchor of fresh.yieldedAnchors) yieldedAnchors.add(anchor);
  const yieldedTexts = new Set(previous.yieldedTexts);
  for (const text of fresh.yieldedTexts) yieldedTexts.add(text);
  const handover = new Map(previous.handover);
  for (const [runId, request] of fresh.handover) {
    const before = handover.get(runId);
    handover.set(runId, {
      segments: [...new Set([...(before?.segments ?? []), ...request.segments])],
    });
  }
  return {
    claimedUserByRun,
    claimedAssistant: new Set([...previous.claimedAssistant, ...fresh.claimedAssistant]),
    yieldedAnchors,
    yieldedTexts,
    handover,
    stats: fresh.stats,
  };
}

/** 这一段 live 正文 / 思考是否已经让位给历史（锚点优先，缺锚点时回落内容）。 */
function isYielded(
  decision: ClaimDecision,
  item: { kind: string; text: string; anchorSeq?: number },
): boolean {
  if (item.anchorSeq !== undefined && decision.yieldedAnchors.has(item.anchorSeq)) return true;
  return decision.yieldedTexts.has(normalizeText(item.text));
}

/**
 * 同 key 合并（**身份的唯一实现**）：一个逻辑对象在多个来源里出现时只留一个 item。
 *
 * 工具卡的取值规则（HANDOFF 的「合并内容规则」）：
 * - 内容（name / args / output）：**history ∪ live，history 优先**（落盘值权威，不带 8KiB 预览
 *   截断）；history 缺了才回落 live。`name === 'tool'` 是「不知道名字」的兜底值，不算内容。
 * - 执行态（status / durationMs / error / truncated）：取 **live**；`paired` 取或；
 *   `startedAt` 取 live 中 >0 者。
 * - 位置与 ts：取 **history**（F18 主 oracle：merged 的历史子序列必须等于只有历史的序列）。
 *
 * 其它 kind：后到者覆盖（live 是最新事实）。
 */
function mergeByKey(
  items: readonly TranscriptItem[],
  historyKeys?: ReadonlySet<string>,
): TranscriptItem[] {
  const byKey = new Map<string, TranscriptItem>();
  const order: string[] = [];
  for (const item of items) {
    const previous = byKey.get(item.key);
    if (previous === undefined) {
      byKey.set(item.key, item);
      order.push(item.key);
      continue;
    }
    byKey.set(item.key, mergeItem(previous, item, historyKeys));
  }
  return order
    .map((key) => byKey.get(key))
    .filter((item): item is TranscriptItem => item !== undefined);
}

/** 工具名「不知道」时的兜底值（`history-tools.ts` / `tool-cards.ts` 都用它填空）。 */
const TOOL_NAME_FALLBACK = 'tool';

function mergeItem(
  previous: TranscriptItem,
  next: TranscriptItem,
  historyKeys?: ReadonlySet<string>,
): TranscriptItem {
  // 调用侧**先 push 全部历史 item、再 push live item**，所以同 key 时 previous 恒为历史侧、
  // next 恒为 live 侧。位置以历史为权威，前提就是这条 push 序（REVIEW §2.1-F：反序会让
  // 同毫秒的先后改由 live 的插入序决定）。previous 来自历史 = 它的 key 出现在历史 item 里。
  const previousIsHistory = historyKeys?.has(previous.key) === true;
  if (previous.kind === 'tool' && next.kind === 'tool') {
    // 内容：history ∪ live，history 优先。兜底名不算内容，所以历史是兜底值时让 live 的真名顶上。
    const name = previous.name === TOOL_NAME_FALLBACK ? next.name : previous.name;
    const args = previous.args !== undefined ? previous.args : next.args;
    const output = previous.output !== undefined ? previous.output : next.output;
    return {
      ...previous,
      name,
      ...(next.runId !== undefined ? { runId: next.runId } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(output !== undefined ? { output } : {}),
      // 执行态取 live（历史 item 是「已落盘」的快照，running→done 的真实态只在 live）。
      status: next.status,
      ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
      ...(next.error !== undefined ? { error: next.error } : {}),
      ...(next.truncated === true ? { truncated: true } : {}),
      startedAt: next.startedAt > 0 ? next.startedAt : previous.startedAt,
      paired: previous.paired || next.paired,
      // 时间以**历史**为准（previous 是历史侧，先入数组）：顺序的唯一权威是历史；
      // 用 min/max 混合 live 与 history 的时间正是把顺序拉坏的根源。
      // 「历史没有 ts」也照样沿用 undefined —— 那是「只有历史」时的排序结果，不许被 live 改写。
      ts: previousIsHistory ? previous.ts : (previous.ts ?? next.ts),
    };
  }
  return { ...previous, ...next, key: previous.key };
}

/**
 * 单一 item 流（纯函数）。
 *
 * 复杂度：历史侧 item / 反查表由  按  引用 memo；live 侧 item
 * 由  按 group 对象 memo（未变化的 run 直接命中缓存）。每次调用只剩
 * O(认领扫描 + 合并 + 排序)，与 50ms 的流式节拍无关的重建都发生在引用变化时。
 */
export function buildTranscriptItems(input: TranscriptBuildInput): TranscriptItem[] {
  const history =
    input.historyIndex ??
    buildHistoryIndex(input.messages, input.messageIndexOffset, input.isHidden, input.noticeKindOf);
  const live = input.liveItems ?? buildLiveItems(input.liveGroups);
  // 认领结论：装配面（`useChatTranscript`）用 `ClaimLedger` 一次性判定并粘住，挂在
  // `historyIndex.claims` 上（见 `HistoryIndex.claims` 的说明）；没有账本的一次性路径
  // （门禁 / 子 agent 详情）现算一遍同一段判据 —— 两条路径只有「粘不粘」的区别。
  const decision =
    input.claims ?? history.claims ?? oneShotClaims(history, claimRunFactsOf(input.liveGroups));
  const { claimedUserByRun } = decision;
  /** run → 是否仍在跑（弱下限的 ts 夹取用；内容项本身不再参与认领计算）。 */
  const runState = new Map<string, { running: boolean }>();
  for (const group of input.liveGroups) {
    runState.set(group.runId, { running: group.status === 'running' });
  }

  // 弱下限的锚点：**人说的最后一句**的 ts。runtime 上下文（`vessel:*`）也是 role 'user'，
  // 但它是模型侧上下文、不是 turn 锚点 —— 算进去会把「运行中且自己没有 ts」的 run 拖到
  // 上下文消息之后（run 其实比那条提示早开始）。判定与 notice 卡 / 可见性同一口径。
  const lastUserTs = (() => {
    let last: number | undefined;
    for (const [, message] of history.messageByIndex) {
      if (message.role !== 'user' || isRuntimeContextMessage(message)) continue;
      if (message.timestamp === undefined) continue;
      if (last === undefined || message.timestamp > last) last = message.timestamp;
    }
    return last;
  })();

  // 没有「live 已经有这个调用就跳过历史 item」的预过滤：那会让 `mergeItem` 的工具分支
  // 永远不可达（内容只能取 live 的 8KiB 预览），客户端漏掉 `tool.call.completed` 时
  // 落盘输出整块丢失（G1）。历史 item 一律保留，live 的同 key item 由 mergeByKey 合并。

  const items: TranscriptItem[] = [];
  for (const item of history.items) {
    // 被认领的 assistant 消息**照常保留**（位置 / key / 操作按钮都以历史为准）；
    // 让位的是 live 侧的同文段（见认领账本的 `yieldedAnchors` / `yieldedTexts`），
    // 这样两边顺序一致。
    // 思考同理：历史消息的 reasoning_content 由 Transcript.tsx 的 TranscriptMessage 渲染，
    // live 侧同一份思考按内容让位，所以不会双出。
    // 历史已落盘的调用**照常保留**：位置与 ts 由历史决定，live 只补充执行态
    // （key 相同，`mergeByKey` 会合并）。丢掉历史这一条会让顺序与「只有 history」不一致。
    items.push(item);
  }

  for (const item of live) {
    const runId = 'runId' in item ? item.runId : undefined;
    // 输入已被历史消息认领：历史那条负责渲染，run 侧那份丢弃（绝不两个气泡 / 两张卡）。
    // 四种输入共用这条规则：人的输入（run-input）、async ask 的答案（ask-answer）、
    // rotate 交接嘱托（rotate-handoff）、运行时上下文输入（runtime-notice 带 runId，
    // 如 idle 唤醒的 vessel:notice）。
    if (runId !== undefined && claimedUserByRun.has(runId)) {
      if (item.kind === 'run-input') continue;
      if (item.kind === 'runtime-notice') continue;
      if (item.kind === 'ask-answer') continue;
      if (item.kind === 'rotate-handoff') continue;
    }
    const state = runId === undefined ? undefined : runState.get(runId);
    if (state === undefined) {
      items.push(item);
      continue;
    }
    // 这段正文对应的 assistant 消息已经落盘 → 由历史消息负责渲染（位置、key、操作按钮
    // 都是历史的），live 只在前者不存在时出现。**不改 key、不合并**，所以
    // order(live+history) 的 key 序列与 order(history only) 一致。
    //
    // 判据是**账本里的让位集合**（按段锚点），不是「这一帧的内容相等」：正文继续增长
    // 不会让已成立的让位失效（DESIGN.md §4.2 规则 1，消除抖动型重复）。
    if ((item.kind === 'run-text' || item.kind === 'run-reasoning') && isYielded(decision, item)) {
      continue;
    }
    const claimedUser = runId === undefined ? undefined : claimedUserByRun.get(runId);
    const claimedUserTs =
      claimedUser === undefined ? undefined : history.messageByIndex.get(claimedUser)?.timestamp;
    // 强下限（认领到的用户消息）总是生效：run.started 比用户消息落盘早几毫秒。
    // 弱下限（最后一条用户消息）只在 item 自己没有 ts 时兜底 —— 否则「早于可见窗口的
    // 旧 run 卡片」会被拽到新卡片后面，屏幕上时间看起来倒序（F9 守这一条）。
    const strong = claimedUserTs !== undefined ? claimedUserTs + 1 : undefined;
    const weak =
      state.running && item.ts === undefined && lastUserTs !== undefined
        ? lastUserTs + 1
        : undefined;
    const floor = strong ?? weak;
    const base =
      floor === undefined ? item.ts : item.ts === undefined ? floor : Math.max(item.ts, floor);
    items.push({ ...item, ts: base });
  }

  // 会话记录快照里的失败卡：刷新 / 切会话后事件缓冲里可能已经没有 `run.failed`，
  // 而历史消息不携带失败信息 —— 不补这一张，用户只能进运行详情才知道这一轮失败了。
  // 去重只有一条规则：**事件流里出现这个 runId 的任何分组**（运行中 / 失败 / 已完成）
  // ⇒ 以事件流为准，快照那条不渲染。同 run 恰好一张卡，且实时态不会被旧快照盖掉。
  const sessionFailure = input.sessionFailure;
  if (
    sessionFailure !== undefined &&
    !input.liveGroups.some((group) => group.runId === sessionFailure.runId)
  ) {
    items.push({
      kind: 'run-failure',
      key: `run:${sessionFailure.runId}:failure`,
      ...sessionFailure,
      // 排序依据是落盘的终态时刻：它一定晚于该轮自己的消息，因此落在末尾而不是
      // 「缺 ts 沉底」的巧合位置。没有终态时刻时保持 undefined（= 会话末尾，正确）。
      ...(sessionFailure.completedAt !== undefined ? { ts: sessionFailure.completedAt } : {}),
    });
  }

  // 会话记录快照里的「模型这一轮看到了什么系统消息」：事件流里已经出了同一份（同 hash）
  // 就不再补 —— **同 hash 只出一张卡**（hash 是「同一份系统消息」的稳定身份）。
  // 触发场景只有刷新 / 进程重启之后（事件回放窗口里没有这条事件了）。
  const sessionSystemContext = input.sessionSystemContext;
  if (
    sessionSystemContext !== undefined &&
    !live.some((item) => item.kind === 'prompt-context' && item.hash === sessionSystemContext.hash)
  ) {
    const { runId, at, ...data } = sessionSystemContext;
    items.push({
      kind: 'prompt-context',
      // key 用 hash：detail 派生这条在多次 build 之间必须同一个身份（不随事件 seq 变），
      // 而且它天然唯一（同 hash 不会出第二张）。
      key: `prompt:session:${sessionSystemContext.hash}`,
      ...data,
      ...(runId !== undefined ? { runId } : {}),
      // 排序用它自己那条事件的时刻；缺省（旧 gateway 没给 at）时才沉到会话末尾 ——
      // 那时它本来就是「最近一轮」的系统消息，落在末尾是正确的。
      ...(at !== undefined ? { ts: at } : {}),
    });
  }

  // 服务端 answered 记录（已答提问）→ `ask-answered` item，按 `answered_at` 与消息 item
  // 一起排序（同一个 `compareTimelineEntries`）。以前这段是会话滚动区末尾的额外一段，
  // 现在它只是时间线上的普通一员 —— 没有 absIndex，也不参与认领 / 交棒。
  //
  // 两道去重：
  // - `answeredAsks` 已经丢掉 `mode === 'async'` 的记录（它的答案就是那条 `ask:answer`
  //   消息，画两张一样的卡没有意义）；
  // - 这里再按 requestId 断一次：旧 gateway 不返回 `mode`，那条 async 记录会漏过第一道，
  //   而屏上已经有同 requestId 的 `ask-answer` 卡 —— 以消息卡为准（同一份数据，消息卡还
  //   带着该轮的输入身份）。合并成一条的批量答案消息只对得上首个 requestId，其余记录
  //   仍然落位（宁可多一张可见的卡，也不吞掉一条已答记录）。
  const answeredAsksInput = input.answeredAsks;
  if (answeredAsksInput !== undefined && answeredAsksInput.length > 0) {
    const represented = new Set<string>();
    for (const item of items) {
      if (item.kind !== 'ask-answer') continue;
      if (item.card.requestId !== undefined) represented.add(item.card.requestId);
    }
    for (const record of answeredAsksInput) {
      if (represented.has(record.requestId)) continue;
      items.push({
        kind: 'ask-answered',
        key: `ask-answered:${record.requestId}`,
        requestId: record.requestId,
        card: record.card,
        // 排序 ts = 服务端记录的回答时刻（缺 answered_at 时映射层已回退 created_at，
        // 两者都没有的记录根本不会到这里，见 ask-answered.ts）。
        // 同一毫秒的定序：插入序 = 「补充区在历史 / live 之后入列」，因此它落在那些消息
        // item 之后；而其中并列的几条记录由 `answeredAsks` 的稳定升序定死 ——
        // 重建两次的顺序完全一致（刷新不跳位）。
        ts: record.answeredAt,
      });
    }
  }

  const historyKeys = new Set(history.items.map((item) => item.key));
  const ordered = mergeByKey(items, historyKeys)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareTimelineEntries(a.item, b.item, a.index, b.index))
    .map(({ item }) => item);

  return foldAdjacentEnvNotices(withSpeakerRuns(ordered));
}

/**
 * 相邻同 scope 的环境信息卡折叠成一张（卡头显示「N 条」，展开看全部行）。
 *
 * 为什么需要：配置热应用一次可能连着发好几条同 scope 通知，逐张卡片会把时间线刷屏。
 * 口径与 `pending-strip` 的同源折叠一致 —— **纯展示**合并：行不删、顺序不变，
 * 折叠后的卡仍站在**第一条**的位置（位置由该消息自己的 ts 决定，见上面的 ItemMeta）。
 *
 * 只折「相邻且同 scope」：中间夹了别的 item（正文 / 工具卡 / 别的 scope）就不合并，
 * 否则会把时间线上的因果顺序讲错（一条配置通知与它之后的回复之间插了别的 scope）。
 */
function foldAdjacentEnvNotices(items: readonly TranscriptItem[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const item of items) {
    const previous = out[out.length - 1];
    if (
      item.kind === 'runtime-notice' &&
      item.env !== undefined &&
      previous !== undefined &&
      previous.kind === 'runtime-notice' &&
      previous.env !== undefined &&
      previous.env.scope === item.env.scope
    ) {
      out[out.length - 1] = { ...previous, env: mergeEnvNoticeCards(previous.env, item.env) };
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * 连续同发言人分组：只由消息类 item 决定（历史消息 / run 正文），
 * tool / notice / reasoning 既不参与也不打断（扫描时跳过）。
 */
export function withSpeakerRuns(items: readonly TranscriptItem[]): TranscriptItem[] {
  let previous: string | undefined;
  return items.map((item) => {
    const speaker = speakerOf(item);
    if (speaker === undefined) return item;
    const groupStart = speaker !== previous;
    previous = speaker;
    return { ...item, speaker, groupStart };
  });
}

function speakerOf(item: TranscriptItem): string | undefined {
  if (item.kind === 'run-text') return 'assistant';
  if (item.kind !== 'message') return undefined;
  const name = item.message.name;
  // 身份判定复用 agent-sender.ts（发言人头 = 同一个 agent 名字）。
  if (typeof name === 'string' && agentSenderOfName(name) !== undefined) return name;
  return item.message.role;
}
