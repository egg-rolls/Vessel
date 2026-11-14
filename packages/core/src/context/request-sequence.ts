/**
 * 请求 messages 的 append-only 判据（0.52：请求侧只能 append）。
 *
 * 不变量：同一**段**内，相邻两次请求的 provider 投影必须严格前缀延伸；换段必须由
 * 一个显式登记的分段事件开（`SEGMENT_BOUNDARY_KINDS`）。本模块只放纯函数与词表、
 * 不碰 IO —— 门禁 `scripts/check-request-append-only.ts` 与产品侧守卫必须共用同一套
 * 判据，否则「门禁怎么算」和「运行时怎么算」很快会变成两种口径。
 *
 * 为什么比 **provider 投影**而不是整条 `Message`：
 * - `timestamp` / `run_id` / `run_segment` 是落盘侧每次写入都盖的章（易变）；
 * - `refs` / `compaction_summary` 不进请求体（`types/provider.ts` 注释：Provider 忽略）。
 * 拿整条消息比，会把「盖了个新时间戳」判成「改写了历史」—— 假红，而假红又反过来
 * 成为放宽判据的理由。投影只留 provider 真正读到的字节，假红消失，真差异照旧。
 *
 * @module @vessel-agent/core/context
 */

import type { Message } from '../types/provider.js';
import { isClearedToolResult } from './cleared-tool-result.js';

/**
 * 进请求体的字段 —— `providers.ts` 的两处 message map 逐字段挑的就是这些。
 * （`name` 只有部分 provider 读，但它是稳定的角色标注，保留。）
 */
export const PAYLOAD_FIELDS = [
  'role',
  'content',
  'tool_calls',
  'tool_call_id',
  'name',
  'reasoning_content',
] as const;

/**
 * 不进请求体的字段：前三个是落盘侧每次写入都盖的章（易变），
 * 后两个只给 UI / 本地逻辑用（`types/provider.ts` 注释：Provider 忽略该字段）。
 */
export const NON_PAYLOAD_FIELDS = [
  'timestamp',
  'run_id',
  'run_segment',
  'compaction_summary',
  'refs',
] as const;

/** 参与请求体比较的字段名 */
export type PayloadField = (typeof PAYLOAD_FIELDS)[number];
/** 不参与请求体比较的字段名 */
export type NonPayloadField = (typeof NON_PAYLOAD_FIELDS)[number];

