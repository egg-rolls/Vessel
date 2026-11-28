import type { ProjectionView, RunEvent } from '../../gateway/types';
import { type ErrorMeta, errorMetaOf } from '../../state/error-visibility';
import type { TimelineItem } from '../../state/events';
import {
  type AgentNameIndex,
  agentDisplayName,
  EMPTY_AGENT_NAMES,
  internalIdLabel,
  MEMBER_LIST_MAX_NAMES,
  membersLabel,
} from './agent-labels';

export type ToolCardStatus = 'running' | 'done' | 'error';

export interface ToolCardView {
  kind: 'tool';
  key: string;
  callId?: string;
  name: string;
  status: ToolCardStatus;
  args?: unknown;
  result?: unknown;
  error?: string;
  /** 0.14 additive：tool.call.failed 的结构化错误元数据。 */
  errorMeta?: ErrorMeta;
  durationMs?: number;
  truncated?: boolean;
  startedAt: number;
  /**
   * 0.54 additive：这条工具消息的「模型看到的是什么」（`sessions.get` 的 wire 派生）。
   *
   * 只有历史侧有（live 事件流不带它）；`undefined` = 没被投影 = 与 0.54 之前完全一致。
   * 身份由 `tool_call_id` 决定，已按 id 合并在调用方完成（见 `transcript-items.ts`）。
   */
  projection?: ProjectionView;
  /**
   * 0.54 additive：正文被裁时**本次生效的上限**（wire `message.truncated.content.limit`）。
   *
   * 投影卡的「已截到前 N」里的 N 取它（缺省时用 `projection.ts` 的常量兜底）：
   * 这个数字用户会当事实读，不许硬编码、也不许从正文里数。
   */
  truncatedLimitBytes?: number;
  /**
   * 该卡解析到的事件锚点（`tool.call.started` 的 seq）。
   *
   * 只用于诊断与门禁对拍（交棒记录 / 守恒断言要按锚点对账）；渲染不读它。
   * 工具卡**不走交棒**（历史侧不复现执行态耗时与截断标记），所以它允许缺省。
   */
  anchorSeq?: number;
}

export type ChatRenderItem =
  | { kind: 'text'; text: string; key: string; startedAt?: number; endedAt?: number }
  | { kind: 'reasoning'; text: string; key: string; startedAt?: number; endedAt?: number }
  | { kind: 'notice'; event: RunEvent; key: string }
  | { kind: 'event'; event: RunEvent; key: string }
  | ToolCardView;

interface PendingStart {
  card: ToolCardView;
  callId?: string;
}

function callIdOf(data: Record<string, unknown>): string | undefined {
  const id = data.tool_call_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function toolNameOf(data: Record<string, unknown>): string | undefined {
  const name = data.tool_name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function durationOf(data: Record<string, unknown>): number | undefined {
  const value = data.duration_ms;
  return typeof value === 'number' ? value : undefined;
}

function errorOf(data: Record<string, unknown>): string | undefined {
  const value = data.error;
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  return String(value);
}

function takePending(
  pending: PendingStart[],
  callId: string | undefined,
  name: string | undefined,
): PendingStart | undefined {
  if (callId !== undefined) {
    const exact = pending.findIndex((entry) => entry.callId === callId);
    if (exact >= 0) return pending.splice(exact, 1)[0];
  }
  if (name === undefined) return undefined;
  // Distinct call ids must never be merged through the name fallback.
  const fallback = pending.findIndex(
    (entry) => entry.card.name === name && (callId === undefined || entry.callId === undefined),
  );
  return fallback >= 0 ? pending.splice(fallback, 1)[0] : undefined;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 优先把 arguments 解析成对象；解析失败时按原始字符串处理。 */
export function parseToolArgs(args: unknown): Record<string, unknown> | string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed.startsWith('{')) return args;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : args;
    } catch {
      return args;
    }
  }
  if (typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  return stringifyValue(args);
}

function scalarArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

type ToolArgs = Record<string, unknown>;

/** 结构化入参工具的摘要：`action → 目标/条数`；名字表用于把内部 id 换成人能认的名字。 */
type StructuredSummarizer = (args: ToolArgs, names: AgentNameIndex) => string | undefined;

function isRecord(value: unknown): value is ToolArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 首个非空短文本：压成单行并按 cap 截断（摘要不是正文）。 */
function shortText(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function intValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** 数组长度；非数组 → undefined（不猜）。 */
function listLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

/** 数组里的非空字符串成员（`members` / `paths` / `ids` 用）。 */
function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim());
  }
  return out;
}

