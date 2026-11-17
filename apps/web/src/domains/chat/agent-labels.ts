/**
 * 工具卡上的「谁」：内部 id → 人能认的名字（纯函数，无 React / gateway / DOM）。
 *
 * 用户报的现场：`agent` 工具卡的摘要写成 `send → ecfc6a4f-c43c-4ba5-9254-4823eec5beb7`。
 * 查清后是两层，本模块只修**第二层**：
 * 1. 显示逻辑从来就没解析过 —— `agentSummary` 一直回显 `args.to` 的原值；
 * 2. 变的是模型传的参数：早期传名字（`send-first`），后来越来越多传 session id / 会员 id
 *    （schema 明确允许 id，且重名 / rotate 之后 id 才无歧义）。于是摘要把**内部标识**
 *    原样摆到了人面前 —— 宪法第十四条的延伸（面向用户的东西不暴露内部细节）。
 *
 * 所以这里的口径是「能解析就给人名，解析不了给短 id，绝不编名字」：
 * - 命中 roster（agent id / 会员 id / session id / 已退役 body 的 session id）⇒ 那里的 `name`；
 * - 命中不了、但长得就是内部 id（UUID 形状）⇒ 短 id（前 8 位 + `…`，规则见
 *   `pending-strip.ts#shortSenderId`，全站只留这一份）；
 * - 命中不了、也不像 id（旧参数是名字，例如 `send-first`）⇒ **原样**显示。
 *   向后兼容不是可选项：历史卡片里躺着名字，把名字当 id 截断才是一个新 bug。
 *
 * 名字只来自 roster，**不做任何推断**：没有 roster（静态渲染 / 设计预览 / 旧 gateway）时
 * 一律退短 id —— 拿「另一个 agent 的名字」顶替是这个模块最不能犯的错。
 *
 * 为什么是纯函数 + 结构类型：与 `session-agent-labels.ts` 同一分工，门禁 / 驱动可以在
 * Node 里直接 import 它，把 roster 当普通对象喂进来（不牵 React / 连接模块）。
 */

import { shortSenderId } from './pending-strip';
import type { LabelAgent, LabelRoster } from './session-agent-labels';

/** 名字表：agent id / 会员 id / session id（含已退役 body）→ 展示名。 */
export type AgentNameIndex = ReadonlyMap<string, string>;

/** 没有 roster 时的空表：`agentDisplayName` 照样能跑（退短 id）。 */
export const EMPTY_AGENT_NAMES: AgentNameIndex = new Map<string, string>();

/**
 * UUID 形状（8-4-4-4-12）。
 *
 * 只认这个形状的理由：它说「这是内部标识」，而不是「这是短但仍是标识的串」。
 * `m-7` / `send-first` / `sub_1` 这类值一个都不匹配 —— 它们要么是用户 / 模型给的旧参数，
 * 要么本来就只有这么长，截断只会让人更认不出来。
 */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 是不是内部 id 形状（UUID）。 */
export function looksLikeAgentId(value: string): boolean {
  return ID_SHAPE.test(value.trim());
}

function trimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/**
 * roster（`agents.list` + 团队会员表）→ 名字表。
 *
 * 一个 agent 的**每个可能被地址引用**的标识都映射到同一个名字：`id` / `agent_id` /
 * `session_id`（`agent` 工具的 `to` 现在多数是它）、`bodies[].session_id|body_id`
 * 与 `body_history[].session_id`（rotate 之后模型手上可能还是旧身体那具会话的 id）。
 *
 * 只收**有名字**的条目：没名字就没得显示，收个空串反而会顶掉短 id 的降级。
 * 同一个标识被多条 roster 命中时先到先得（roster 顺序稳定，覆盖只会让名字在刷新间跳变）。
 */
export function agentNamesOf(rosters: readonly LabelRoster[]): AgentNameIndex {
  const names = new Map<string, string>();
  const put = (id: string | null | undefined, name: string): void => {
    const key = trimmed(id);
    if (key === undefined) return;
    if (!names.has(key)) names.set(key, name);
  };
  const indexEntry = (entry: LabelAgent): void => {
    const name = trimmed(entry.name);
    if (name === undefined) return;
    put(entry.id, name);
    put(entry.agent_id, name);
    put(entry.session_id, name);
    for (const body of entry.bodies ?? []) {
      put(body?.session_id, name);
      put(body?.body_id, name);
    }
    for (const body of entry.body_history ?? []) put(body?.session_id, name);
  };
  for (const roster of rosters) {
    for (const agent of roster.agents ?? []) indexEntry(agent);
    for (const team of roster.rosters ?? []) {
      for (const member of team.members ?? []) indexEntry(member);
    }
  }
  return names;
}

/**
 * 通用内部标识 → 卡头能读的短形式：UUID 形状 ⇒ 短 id（前 8 位 + `…`），其它原样。
 *
 * 名字表管不到的标识（消息 id / 订阅 id）也走这里：它们本来就没有「人能认的名字」，
 * 但 36 位 UUID 一样不该占满摘要 —— 完整值在展开体的入参里，一个字符都没少。
 */
export function internalIdLabel(label: string | null | undefined): string | undefined {
  const value = trimmed(label);
  if (value === undefined) return undefined;
  return looksLikeAgentId(value) ? shortSenderId(value) : value;
}

/**
 * 一个标识 → 一句能读的标签（本单的核心函数，形状就是 `(label, resolver) => string`）。
 *
 * - `names` 命中 ⇒ 名字；
 * - 不命中但像内部 id ⇒ 短 id（前 8 位 + `…`）；
 * - 其它 ⇒ 原样（旧参数是名字、地址 principal 段、本来就是短 id）。
 *
 * 空 / 纯空白返回 `undefined`（调用方本来就不该渲染一个没有目标的箭头）。
 */
export function agentDisplayName(
  label: string | null | undefined,
  names: AgentNameIndex = EMPTY_AGENT_NAMES,
): string | undefined {
  const value = trimmed(label);
  if (value === undefined) return undefined;
  return names.get(value) ?? internalIdLabel(value);
}

/** 多个成员最多并列几个名字：再长就只报「N 名成员（前两个 等）」。 */
export const MEMBER_LIST_MAX_NAMES = 3;

/**
 * `members[]`（`close` 的成员列表 / 任何多目标）→ 一句摘要。
 *
 * 用户口径：**多于一两个时别把名字串成长句**。所以 1 个给名字、2-3 个逗号并列、
 * 超过 3 个只给「N 名成员（a、b 等）」—— 前两个名字是「确认关的是谁」的最低证据，
 * 再多就是噪音（完整列表在展开体的入参里，一个字符都没少）。
 */
export function membersLabel(
  members: readonly string[],
  names: AgentNameIndex = EMPTY_AGENT_NAMES,
): string | undefined {
  const shown: string[] = [];
  for (const member of members) {
    const label = agentDisplayName(member, names);
    if (label !== undefined) shown.push(label);
  }
  if (shown.length === 0) return undefined;
  if (shown.length <= MEMBER_LIST_MAX_NAMES) return shown.join('、');
  return `${String(shown.length)} 名成员（${shown[0]}、${shown[1]} 等）`;
}