/** provider 真会读到的 tool_call 形状（只留稳定字段，arguments 逐字节比）。 */
export interface ProviderPayloadToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** 一条消息投影到「provider 看到的字节」。 */
export interface ProviderPayloadMessage {
  role: string;
  content: string;
  name?: string;
  tool_calls?: readonly ProviderPayloadToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

/** 一条消息不可投影的原因（下标 + 说明）。 */
export interface ProjectionProblem {
  index: number;
  problem: string;
}

function toolCallProblems(call: unknown, index: number): ProjectionProblem[] {
  if (!call || typeof call !== 'object') return [{ index, problem: 'tool_calls 元素不是对象' }];
  const fn = (call as { function?: unknown }).function;
  if (fn === undefined || fn === null) return [];
  if (typeof fn !== 'object') return [{ index, problem: 'tool_calls[].function 不是对象' }];
  const args = (fn as { arguments?: unknown }).arguments;
  if (args !== undefined && typeof args !== 'string') {
    return [{ index, problem: 'tool_calls[].function.arguments 不是字符串（字节不可比）' }];
  }
  return [];
}

/**
 * 这条序列会不会被 provider 拒（不可投影 ⇒ 判定为 `invalid`，而不是当成「差异」）。
 *
 * 分成两个函数而不是让投影抛异常：门禁要求「红要红在判据上」，输入本身不合法时
 * 报的是 `invalid`（谁的 fixture 写错了），不能混进 `diverged`（历史被改写）。
 */
export function projectionProblems(messages: readonly Message[]): ProjectionProblem[] {
  const problems: ProjectionProblem[] = [];
  messages.forEach((message, index) => {
    const item = message as Partial<Message> | null | undefined;
    if (!item || typeof item !== 'object') {
      problems.push({ index, problem: '不是对象' });
      return;
    }
    if (typeof item.role !== 'string' || (item.role as string) === '') {
      problems.push({ index, problem: 'role 缺失' });
    }
    if (typeof item.content !== 'string') {
      problems.push({ index, problem: 'content 不是字符串' });
    }
    if (item.role === 'tool' && typeof item.tool_call_id !== 'string') {
      problems.push({ index, problem: 'tool 消息缺 tool_call_id（provider 会拒）' });
    }
    if (item.tool_calls !== undefined) {
      if (!Array.isArray(item.tool_calls)) {
        problems.push({ index, problem: 'tool_calls 不是数组' });
      } else {
        for (const call of item.tool_calls) problems.push(...toolCallProblems(call, index));
      }
    }
  });
  return problems;
}

function messageToPayload(message: Message): ProviderPayloadMessage {
  const item = message as Partial<Message>;
  const payload: ProviderPayloadMessage = {
    role: typeof item.role === 'string' ? item.role : '',
    content: typeof item.content === 'string' ? item.content : '',
  };
  if (typeof item.name === 'string') payload.name = item.name;
  if (typeof item.tool_call_id === 'string') payload.tool_call_id = item.tool_call_id;
  if (typeof item.reasoning_content === 'string')
    payload.reasoning_content = item.reasoning_content;
  if (Array.isArray(item.tool_calls)) {
    payload.tool_calls = item.tool_calls.map((call) => {
      const projected: ProviderPayloadToolCall = {};
      const raw = call as {
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (typeof raw.id === 'string') projected.id = raw.id;
      if (typeof raw.type === 'string') projected.type = raw.type;
      if (raw.function && typeof raw.function === 'object') {
        const fn: { name?: string; arguments?: string } = {};
        if (typeof raw.function.name === 'string') fn.name = raw.function.name;
        if (typeof raw.function.arguments === 'string') fn.arguments = raw.function.arguments;
        projected.function = fn;
      }
      return projected;
    });
  }
  return payload;
}

/**
 * 把 provider 真正收到的序列投影成可比较的稳定形态。
 *
 * 白名单而非黑名单：新加的易变字段默认不参与比较（否则每个 additive 字段都要改门禁）；
 * 反过来「参与比较的字段」被删掉会红 —— 那正是门禁该管的方向。字段分类的完整性由
 * 门禁对着 `types/provider.ts` 的 `Message` 逐个核对（漏分类 ⇒ 红）。
 */
export function toProviderPayload(messages: readonly Message[]): ProviderPayloadMessage[] {
  return messages.map((message) => messageToPayload(message));
}

/** 稳定 JSON：键排序、丢 undefined、不缩进 —— 逐字节比较用的唯一口径。 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const body = entries
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
    .join(',');
  return '{' + body + '}';
}

function differingFields(
  prev: ProviderPayloadMessage,
  next: ProviderPayloadMessage,
): readonly string[] {
  const keys = new Set<string>([
    ...Object.keys(prev as unknown as Record<string, unknown>),
    ...Object.keys(next as unknown as Record<string, unknown>),
  ]);
  const fields: string[] = [];
  for (const key of keys) {
    const left = (prev as unknown as Record<string, unknown>)[key];
    const right = (next as unknown as Record<string, unknown>)[key];
    if (canonicalJson(left) !== canonicalJson(right)) fields.push(key);
  }
  return fields.sort();
}

/** 相邻两次请求的判定结果。 */
export type RequestSequenceDiffKind = 'extension' | 'diverged' | 'invalid';

/** `diffRequestSequence` 的返回：段内必须 `extension`。 */
export interface RequestSequenceDiff {
  kind: RequestSequenceDiffKind;
  /** 首次不同的下标；尾部删除时 = next 的长度 */
  atIndex?: number;
  /** 人话原因（门禁直接打印这一段） */
  reason?: string;
  /** 首个不同下标上真正变的 payload 字段（`role` / `content` / `tool_calls` …） */
  fields?: readonly string[];
}

/**
 * 比较相邻两次请求。
 *
 * - `extension`：next 以 prev 为（逐字节）前缀 —— 允许等长（重试同一份请求）；
 * - `diverged`：段内改写 / 删尾 —— 必须有一个已登记的分段事件，否则就是违规；
 * - `invalid`：某一侧压根不是合法 provider payload（fixture 或数据坏了）。
 */
export function diffRequestSequence(
  prev: readonly Message[],
  next: readonly Message[],
): RequestSequenceDiff {
  const problems = [
    ...projectionProblems(prev).map((item) => ({ ...item, side: 'prev' as const })),
    ...projectionProblems(next).map((item) => ({ ...item, side: 'next' as const })),
  ];
  const first = problems[0];
  if (first) {
    return {
      kind: 'invalid',
      atIndex: first.index,
      reason: first.side + ' 第 ' + String(first.index) + ' 条：' + first.problem,
    };
  }

  const left = toProviderPayload(prev);
  const right = toProviderPayload(next);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const before = left[index];
    const after = right[index];
    if (!before || !after) continue;
    if (canonicalJson(before) === canonicalJson(after)) continue;
    const fields = differingFields(before, after);
    return {
      kind: 'diverged',
      atIndex: index,
      fields,
      reason: '第 ' + String(index) + ' 条正文/字段被改写（差异字段：' + fields.join(', ') + '）',
    };
  }
  if (right.length < left.length) {
    return {
      kind: 'diverged',
      atIndex: right.length,
      reason:
        '尾部被删 ' +
        String(left.length - right.length) +
        ' 条（' +
        String(left.length) +
        ' -> ' +
        String(right.length) +
        '）',
    };
  }
  return { kind: 'extension' };
}

/** 请求里 `[cleared …]` 占位条数 —— R4（同一段内不得增加）的度量。 */
export function countClearedPlaceholders(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    const item = message as Partial<Message>;
    if (item.role !== 'tool') continue;
    if (typeof item.content !== 'string') continue;
    if (isClearedToolResult(item.content)) count += 1;
  }
  return count;
}