/** `<principal>@<node_id>:<team_id>` 只留 principal —— 卡头说的是「发给谁」，不是完整路由。 */
function principalLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const at = value.indexOf('@');
  return at > 0 ? value.slice(0, at) : value;
}

/**
 * 完整地址 `<principal>@<node>:<team>` 的解析结果（additive，问题2）。
 *
 * 卡头摘要仍然只说「发给谁」（principalLabel 的口径不动）；舰队归属由这份解析
 * 交给卡片副行 / 展开体显示。三段任一为空 / 形状不符 ⇒ `undefined`：旧消息的纯名字、
 * 本地 id 一律不认，渲染逐字不变（向后兼容不是可选项）。
 */
export interface AgentRoute {
  principal: string;
  node: string;
  team: string;
  /** 原始地址（trim 后逐字；展示 / tooltip 用它，不重新拼装）。 */
  raw: string;
}

/**
 * 解析完整地址（纯函数）。node 段取**第一个** `:` 之前：node id（UUID）与 team id
 * （slug / UUID）都不含 `:`，第一个冒号就是分界。未知 node 不猜名字 —— 这里只拆段，
 * 名字映射是渲染层的事（查不到退原始 id）。
 */
export function parseAgentAddress(value: string | undefined): AgentRoute | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  const at = raw.indexOf('@');
  if (at <= 0) return undefined;
  const rest = raw.slice(at + 1);
  const colon = rest.indexOf(':');
  if (colon <= 0 || colon === rest.length - 1) return undefined;
  return {
    principal: raw.slice(0, at),
    node: rest.slice(0, colon),
    team: rest.slice(colon + 1),
    raw,
  };
}

/**
 * `agent` 工具入参里的目标地址：`to` / `member` / `members[0]` / `name`，与
 * `agentSummary` 的目标解析同一顺序。只有完整地址形状才返回（纯名字 / 本地 id ⇒
 * undefined，卡片不新增任何显示）。
 */
export function agentRouteOf(args: unknown): AgentRoute | undefined {
  const parsed = parseToolArgs(args);
  if (parsed === undefined || typeof parsed === 'string') return undefined;
  const candidates = [
    typeof parsed.to === 'string' ? parsed.to : undefined,
    typeof parsed.member === 'string' ? parsed.member : undefined,
    stringItems(parsed.members)[0],
    typeof parsed.name === 'string' ? parsed.name : undefined,
  ];
  for (const candidate of candidates) {
    const route = parseAgentAddress(candidate);
    if (route !== undefined) return route;
  }
  return undefined;
}

/**
 * `agent` 工具结果里的 `resolved_to`（服务端实际投递给谁）：本地成员 id 或完整地址。
 * 结果可能是 JSON 字符串（工具回话）或已解析对象；没有该字段 ⇒ undefined。
 * 批量结果（results[]）不逐条展开 —— 摘要只讲单发那一条，批量看展开体的输出分区。
 */
export function resolvedTargetOf(result: unknown): string | undefined {
  let record: unknown = result;
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      record = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(record)) return undefined;
  const value = record.resolved_to;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 目标以「谁能认出来」的形式出现：名字优先，内部 id 退短 id（见 `agent-labels.ts`）。
 *
 * 顺序不能反：地址先砍成 principal（那是「发给谁」而不是完整路由），再查名字表，
 * 最后才是形状判定 —— 先截断再查表会把 `ecfc6a4f-…@node:team` 变成一个永远查不到的串。
 */
function targetLabel(value: string | undefined, names: AgentNameIndex): string | undefined {
  return agentDisplayName(principalLabel(value), names);
}

/**
 * `agent`：`action` + 目标 / 人数 / 条数。
 *
 * 入参见 `packages/agent/src/tool.ts:339`（`action` 首位必填，目标散在
 * `to` / `member` / `members[]` / `name`）：这些都是结构化字段，旧实现只在标量名单里
 * 找 → 卡片头部只剩工具名。
 *
 * 目标**不再回显原值**：`to` / `member` / `members[]` 允许传 id，模型后来越来越多
 * 传 id（重名、rotate 之后 id 才无歧义），于是卡片把 36 位 UUID 摆到人面前。这里统一过
 * `agentDisplayName`：roster 里有名字就用名字，没有就短 id，绝不编名字。
 */
