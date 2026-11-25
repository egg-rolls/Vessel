/**
 * 会话引用（拖拽会话卡 → 输入框 chip）的纯函数层：拖拽载荷、解析、渐进披露。
 *
 * 为什么不走 `MessageRef` / `runs.start refs`：那条通道是**文件附件**（服务端强校验
 * 绝对路径 + `file|image|document` 闭集），会话引用没有路径；`runs.start` 也没有
 * 团队 `@mention` 那样的结构化 mentions 字段。所以 chip 在输入框里是结构化草稿状态
 * （`composerDraftStore.sessionRefs`），发送时序列化为可读引用文本前置进正文
 * （`composeSessionRefText`，见 useChatSubmit）——接收 agent 直接读到被引用会话的
 * 基础链（会话名 / agent / 团队 / 节点 / session_id）。
 *
 * 渐进披露：chip 恒显会话名；agent 名有则显；**跨团队**才显 team 徽章、**跨节点**
 * 才显 node 徽章（与当前会话 scope 比较，同队同节点只剩会话 + agent）。
 * 节点 / 团队名与卡片第二行地址同一基准（roster 的 `node.name` / `team_id`），
 * 不另走 `useNodeNames` 的 health-name 通道 —— 同一个节点在卡片与 chip 上必须同名。
 */
import type { SessionInfo } from '../../gateway/types';
import { sessionTitle } from '../../state/sessions';
import type { ComposerSessionRef } from '../../stores/composerDraftStore';

/** chip 的结构类型与草稿槽共用一份（stores 不反向依赖 domains）。 */
export type SessionRefChip = ComposerSessionRef;

/**
 * 拖拽载荷的自定义 MIME（`dataTransfer.setData` / `getData` 的键）。
 * drop 侧只认这个类型：普通文本 / 文件拖入不触发会话引用，textarea 原生文本拖放不变。
 */
export const SESSION_REF_MIME = 'application/x-vessel-session-ref';

/** 渐进披露的比较基准：当前会话所在节点 / 团队（草稿态 = 当前节点、无团队）。 */
export interface SessionRefScope {
  node?: string;
  team?: string;
}

/** roster 派生的 agent 地址（`session-agent-labels.ts#agentAddressesById` 的值形状）。 */
export interface SessionRefAddress {
  node: string;
  team?: string;
}

/**
 * 会话卡 → 拖拽载荷。结构化来源优先（`session.agent` + `agentAddressesById`）；
 * 旧 gateway 不下发 `session.agent` 时回落到地址串（`name@node:team`）解析，
 * 只补缺失字段，不覆盖结构化值。
 */
export function sessionRefPayloadOf(
  session: SessionInfo,
  addressesById?: ReadonlyMap<string, SessionRefAddress>,
  agentAddresses?: ReadonlyMap<string, string>,
): SessionRefChip {
  const agentId = session.agent?.id;
  const address = agentId !== undefined ? addressesById?.get(agentId) : undefined;
  let agentName = session.agent?.name?.trim() || undefined;
  let node = address?.node;
  let team = address?.team;

  const addressLine = agentAddresses?.get(session.session_id);
  if (addressLine !== undefined && (agentName === undefined || node === undefined)) {
    const at = addressLine.indexOf('@');
    if (at > 0) {
      if (agentName === undefined) agentName = addressLine.slice(0, at);
      if (node === undefined) {
        const rest = addressLine.slice(at + 1);
        const colon = rest.indexOf(':');
        node = colon >= 0 ? rest.slice(0, colon) : rest;
        if (team === undefined && colon >= 0) team = rest.slice(colon + 1);
      }
    }
  }

  return {
    sessionId: session.session_id,
    title: sessionTitle(session),
    ...(agentName !== undefined && agentName !== '' ? { agentName } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(team !== undefined && team !== '' ? { team } : {}),
    ...(node !== undefined && node !== '' ? { node } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * drop 侧解析 `dataTransfer` 载荷：形状不对返回 null（不抛错、不造半个 chip）。
 * `sessionId` 必须非空；`title` 缺失 / 空时退回 sessionId（与 `sessionTitle` 同口径）。
 */
export function parseSessionRefPayload(raw: string): SessionRefChip | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { sessionId } = parsed;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const title =
    typeof parsed.title === 'string' && parsed.title.length > 0 ? parsed.title : sessionId;
  const chip: {
    sessionId: string;
    title: string;
    agentName?: string;
    agentId?: string;
    team?: string;
    node?: string;
  } = { sessionId, title };
  for (const field of ['agentName', 'agentId', 'team', 'node'] as const) {
    const value = parsed[field];
    if (typeof value === 'string' && value.length > 0) chip[field] = value;
  }
  return chip;
}

/**
 * 渐进披露徽章：agent 名有则显；team / node 只在与当前 scope **不同**时显。
 * scope 未知（undefined）时不藏信息 —— 无法比较就全显，绝不猜「大概同队」。
 */
export function sessionRefBadges(
  chip: SessionRefChip,
  scope: SessionRefScope | undefined,
): string[] {
  const badges: string[] = [];
  if (chip.agentName) badges.push(chip.agentName);
  if (chip.team && chip.team !== scope?.team) badges.push(chip.team);
  if (chip.node && chip.node !== scope?.node) badges.push(chip.node);
  // 去重：agent / team / node 同名时徽章只留一个（同值重复不携带信息，
  // 渲染侧也拿它当 React key，必须唯一）。
  return [...new Set(badges)];
}

/** 可读地址 `agent@node:team`（缺段降级：`agent@node` / `agent` / `node:team`）。 */
export function sessionRefAddressOf(chip: SessionRefChip): string | undefined {
  const scope = chip.node && chip.team ? `${chip.node}:${chip.team}` : (chip.node ?? chip.team);
  if (chip.agentName && scope) return `${chip.agentName}@${scope}`;
  return chip.agentName ?? scope;
}

/** chip 悬浮说明：完整基础链 + session_id（披露只影响徽章，tooltip 恒给全量）。 */
export function sessionRefDescription(chip: SessionRefChip): string {
  const address = sessionRefAddressOf(chip);
  const tail = `session: ${chip.sessionId}`;
  return address !== undefined ? `${address} · ${tail}` : tail;
}
