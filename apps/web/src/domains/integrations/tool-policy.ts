/**
 * 工具确认策略的纯逻辑（CONTRACT-hot-apply §6/§7）。
 *
 * 三档 `auto` / `ask` / `never` 完全由现有两个数组表达，不为 UI 增加配置字段：
 *   - `auto`   → 工具名写入 `permission.autoApprove`
 *   - `ask`    → 从两个数组移除（回到默认的每次确认）
 *   - `never`  → 工具名写入 `permission.neverAutoApprove`
 *
 * `config.get` 的配置经 redact 处理，但键名仍是 camelCase。
 */

import type { CapabilityManifest, ToolInfo, ToolPolicy } from '../../gateway/types';

/** canonical RPC：写入单个工具的确认策略。 */
export const TOOL_POLICY_METHOD = 'permissions.setToolPolicy';

/** 当前必须满足的配置数组（只读视图）。 */
export interface PermissionLists {
  autoApprove: readonly string[];
  neverAutoApprove: readonly string[];
}

export const EMPTY_PERMISSION_LISTS: PermissionLists = {
  autoApprove: [],
  neverAutoApprove: [],
};

export interface ToolPolicyOption {
  id: ToolPolicy;
  labelKey: string;
  hintKey: string;
}

/** 三档顺序与文案 key；`ask` 是缺省档。 */
export const TOOL_POLICY_OPTIONS: readonly ToolPolicyOption[] = [
  {
    id: 'auto',
    labelKey: 'integrations.tools.policyAuto',
    hintKey: 'integrations.tools.policyAutoHint',
  },
  {
    id: 'ask',
    labelKey: 'integrations.tools.policyAsk',
    hintKey: 'integrations.tools.policyAskHint',
  },
  {
    id: 'never',
    labelKey: 'integrations.tools.policyNever',
    hintKey: 'integrations.tools.policyNeverHint',
  },
];

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/** 从 `config.get` 返回的（已 redact 的）配置读取 permission 两个数组；缺失当作空。 */
export function readPermissionLists(config: unknown): PermissionLists {
  if (config === null || typeof config !== 'object') return EMPTY_PERMISSION_LISTS;
  const permission = (config as Record<string, unknown>).permission;
  if (permission === null || typeof permission !== 'object') return EMPTY_PERMISSION_LISTS;
  const record = permission as Record<string, unknown>;
  return {
    autoApprove: stringList(record.autoApprove),
    neverAutoApprove: stringList(record.neverAutoApprove),
  };
}

/**
 * `tool.action` 形式的按动作条目（例如 `agent.close`）。
 * 它只收窄该动作，不再把整个工具判成 never，因此单独检测。
 */
function matchesScoped(entries: readonly string[], tool: string): boolean {
  const prefix = `${tool}.`;
  return entries.some((entry) => entry.startsWith(prefix));
}

/** 当前档位：只看 **exact** 条目；`tool.*` 属于 scoped 提示，不参与整档判定。 */
export function toolPolicyOf(lists: PermissionLists, tool: string): ToolPolicy {
  if (lists.neverAutoApprove.includes(tool)) return 'never';
  if (lists.autoApprove.includes(tool)) return 'auto';
  return 'ask';
}

/** 是否存在 `tool.*` 形式的强制确认条目（如 `agent.close`）。 */
export function hasScopedNever(lists: PermissionLists, tool: string): boolean {
  return matchesScoped(lists.neverAutoApprove, tool);
}

/** 现有的按动作条目（`tool.*`），来自两个数组；逐项控件按它们各自的 exact 档位展示。 */
export function scopedEntries(lists: PermissionLists, tool: string): string[] {
  const prefix = `${tool}.`;
  const entries = new Set<string>();
  for (const entry of [...lists.autoApprove, ...lists.neverAutoApprove]) {
    if (entry.startsWith(prefix)) entries.add(entry);
  }
  return [...entries].sort();
}

/** 所有工具都可配置确认策略；保留为显式判据，避免再次引入工具白名单。 */
export function isPolicyEditable(_tool: Pick<ToolInfo, 'name' | 'has_permission_check'>): boolean {
  return true;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((entry) => seen.has(entry));
}

/** 两组权限数组是否等价（忽略顺序）。 */
export function permissionListsEqual(a: PermissionLists, b: PermissionLists): boolean {
  return (
    sameStringSet(a.autoApprove, b.autoApprove) &&
    sameStringSet(a.neverAutoApprove, b.neverAutoApprove)
  );
}

/**
 * 保存后本地快照的让位规则：RPC 返回的 `written` 一直保留，
 * 直到刷新后的 `config.get` 与它等价才清空（避免 config 对象身份变化就丢失新档位）。
 */
export function nextWritten(
  written: PermissionLists | null,
  fromConfig: PermissionLists,
): PermissionLists | null {
  if (written === null) return null;
  return permissionListsEqual(fromConfig, written) ? null : written;
}

/**
 * gateway 是否提供 `permissions.setToolPolicy`。
 * 旧 gateway 缺该方法时控件禁用，提示需要更新的 gateway。
 */
export function supportsToolPolicy(
  manifest: Pick<CapabilityManifest, 'methods'> | null | undefined,
): boolean {
  if (!manifest) return false;
  return manifest.methods.some((method) => method.name === TOOL_POLICY_METHOD);
}

/** 详情弹窗用的一行说明 key（当前档位对应的语义）。 */
export function policyHintKey(policy: ToolPolicy): string {
  return (
    TOOL_POLICY_OPTIONS.find((option) => option.id === policy)?.hintKey ??
    'integrations.tools.policyAskHint'
  );
}

const POLICY_LABEL_KEYS: Record<ToolPolicy, string> = {
  auto: 'integrations.tools.policyAuto',
  ask: 'integrations.tools.policyAsk',
  never: 'integrations.tools.policyNever',
};

const SCOPED_POLICY_LABEL_KEYS: Record<ToolPolicy, string> = {
  ...POLICY_LABEL_KEYS,
  // scoped never 只阻止自动放行，不等于 exact never 的“强制确认”。
  never: 'integrations.tools.policyScopedNeverOn',
};

/** 档位标签 key；scoped 行的 `never` 语义更窄。 */
export function policyLabelKey(policy: ToolPolicy, scoped = false): string {
  return (scoped ? SCOPED_POLICY_LABEL_KEYS : POLICY_LABEL_KEYS)[policy];
}

/** scoped 行在 `never` 档位下的说明 key；其余档位沿用 exact 文案。 */
export function scopedPolicyHintKey(policy: ToolPolicy): string {
  return policy === 'never' ? 'integrations.tools.policyScopedNeverHint' : policyHintKey(policy);
}