function agentSummary(args: ToolArgs, names: AgentNameIndex): string | undefined {
  const action = shortText(args.action, 16);
  if (action === undefined) return undefined;
  if (action === 'create' || action === 'hire') {
    // `members` 这里是「要建几个」的定义对象，`name` 是新 agent 的名字都不是 id：原样。
    const count = listLength(args.members);
    const name = shortText(args.name, 48);
    if (count !== undefined && count > 1) return `${action} → ${count} 名成员`;
    if (name !== undefined) return `${action} → ${name}`;
    if (count === 1) return `${action} → 1 名成员`;
    return action;
  }
  const members = stringItems(args.members);
  const target =
    targetLabel(shortText(args.to, 64), names) ??
    targetLabel(shortText(args.member, 64), names) ??
    agentDisplayName(members[0], names) ??
    targetLabel(shortText(args.name, 64), names);
  const head = target === undefined ? action : `${action} → ${target}`;
  // 只报条数：`messages` 的正文不进摘要。
  const messages = listLength(args.messages);
  if (messages !== undefined && messages > 0) return `${head}（${messages} 条）`;
  if (action !== 'close') return head;
  // 关多名成员：一两个就报名字（`共 N 名`），再多只留「N 名成员（前两个 等）」——
  // 别把成员表串成一句读不完的长句（完整列表在展开体的入参里）。
  if (members.length > MEMBER_LIST_MAX_NAMES) {
    const list = membersLabel(members, names);
    if (list !== undefined) return `${action} → ${list}`;
  }
  if (members.length > 1) return `${head}（共 ${members.length} 名）`;
  return head;
}

/**
 * `inbox`：`action` + 条数 / 首个 id / 正文首段。
 *
 * 入参见 `packages/agent/src/inbox.ts:1185`（`ids` / `message_ids` / `limit` / `content`）。
 *
 * 单个 `ids[]` 也过一遍名字表 —— 它是消息 id，一般解析不出名字，那就退短 id
 * （以前是把 36 位 UUID 原样摆到卡头，摘要被它挤满还读不出一件事）。
 */
function inboxSummary(args: ToolArgs, names: AgentNameIndex): string | undefined {
  const action = shortText(args.action, 16);
  if (action === undefined) return undefined;
  if (action === 'insert') {
    const content = shortText(args.content, 40);
    return content === undefined ? action : `${action} → ${content}`;
  }
  const ids = [...stringItems(args.ids), ...stringItems(args.message_ids)];
  const first = ids[0];
  if (first !== undefined) {
    if (ids.length > 1) return `${action} → ${ids.length} 条`;
    return `${action} → ${agentDisplayName(first, names) ?? first}`;
  }
  const limit = intValue(args.limit);
  if (limit !== undefined && limit > 0) return `${action} → 最多 ${limit} 条`;
  return action;
}

/**
 * `subscribe`：`action` + 文件 / 订阅 id（入参见 `plugins/context/doc-subscription/src/tool.ts:450`）。
 *
 * `id` 是订阅的内部标识（UUID），以前原样（48 字）摆在卡头 —— 过一遍
 * `internalIdLabel` 退短 id；它不是 agent，名字表查不到，也不该查。
 */
function subscribeSummary(args: ToolArgs): string | undefined {
  const action = shortText(args.action, 16);
  if (action === undefined) return undefined;
  if (action === 'list') return action;
  // health 源（q-health-subscription）：node / nodes 目标，卡头标注 (health)。
  const nodeSingle = shortText(args.node, 96);
  const nodeMany = stringItems(args.nodes);
  const nodes = nodeSingle === undefined ? nodeMany : [nodeSingle, ...nodeMany];
  if (nodes.length > 0) {
    return nodes.length === 1
      ? `${action} → ${nodes[0]} (health)`
      : `${action} → ${nodes.length} 个节点（health）`;
  }
  const single = shortText(args.path, 96);
  const many = stringItems(args.paths);
  const paths = single === undefined ? many : [single, ...many];
  const first = paths[0];
  if (paths.length === 0) {
    const id = internalIdLabel(shortText(args.id, 96));
    return id === undefined ? action : `${action} → ${id}`;
  }
  return paths.length === 1
    ? `${action} → ${first}`
    : `${action} → ${paths.length} 个文件（${first} 等）`;
}

