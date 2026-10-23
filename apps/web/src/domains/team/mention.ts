/**
 * Team `@` 解析与过滤（纯函数，无 React）。
 *
 * - 只从 `membership === 'present'` 的 roster 生成候选；
 * - 触发条件：光标前是行首或空白后的 `@`，单词中间的 `@` 不触发；
 * - 提交的是结构化 `agent_id`；正文里没有 chip 的 `@name` 只是普通文本，
 *   本模块不提供“从正文反解 mention”的路径。
 */
import type { TeamMember } from '../../gateway/types';

/** `teams.post` 的 UTF-8 正文上限（64 KiB）。 */
export const MAX_MESSAGE_BYTES = 64 * 1024;

export interface MentionTrigger {
  /** `@` 在文本中的下标。 */
  start: number;
  /** `@` 之后到光标之间的过滤词（不含空白）。 */
  query: string;
}

export interface MentionCandidate {
  agentId: string;
  /** 展示文案：有 name 用 name；重名附 id 前 8 位；无 name 用完整 id。 */
  label: string;
  member: TeamMember;
}

export interface MentionChip {
  agentId: string;
  label: string;
}

/** 行首或空白后的 `@` 才算触发；`hi@bob` 不触发。 */
export function detectMention(value: string, caret: number): MentionTrigger | null {
  if (!Number.isFinite(caret) || caret < 0 || caret > value.length) return null;
  const before = value.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start < 0) return null;
  if (start > 0) {
    const previous = before[start - 1] ?? '';
    if (!/\s/.test(previous)) return null;
  }
  const query = before.slice(start + 1);
  if (/\s/.test(query)) return null;
  return { start, query };
}

export function memberDisplayName(member: TeamMember): string {
  const name = member.name?.trim();
  return name && name.length > 0 ? name : member.agent_id;
}

export function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId;
}

function presentDisplayNames(members: readonly TeamMember[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const member of members) {
    if (member.membership !== 'present') continue;
    const name = member.name?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * 只保留 present 成员；按 name / id 过滤。重名候选显示 `name (id8)`，
 * 提交仍使用完整 `agent_id`。
 */
export function mentionCandidates(
  members: readonly TeamMember[],
  query: string,
  limit = 8,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const nameCounts = presentDisplayNames(members);
  const candidates: MentionCandidate[] = [];
  for (const member of members) {
    if (member.membership !== 'present') continue;
    const name = member.name?.trim();
    const haystack = `${name ?? ''} ${member.agent_id}`.toLowerCase();
    if (needle.length > 0 && !haystack.includes(needle)) continue;
    let label: string;
    if (!name) {
      label = member.agent_id;
    } else if ((nameCounts.get(name) ?? 0) > 1) {
      label = `${name} (${shortAgentId(member.agent_id)})`;
    } else {
      label = name;
    }
    candidates.push({ agentId: member.agent_id, label, member });
  }
  candidates.sort((a, b) => {
    if (a.label === b.label) return a.agentId < b.agentId ? -1 : 1;
    return a.label < b.label ? -1 : 1;
  });
  return candidates.slice(0, Math.max(0, limit));
}

/** 用选中的显示名替换触发片段；返回新正文与光标位置。 */
export function insertMention(
  value: string,
  trigger: MentionTrigger,
  label: string,
): { value: string; caret: number } {
  const end = trigger.start + 1 + trigger.query.length;
  const next = `${value.slice(0, trigger.start)}@${label} ${value.slice(end)}`;
  return { value: next, caret: trigger.start + 1 + label.length + 1 };
}

/**
 * 发送用的 mention id：只来自 chips，去重并保持首次出现顺序。
 * 正文里的 `@name` 不参与解析。
 */
export function mentionIds(chips: readonly MentionChip[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const chip of chips) {
    if (seen.has(chip.agentId)) continue;
    seen.add(chip.agentId);
    ids.push(chip.agentId);
  }
  return ids;
}

/** UTF-8 字节数（`teams.post` 上限按字节，不按字符）。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function exceedsMessageLimit(text: string): boolean {
  return utf8ByteLength(text) > MAX_MESSAGE_BYTES;
}
