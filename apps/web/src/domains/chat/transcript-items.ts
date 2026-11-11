/**
 * 时间线的**单一 item 流**（纯函数，无 React / DOM）。
 *
 * 渲染不再分「运行态」与「终止态」两条路径：事件流和 sessions.get 都只是 item 的来源，
 * 同一个逻辑对象在两边都存在时是**同一个 item**（身份靠 key，不靠状态推断）。
 * 工具运行→结束只改 item 的字段，不产生新 item、不重挂。
 *
 * 身份命名：
 * - msg:<绝对下标>            历史消息（绝对下标 = detailWindow.start + 窗口内下标，前插不变）
 * - run:<runId>:text:<n>      一次 run 的第 n 段正文（尾部未闭合段与 flush 后是同一个 n）
 * - run:<runId>:reasoning:<n> 第 n 段思考
 * - tool:<callId>             工具调用（live 与 history 共用；无 callId 时 tool:run:<runId>:<key>）
 * - tool:orphan:<绝对下标>     只有结果、没有调用的历史 tool 消息
 * - notice:<item.key>         上下文 / 原始事件行
 * - run:<runId>:input         run 的输入：人的输入（气泡）/ agent 投递（agent 卡）/
 *                             运行时上下文输入（`vessel:*` → 环境信息卡，落盘后让位给历史）
 * - queued:<runId>            本地排队提交
 * - run:<runId>:failure       一次 run 的失败卡（事件流优先，会话记录快照兜底）
 *
 * 去重 = **认领（claiming）**：按轮次顺序一对一匹配，每个 run 最多认领一条用户消息，
 * 每条消息最多被一个 run 认领；被认领的历史消息不再单独成 item（run 是权威来源）。
 * 认领失败（guardrail 改写过正文等）时两边都渲染 —— 宁可重复，绝不吞消息。
 */
import type { Message, MessageRef, RunEvent } from '../../gateway/types';
import type { SessionDetail } from '../../gateway/types/sessions';
import type { ErrorMeta } from '../../state/error-visibility';
import type { RunGroup } from '../../state/events';
import { agentSenderOfName } from './agent-sender';
import {
  ASK_ANSWER_MESSAGE_NAME,
  type AskAnswerCard as AskAnswerData,
  askAnswerCard,
  isAskAnswerMessage,
} from './ask-answer';
import {
  type EnvNoticeCard,
  envNoticeCard,
  isEnvNoticeKind,
  mergeEnvNoticeCards,
} from './env-notice';
import { buildHistoryToolItems } from './history-tools';
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
 * 「待批答复」item：async `ask_user` 的答案（0.52）。
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

export interface RunTextItem extends ItemMeta {
  kind: 'run-text';
  runId: string;
  text: string;
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

export interface QueuedItem extends ItemMeta {
  kind: 'queued';
  runId: string;
  input: string;
  submittedAt: number;
  queuePosition?: number;
  cancelling: boolean;
  cancelled: boolean;
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
  | RunTextItem
  | RunReasoningItem
  | ToolItem
  | NoticeItem
  | QueuedItem
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

/** 一次 build 的输入。historyIndex / liveItems 由调用侧 memo 后传入（见文件头性能说明）。 */
export interface TranscriptBuildInput {
  /** 已加载的历史窗口（按消息顺序）。 */
  messages: readonly Message[];
  /** messages[0] 在完整 state.messages 里的绝对下标。 */
  messageIndexOffset: number;
  /** 事件缓冲里的 run 分组（可含未落盘的）。 */
  liveGroups: readonly RunGroup[];
  /** 本地排队提交（乐观）。 */
  queued: readonly QueuedInput[];
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
}

/** 排队提交的最小形状（与 StreamItems 的 QueuedSubmission 对齐，避免循环依赖）。 */
export interface QueuedInput {
  runId: string;
  input: string;
  submittedAt: number;
  queuePosition?: number;
  cancelling: boolean;
  cancelled: boolean;
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
    }

    const ids = (message.tool_calls ?? [])
      .map((call) => call.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) callIdsByIndex.set(absIndex, ids);
    for (const id of ids) callIds.add(id);
    if (message.role === 'assistant') contentByIndex.set(absIndex, trimText(message.content));

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
      // 解析失败（空正文 / 纯空白）时 env 缺省，渲染回退成整段文本的 notice 卡。
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