/** `ask`：首个问题标题（`header`）+ 问题数（入参见 `packages/tui/src/renderer/ask-user.ts:372`）。 */
function askSummary(args: ToolArgs): string | undefined {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const total = questions.length;
  if (total === 0) return undefined;
  const first = questions[0];
  const label = isRecord(first)
    ? (shortText(first.header, 24) ?? shortText(first.question, 32))
    : undefined;
  if (label === undefined) return `ask → ${total} 个问题`;
  return total > 1 ? `ask → ${label}（共 ${total} 个问题）` : `ask → ${label}`;
}

/**
 * 结构化入参工具的专用摘要（**优先于**下面的标量名单）。
 *
 * 这些工具的首个必填参数是 `action`，目标 / 条数是结构化字段（`to` / `members[]` /
 * `messages[]` / `ids[]` / `paths[]` / `questions[]`），一个都不在 `KNOWN_ARG_NAMES`
 * 里 —— 旧实现因此让 `agent` / `inbox` 卡片丢掉整段参数摘要。这里只取计数与首个短
 * 字段，不展开正文，也不回退到 `Object.values` 全盘扫。返回 `undefined` 表示「这个
 * 工具这一份入参没有结构化摘要」，照旧走下面的标量兜底。
 */
const STRUCTURED_ARG_SUMMARIES: Record<string, StructuredSummarizer> = {
  agent: agentSummary,
  inbox: inboxSummary,
  subscribe: subscribeSummary,
  ask: askSummary,
};

/** 摘要行允许用于兜底的已知参数名（不含 serve 注入的 preview / truncated）。 */
const KNOWN_ARG_NAMES: readonly string[] = [
  'command',
  'cmd',
  'script',
  'path',
  'file_path',
  'pattern',
  'query',
  'regex',
  'task',
  'prompt',
  'url',
  'name',
];

/** 摘要行的默认字符上限：够说完「发给谁 / 干了什么」，再多就会被卡头自己截掉。 */
export const DEFAULT_SUMMARY_LENGTH = 96;

/** Codex 式关键参数摘要：bash 命令行首行、路径、pattern。 */
export function toolSummary(
  name: string,
  args: unknown,
  maxLength = DEFAULT_SUMMARY_LENGTH,
  /**
   * 标识 → 名字（`agentNamesOf(rosters)`）。缺省 = 没有 roster：`agent` / `inbox` 卡上的
   * 内部 id 退短 id，其它工具与旧行为逐字一致（静态渲染 / 设计预览走的就是这条）。
   */
  agentNames: AgentNameIndex = EMPTY_AGENT_NAMES,
): string {
  const parsed = parseToolArgs(args);
  if (parsed === undefined) return '';
  let value: string | undefined;
  if (typeof parsed === 'string') {
    value = parsed;
  } else {
    const byTool: Record<string, readonly string[]> = {
      bash: ['command', 'cmd', 'script'],
      read: ['path', 'file_path'],
      edit: ['path', 'file_path'],
      write: ['path', 'file_path'],
      grep: ['pattern', 'query', 'regex'],
      search: ['query', 'pattern'],
    };
    value =
      STRUCTURED_ARG_SUMMARIES[name]?.(parsed, agentNames) ??
      scalarArg(parsed, byTool[name] ?? []) ??
      scalarArg(parsed, ['command', 'path', 'pattern', 'query', 'task', 'url', 'name']) ??
      // 兜底只在**已知参数名**里找：`Object.values` 会把 serve 截断后塞进来的
      // `preview` / `truncated` 当成摘要（摘要行显示预览文本，看着像别的工具的东西）。
      scalarArg(parsed, KNOWN_ARG_NAMES);
  }
  if (!value) return '';
  // bash 只取首行；其它工具把换行压成空格，避免 header 被撑高。
  const compact = name === 'bash' ? (value.split('\n')[0] ?? '') : value.replace(/\s+/g, ' ');
  const text = compact.trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
}

export interface EditDiff {
  path?: string;
  lines: DiffLine[];
  truncated: boolean;
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

/**
 * `edit` 的 old_string/new_string → 行级 diff。
 * 先掐掉公共前缀/后缀，只展示变更块与 2 行上下文；不做 O(n²) LCS。
 */
export function editDiffOf(
  args: unknown,
  { context = 2, maxLines = 200 }: { context?: number; maxLines?: number } = {},
): EditDiff | null {
  const parsed = parseToolArgs(args);
  if (!parsed || typeof parsed === 'string') return null;
  const oldValue = parsed.old_string;
  const newValue = parsed.new_string;
  if (typeof oldValue !== 'string' || typeof newValue !== 'string') return null;

  const oldLines = splitLines(oldValue);
  const newLines = splitLines(newValue);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const lines: DiffLine[] = [];
  for (const text of oldLines.slice(Math.max(0, prefix - context), prefix)) {
    lines.push({ kind: 'context', text });
  }
  for (const text of oldLines.slice(prefix, oldLines.length - suffix)) {
    lines.push({ kind: 'remove', text });
  }
  for (const text of newLines.slice(prefix, newLines.length - suffix)) {
    lines.push({ kind: 'add', text });
  }
  for (const text of oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + context)) {
    lines.push({ kind: 'context', text });
  }

