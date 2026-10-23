/**
 * 成员状态 → 展示元数据（纯函数）。
 *
 * 三层状态彼此独立：`membership`（present / left）、`presence`（live / gone）
 * 与 engine `state`。展示优先级固定为 left > gone > state，避免把离线成员
 * 显示成“正在工作”，也避免把终端状态当成在线。
 */
import type { TeamMember } from '../../gateway/types';

export type MemberStatusKind =
  | 'left'
  | 'gone'
  | 'closed'
  | 'waiting'
  | 'running'
  | 'idle'
  | 'unknown';

export type MemberTone = 'muted' | 'info' | 'warn' | 'danger' | 'ok';

export interface MemberStatusView {
  kind: MemberStatusKind;
  /** i18n key；由组件调用 t()，本模块不依赖 i18n。 */
  labelKey: string;
  /** StatusChip 的 status 值。 */
  chipStatus: string;
  tone: MemberTone;
  /** terminal 状态把“上一轮结果”作为 chip title。 */
  titleKey?: string;
}

const TERMINAL_STATE_KEYS: Record<string, string> = {
  completed: 'team.state.completed',
  failed: 'team.state.failed',
  cancelled: 'team.state.cancelled',
};

const IDLE: MemberStatusView = {
  kind: 'idle',
  labelKey: 'team.state.idle',
  chipStatus: 'idle',
  tone: 'muted',
};

const UNKNOWN: MemberStatusView = {
  kind: 'unknown',
  labelKey: 'team.state.unknown',
  chipStatus: 'unknown',
  tone: 'muted',
};

export function memberStatus(member: TeamMember | undefined): MemberStatusView {
  if (member?.membership === 'left') {
    return {
      kind: 'left',
      labelKey: 'team.membership.left',
      chipStatus: 'disabled',
      tone: 'muted',
    };
  }
  if (!member) return UNKNOWN;
  if (member.presence === 'gone') {
    return {
      kind: 'gone',
      labelKey: 'team.presence.gone',
      chipStatus: 'unavailable',
      tone: 'muted',
    };
  }

  const raw = (member.state ?? '').trim().toLowerCase();
  switch (raw) {
    case 'running':
      return {
        kind: 'running',
        labelKey: 'team.state.running',
        chipStatus: 'running',
        tone: 'info',
      };
    case 'waiting_permission':
      return {
        kind: 'waiting',
        labelKey: 'team.state.waitingPermission',
        chipStatus: 'waiting',
        tone: 'warn',
      };
    case 'closed':
      return {
        kind: 'closed',
        labelKey: 'team.state.closed',
        chipStatus: 'closed',
        tone: 'muted',
      };
    case 'created':
    case 'idle':
      return IDLE;
    default: {
      const titleKey = TERMINAL_STATE_KEYS[raw];
      if (titleKey) return { ...IDLE, titleKey };
      return UNKNOWN;
    }
  }
}

/** present 且 live 才是真正的“在线（可见）”。 */
export function isOnlineMember(member: TeamMember): boolean {
  return member.membership === 'present' && member.presence === 'live';
}