  return { items, userByContent, callIdsByIndex, contentByIndex, messageByIndex, callIds };
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
    // 用户气泡；两者都不是 = 人自己说的话 → 气泡。
    if (trimText(group.input).length > 0) {
      const text = group.input as string;
      const ts = itemTs(undefined);
      const tsPart = ts !== undefined ? { ts } : {};
      // 0.52：async ask 的答案在运行态就已知道身份（input_name = ask:answer），
      // 首帧就渲成「待批答复」卡，不会先闪一帧用户气泡。
      const askAnswer =
        group.inputName === ASK_ANSWER_MESSAGE_NAME ? askAnswerCard(text) : undefined;
      // 运行时合成输入（idle 唤醒等）带 vessel:* 身份：渲成运行时提示卡（环境信息卡），
      // 绝不画成用户气泡。
      const noticeKind = runtimeContextKindOfName(group.inputName);
      if (askAnswer !== undefined) {
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
        items.push({
          kind: 'run-text',
          key: `run:${group.runId}:text:${textIndex}`,
          runId: group.runId,
          text: item.text,
          streaming: false,
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
        items.push({
          kind: 'run-reasoning',
          key: `run:${group.runId}:reasoning:${reasoningIndex}`,
          runId: group.runId,
          text: item.text,
          streaming: false,
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
          // 工具卡用自己的 tool.call.started 时间（真事件时间）。
          ...(itemTs(item.startedAt) !== undefined ? { ts: itemTs(item.startedAt) } : {}),
          ...seqMeta,
        });
        continue;
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
    // 尾部未闭合段用**当前段序**做 key：flush 之后它就是同一个 n（身份延续的关键）。
    if (group.liveText !== undefined && group.liveText.length > 0) {
      items.push({
        kind: 'run-text',
        key: `run:${group.runId}:text:${textIndex}`,
        runId: group.runId,
        text: group.liveText,
        streaming: true,
        ...(itemTs(group.lastTs) !== undefined ? { ts: itemTs(group.lastTs) } : {}),
        ...seqMeta,
      });
    }
    if (group.liveReasoning !== undefined && group.liveReasoning.length > 0) {
      items.push({
        kind: 'run-reasoning',
        key: `run:${group.runId}:reasoning:${reasoningIndex}`,
        runId: group.runId,
        text: group.liveReasoning,
        streaming: true,
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

/** run 侧认领所需的信息（callId 集合、已流出的正文、用户输入）。 */
interface RunClaim {
  runId: string;
  input: string;
  output: string;
  running: boolean;
  startTs?: number;
  callIds: Set<string>;
}

function runClaims(groups: readonly RunGroup[], live: readonly TranscriptItem[]): RunClaim[] {
  const byRun = new Map<string, RunClaim>();
  for (const group of groups) {
    byRun.set(group.runId, {
      runId: group.runId,
      input: trimText(group.input),
      output: trimText(group.output),
      running: group.status === 'running',
      ...((group.startedAt ?? group.firstTs) !== undefined
        ? { startTs: group.startedAt ?? group.firstTs }
        : {}),
      callIds: new Set<string>(),
    });
  }
  for (const item of live) {
    if (item.kind === 'tool' && item.runId !== undefined && item.callId !== undefined) {
      byRun.get(item.runId)?.callIds.add(item.callId);
    }
  }
  // 正文：run.completed.output 缺失时用已流出的正文兜底（同一段文本即可认领）。
  for (const item of live) {
    if (item.kind !== 'run-text') continue;
    const claim = byRun.get(item.runId);
    if (claim === undefined || claim.output.length > 0) continue;
    claim.output = trimText(item.text);
  }
  return [...byRun.values()].sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
}

/**
 * 认领：把「live 里已经有的事件」与「历史里刚出现的那条消息」对成同一个逻辑对象。
 *
 * 一对一、按轮次顺序：每个 run 最多认领一条用户消息（同一句话连发两次时按顺序取
 * 未认领的下一条），每条消息最多被一个 run 认领；assistant 消息按 callId 子集或
 * 正文相等/包含认领，允许一个 run 认领它自己的多条迭代。
 */
function claimMessages(
  claims: readonly RunClaim[],
  history: HistoryIndex,
): { claimedAssistant: Set<number>; claimedUserByRun: Map<string, number> } {
  const claimedUser = new Set<number>();
  const claimedUserByRun = new Map<string, number>();
  let cursor = -Infinity;
  for (const claim of claims) {
    if (claim.input.length === 0) continue;
    const candidates = history.userByContent.get(claim.input) ?? [];
    const target = candidates.find((index) => index >= cursor && !claimedUser.has(index));
    if (target === undefined) continue;
    claimedUser.add(target);
    claimedUserByRun.set(claim.runId, target);
    cursor = target;
  }

  const claimedAssistant = new Set<number>();
  for (const claim of claims) {
    const from = claimedUserByRun.get(claim.runId) ?? cursor;
    if (claim.output.length === 0) continue;
    for (const [absIndex, content] of history.contentByIndex) {
      if (absIndex <= from || claimedAssistant.has(absIndex)) continue;
      if (content !== claim.output && !(content.length >= 8 && claim.output.includes(content))) {
        continue;
      }
      claimedAssistant.add(absIndex);
    }
    for (const [absIndex, ids] of history.callIdsByIndex) {
      if (absIndex <= from || claimedAssistant.has(absIndex)) continue;
      if (!(ids.length > 0 && ids.every((id) => claim.callIds.has(id)))) continue;
      claimedAssistant.add(absIndex);
    }
  }
  return { claimedAssistant, claimedUserByRun };
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
  const claims = runClaims(input.liveGroups, live);
  const { claimedAssistant, claimedUserByRun } = claimMessages(claims, history);

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
    // 让位的是 live 侧的同文段（见下面的 claimedTexts），这样两边顺序一致。
    // 思考同理：历史消息的 reasoning_content 由 Transcript.tsx 的 TranscriptMessage 渲染，
    // live 侧同一份思考按内容让位（claimedReasoning），所以不会双出。
    // 历史已落盘的调用**照常保留**：位置与 ts 由历史决定，live 只补充执行态
    // （key 相同，`mergeByKey` 会合并）。丢掉历史这一条会让顺序与「只有 history」不一致。
    items.push(item);
  }

  const claimByRun = new Map(claims.map((claim) => [claim.runId, claim]));
  // 已落盘的 assistant 参考（reasoning_content）：live 的同文思考段让位，避免重复。
  const claimedReasoning = new Set<string>();
  for (const message of history.messageByIndex.values()) {
    const reasoning = (message as { reasoning_content?: string }).reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
      claimedReasoning.add(normalizeText(reasoning));
    }
  }
  // 已落盘的 assistant 正文：live 的同文段不再单独成 item（它就是那条消息）。
  const claimedTexts = new Set<string>();
  for (const absIndex of claimedAssistant) {
    const content = history.contentByIndex.get(absIndex);
    if (content !== undefined && content.length > 0) claimedTexts.add(normalizeText(content));
  }
  // 每个 run 的最后一段正文（streaming 的尾巴算最后一段）。
  const lastTextKeyByRun = new Map<string, string>();
  for (const item of live) {
    if (item.kind === 'run-text') lastTextKeyByRun.set(item.runId, item.key);
  }
  for (const item of live) {
    const runId = 'runId' in item ? item.runId : undefined;
    // 输入已被历史消息认领：历史那条负责渲染，run 侧那份丢弃（绝不两个气泡 / 两张卡）。
    // 三种输入共用这条规则：人的输入（run-input）、async ask 的答案（ask-answer）、
    // 运行时上下文输入（runtime-notice 带 runId，如 idle 唤醒的 vessel:notice）。
    if (runId !== undefined && claimedUserByRun.has(runId)) {
      if (item.kind === 'run-input') continue;
      if (item.kind === 'runtime-notice') continue;
      if (item.kind === 'ask-answer') continue;
    }
    const claim = runId === undefined ? undefined : claimByRun.get(runId);
    if (claim === undefined) {
      items.push(item);
      continue;
    }
    // 这段正文对应的 assistant 消息已经落盘 → 由历史消息负责渲染（位置、key、操作按钮
    // 都是历史的），live 只在前者不存在时出现。**不改 key、不合并**，所以
    // order(live+history) 的 key 序列与 order(history only) 一致。
    if (item.kind === 'run-text' && claimedTexts.has(normalizeText(item.text))) continue;
    if (item.kind === 'run-reasoning' && claimedReasoning.has(normalizeText(item.text))) continue;
    const claimedUser = claimedUserByRun.get(claim.runId);
    const claimedUserTs =
      claimedUser === undefined ? undefined : history.messageByIndex.get(claimedUser)?.timestamp;
    // 强下限（认领到的用户消息）总是生效：run.started 比用户消息落盘早几毫秒。
    // 弱下限（最后一条用户消息）只在 item 自己没有 ts 时兜底 —— 否则「早于可见窗口的
    // 旧 run 卡片」会被拽到新卡片后面，屏幕上时间看起来倒序（F9 守这一条）。
    const strong = claimedUserTs !== undefined ? claimedUserTs + 1 : undefined;
    const weak =
      claim.running && item.ts === undefined && lastUserTs !== undefined
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

  for (const queued of input.queued) {
    const base = queued.submittedAt;
    items.push({
      kind: 'queued',
      key: `queued:${queued.runId}`,
      runId: queued.runId,
      input: queued.input,
      submittedAt: queued.submittedAt,
      ...(queued.queuePosition !== undefined ? { queuePosition: queued.queuePosition } : {}),
      cancelling: queued.cancelling,
      cancelled: queued.cancelled,
      ts: base,
    });
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
 * tool / notice / reasoning / queued 既不参与也不打断（扫描时跳过）。
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