  const changed = oldValue !== newValue;
  if (!changed) return null;
  const truncated = lines.length > maxLines;
  return {
    ...(typeof parsed.path === 'string' ? { path: parsed.path } : {}),
    lines: truncated ? lines.slice(0, maxLines) : lines,
    truncated,
  };
}

export const PREVIEW_LINES = 20;
export const PREVIEW_BYTES = 8 * 1024;
export const PAYLOAD_CHUNK_BYTES = 200 * 1024;

/**
 * 任意值 → 展示用文本。
 *
 * 字符串**原样返回**（不 trim、不动空白）：工具结果与投影占位的空白都是信息，
 * 复制出来的东西必须与正文逐字相等。对象走 pretty JSON。
 *
 * 0.54 从 `payload-section.tsx` 搬到这儿（纯逻辑与渲染分离）：投影卡的「原文」取值
 * 与门禁断言共用同一个函数，才谈得上「逐字」。
 */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface PayloadPreview {
  preview: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

/** 折叠态预览：最多 20 行 / 8KB；保留原始换行与行首空格。 */
export function previewPayload(
  text: string,
  maxLines = PREVIEW_LINES,
  maxBytes = PREVIEW_BYTES,
): PayloadPreview {
  // 只 split 一次：以前对大 payload 会切两遍数组（512KiB 时每卡每渲染 ~1ms）。
  const lines = text === '' ? [] : text.split('\n');
  const totalLines = lines.length;
  const byLines = lines.slice(0, maxLines).join('\n');
  const preview = byLines.length > maxBytes ? byLines.slice(0, maxBytes) : byLines;
  return {
    preview,
    truncated: totalLines > maxLines || text.length > preview.length,
    totalLines,
    totalBytes: text.length,
  };
}

export function foldToolItems(items: readonly TimelineItem[]): ChatRenderItem[] {
  const output: ChatRenderItem[] = [];
  const pending: PendingStart[] = [];

  for (const item of items) {
    if (item.kind !== 'event') {
      output.push(item);
      continue;
    }

    const { event } = item;
    if (event.type === 'tool.call.started') {
      const callId = callIdOf(event.data);
      const card: ToolCardView = {
        kind: 'tool',
        key: item.key,
        callId,
        name: toolNameOf(event.data) ?? 'tool',
        status: 'running',
        args: event.data.arguments,
        truncated: event.data.truncated === true ? true : undefined,
        startedAt: event.ts,
      };
      output.push(card);
      pending.push({ card, callId });
      continue;
    }

    if (event.type === 'tool.call.completed' || event.type === 'tool.call.failed') {
      const completed = event.type === 'tool.call.completed';
      const callId = callIdOf(event.data);
      const name = toolNameOf(event.data);
      const durationMs = durationOf(event.data);
      const started = takePending(pending, callId, name);

      if (started) {
        started.card.status = completed ? 'done' : 'error';
        if (started.card.callId === undefined && callId !== undefined) {
          started.card.callId = callId;
        }
        if (completed) started.card.result = event.data.result;
        else {
          started.card.error = errorOf(event.data);
          started.card.errorMeta = errorMetaOf(event.data);
        }
        if (durationMs !== undefined) started.card.durationMs = durationMs;
        if (event.data.truncated === true) started.card.truncated = true;
        continue;
      }

      output.push({
        kind: 'tool',
        key: `tool-${item.key}`,
        callId,
        name: name ?? 'tool',
        status: completed ? 'done' : 'error',
        result: completed ? event.data.result : undefined,
        error: completed ? undefined : errorOf(event.data),
        errorMeta: completed ? undefined : errorMetaOf(event.data),
        durationMs,
        truncated: event.data.truncated === true ? true : undefined,
        startedAt: event.ts,
      });
      continue;
    }

    output.push(item);
  }

  return output;
}
