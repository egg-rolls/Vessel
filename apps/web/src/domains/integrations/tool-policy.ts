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

/**
 * `checkPermission` 恒为 `allow` 的工具：策略控件禁用。
 * `tools.list` 只暴露 `has_permission_check`，不暴露恒安判定，因此这里按工具名保守枚举。
 */
const ALWAYS_ALLOW_TOOLS: ReadonlySet<string> = new Set(['read', 'subscribe']);

/** 即使没有 `checkPermission` 也允许配置策略的能力工具（bash / edit / agent）。 */
const POLICY_EDITABLE_TOOLS: ReadonlySet<string> = new Set(['bash', 'edit', 'agent']);

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
 * 数组条目匹配：工具名精确匹配，或 `tool.action` 形式的前缀匹配
 * （`neverAutoApprove` 支持按动作收窄，见 permission-policy `hitsNeverAutoApprove`）。
 */
function matchesTool(entries: readonly string[], tool: string): boolean {
  return entries.some((entry) => entry === tool || entry.startsWith(`${tool}.`));
}

/** 当前档位：`neverAutoApprove` 命中优先于 `autoApprove`。 */
export function toolPolicyOf(lists: PermissionLists, tool: string): ToolPolicy {
  if (matchesTool(lists.neverAutoApprove, tool)) return 'never';
  if (matchesTool(lists.autoApprove, tool)) return 'auto';
  return 'ask';
}

/** 该工具是否允许改写确认策略（恒 allow / 无权限判定的工具不给伪开关）。 */
export function isPolicyEditable(tool: Pick<ToolInfo, 'name' | 'has_permission_check'>): boolean {
  if (ALWAYS_ALLOW_TOOLS.has(tool.name)) return false;
  return POLICY_EDITABLE_TOOLS.has(tool.name) || tool.has_permission_check;
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