/** 请求里被换成占位的 tool_call_id（报红时点名用）。 */
export function clearedToolCallIds(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    const item = message as Partial<Message>;
    if (item.role !== 'tool') continue;
    if (typeof item.content !== 'string') continue;
    if (!isClearedToolResult(item.content)) continue;
    ids.push(typeof item.tool_call_id === 'string' ? item.tool_call_id : '(no tool_call_id)');
  }
  return ids;
}

/**
 * 段操作（白名单只有这两个）。**加新操作必须同时改门禁**
 * `scripts/check-request-append-only.ts` —— 那里有一份独立的 EXPECTED 表，多一项就红。
 *
 * 为什么收缩到两个：旧白名单是「六个具体事件」（run_boundary / session_switch /
 * compaction / system_revision / rewind-branch / context_trim），它把「操作」和
 * 「原因」混成了一维，于是每个原因都能顺手造一个新类型来合法化任何改写 ——
 * `run_boundary` 就是这么把「新 run 重新 seed 出不同前缀」洗白的（见审计 V-new-run）。
 * 拆开之后只有两维：
 *
 * - **`new`**：开新段，新段前缀不受上一段约束（换会话 / 换 body / rotate / 压缩）。
 * - **`pop`**：仍在同一段内，只丢掉尾部（回退 / 分支 / 超限裁剪）；
 *   丢掉的尾部**不能改一个字**，而且必须一次到位、有可见记录。
 *
 * 「段内改写一个字节」两个操作都不是 ⇒ 不允许。这是这条不变量唯一的出口形状。
 */
export const SEGMENT_BOUNDARY_KINDS = ['new', 'pop'] as const;

/** 段操作类型 */
export type SegmentBoundaryKind = (typeof SEGMENT_BOUNDARY_KINDS)[number];

/**
 * `new` 的原因：换会话 / 换 body / rotate / 压缩 —— 都是「这一段到此为止，下一段
 * 从空白前缀开始」。压缩按 0.52 裁定 = 开新会话，所以落在 `new`。
 */
export const SEGMENT_NEW_CAUSES = ['session_switch', 'compaction'] as const;

/**
 * `pop` 的原因：只丢尾部。
 *
 * - `rewind` / `branch`：回到历史某点，后面的尾部不要了；
 * - `context_trim`：超限重试裁剪，**必须一次到位**（不许每轮右移）。
 *
 * 注意 `context_trim` 放在这里而不是 `new`：它不该合法化「改写中段」——
 * 现在 EU 的工具结果滑窗占位（V1）正是拿 `context_trim` 去解释一次**中段改写**，
 * 换成两维模型之后它当场就红了（pop 不能解释中段改写）。
 */
export const SEGMENT_POP_CAUSES = ['rewind', 'branch', 'context_trim'] as const;

/** 段操作原因 */
export type SegmentBoundaryCause =
  | (typeof SEGMENT_NEW_CAUSES)[number]
  | (typeof SEGMENT_POP_CAUSES)[number];

