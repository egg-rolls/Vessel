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
import { t } from '../../i18n';
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

/**
 * 发送序列化：chip → 可读引用块，前置进消息正文（空行隔开）。
 *
 * `runs.start` 没有结构化会话引用字段（refs 是文件附件通道，mentions 只在
 * `teams.post`），所以引用以**可读文本**随正文投递 —— 接收 agent 直接读到被引用
 * 会话的基础链，需要深挖时拿着 session_id 自己查。
 *
 * 与 chip 徽章的渐进披露不同：**发送恒带全量信息**（agent / 团队 / 节点有则必写）——
 * 披露是给人在输入框里看的降噪，接收方不该因为「恰好同队」就少知道一段归属。
 * 缺失字段省略，不写空段。无 chip 时原样返回（调用方无需分支）。
 */
export function composeSessionRefText(text: string, chips: readonly SessionRefChip[]): string {
  if (chips.length === 0) return text;
  const lines = chips.map((chip) => {
    const parts = [`「${chip.title}」`];
    if (chip.agentName) parts.push(`${t('chat.sessionRef.field.agent')}: ${chip.agentName}`);
    if (chip.team) parts.push(`${t('chat.sessionRef.field.team')}: ${chip.team}`);
    if (chip.node) parts.push(`${t('chat.sessionRef.field.node')}: ${chip.node}`);
    parts.push(`session_id: ${chip.sessionId}`);
    return `- ${parts.join(' · ')}`;
  });
  return `[${t('chat.sessionRef.header')}]\n${lines.join('\n')}\n\n${text}`;
}

/**
 * 信封头部（块 P0 display lift）：compose 用 `t()` 随 UI locale 写头，历史消息里
 * zh / en 两种拼法都真实存在 —— 解析**双词必认**（legacy 永久保留，不回填不改写）。
 * locale 固定标记是 P1 的事（main 裁④），本批只补读取侧。
 */
const SESSION_REF_HEADERS = ['[引用会话]', '[Referenced sessions]'] as const;

/** 解析出的会话引用信封：chips 至少一条；body 是信封之后的正文（可为空串）。 */
export interface ParsedSessionRefEnvelope {
  chips: SessionRefChip[];
  body: string;
}

/** 一行 `- 「title」 · k: v · … · session_id: id` → chip；形状不对返回 null。 */
function parseSessionRefLine(line: string): SessionRefChip | null {
  const match = /^- 「(.*?)」(?: · (.*))?$/.exec(line);
  if (match === null) return null;
  const rawTitle = match[1] ?? '';
  const fields = new Map<string, string>();
  for (const part of (match[2] ?? '').split(' · ')) {
    const sep = part.indexOf(': ');
    if (sep <= 0) continue;
    fields.set(part.slice(0, sep), part.slice(sep + 2));
  }
  const sessionId = fields.get('session_id');
  if (sessionId === undefined || sessionId.length === 0) return null;
  const agentName = fields.get('agent');
  const team = fields.get('团队') ?? fields.get('team');
  const node = fields.get('节点') ?? fields.get('node');
  return {
    sessionId,
    title: rawTitle.length > 0 ? rawTitle : sessionId,
    ...(agentName !== undefined && agentName.length > 0 ? { agentName } : {}),
    ...(team !== undefined && team.length > 0 ? { team } : {}),
    ...(node !== undefined && node.length > 0 ? { node } : {}),
  };
}

/**
 * 严格解析正文开头的会话引用信封；不是信封返回 null（按原文渲染，零回归）。
 * 只认完整形状：头部行 + ≥1 条 `- …session_id: …` 行 + 空行。
 * **流式硬约束**：信封未收全（缺空行 / 行不完整）同样返回 null —— 与
 * `parseQuoteEnvelope` 逐字同语义，不提升半截信封（否则流式闪烁回归）。
 */
export function parseSessionRefEnvelope(content: string): ParsedSessionRefEnvelope | null {
  const header = SESSION_REF_HEADERS.find((candidate) => content.startsWith(`${candidate}\n`));
  if (header === undefined) return null;
  const rest = content.slice(header.length + 1);
  const end = rest.indexOf('\n\n');
  if (end < 0) return null;
  const lines = rest.slice(0, end).split('\n');
  if (lines.length === 0) return null;
  const chips: SessionRefChip[] = [];
  for (const line of lines) {
    const chip = parseSessionRefLine(line);
    if (chip === null) return null;
    chips.push(chip);
  }
  return { chips, body: rest.slice(end + 2) };
}

/**
 * 渲染提升（块 P0，修与 quote 的不对称）：正文 → 会话引用卡数据 + 剩余正文。
 * 不是信封返回 null。与 `liftQuoteForDisplay` 同族：消费点经 liftBlocks 管线调用。
 */
export function liftSessionRefForDisplay(content: string): ParsedSessionRefEnvelope | null {
  return parseSessionRefEnvelope(content);
}