/** 原因 → 段操作。白名单外的原因没有映射（门禁会红）。 */
export const SEGMENT_KIND_BY_CAUSE: Readonly<Record<string, SegmentBoundaryKind>> = {
  branch: 'pop',
  compaction: 'new',
  context_trim: 'pop',
  rewind: 'pop',
  session_switch: 'new',
};

/** 这个字符串是不是登记过的段操作。 */
export function isSegmentBoundaryKind(kind: string): kind is SegmentBoundaryKind {
  return (SEGMENT_BOUNDARY_KINDS as readonly string[]).includes(kind);
}

/** 这个字符串是不是登记过的段操作原因。 */
export function isSegmentBoundaryCause(cause: string): cause is SegmentBoundaryCause {
  return SEGMENT_KIND_BY_CAUSE[cause] !== undefined;
}

/**
 * 既有词表 `PrefixChangeReason` 到段操作的归类（只列**允许存在**的 reason）。
 *
 * 0.52 裁定：`system_revision`（system 声明为 appendable，环境块按位置追加）/
 * `tools_changed` / `model_changed` / `resume`（S1c 重启卡是追加，算续段）**删掉**，
 * 不许再出现在词表里 —— 它们是把「重新 seed 出不同前缀」合法化的洗白通道。
 * 见 `BANNED_PREFIX_REASONS` 与门禁 R6。
 */
export const SEGMENT_KIND_BY_PREFIX_REASON: Readonly<Record<string, SegmentBoundaryKind>> = {
  branch: 'pop',
  compaction: 'new',
  context_trim: 'pop',
  session_switch: 'new',
};

/**
 * 必须从 `PrefixChangeReason` 里消失的 reason（附理由）。
 *
 * 门禁 R6 做两件事：解析词表联合类型（有就红）+ 在 `packages/core/src` 里找这些
 * 字面量的调用点（有就红）。理由写在这里，是为了让人改的时候先看到「为什么删」。
 */
export const BANNED_PREFIX_REASONS: Readonly<Record<string, string>> = {
  model_changed: '换模型不改请求消息；要换就把新模型的选择写进新段的 cause',
  resume: 'S1c 重启卡是追加到尾部，算续段（R7），不是新段',
  system_revision: 'system 可 append；改前缀 = 重新 seed = 洗白（V-new-run）',
  tools_changed: '工具表变化不改消息序列；确实要改就换会话（new/session_switch）',
};

/**
 * 每个**原因**至少要有的可见记录（事件类型）。
 *
 * 按 cause 而不是按操作核：用户要看到的是「因为什么断了这次」，只看到 `new`
 * 没有意义。R5 核对：该事件在 tier 表里不是 `internal`，或带 notice / card 投影。
 */
export const SEGMENT_CAUSE_RECORD_EVENTS: Readonly<
  Record<SegmentBoundaryCause, readonly string[]>
> = {
  branch: ['session.forked'],
  compaction: ['context.compacted', 'agent.compact_forked'],
  context_trim: ['context.cleared_tool_result'],
  rewind: ['session.rewound'],
  session_switch: ['agent.session.activated'],
};

/** 一组段操作 → 该操作的可见记录事件（= 其各 cause 的记录事件并集）。 */
export function segmentRecordEvents(kind: SegmentBoundaryKind): readonly string[] {
  const causes = kind === 'new' ? [...SEGMENT_NEW_CAUSES] : [...SEGMENT_POP_CAUSES];
  const events = new Set<string>();
  for (const cause of causes) {
    for (const event of SEGMENT_CAUSE_RECORD_EVENTS[cause] ?? []) events.add(event);
  }
  return [...events];
}

/**
 * 投影序列 `prev` 是不是 `next` 的（逐字节）前缀 —— `pop` 的判据：
 * pop 之后的下一次请求必须是 pop 前那次请求的前缀（只许丢尾，不许改字）。
 */
export function isPrefixSequence(prev: readonly Message[], next: readonly Message[]): boolean {
  if (prev.length > next.length) return false;
  const left = toProviderPayload(prev);
  const right = toProviderPayload(next);
  for (let index = 0; index < left.length; index += 1) {
    const before = left[index];
    const after = right[index];
    if (!before || !after) return false;
    if (canonicalJson(before) !== canonicalJson(after)) return false;
  }
  return true;
}
