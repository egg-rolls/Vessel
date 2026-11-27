/**
 * 权限免确认规则的持久化（0.6.1 E7）。
 *
 * 写用户配置 `~/.vessel/config.yaml` 的 `permission.auto_approve`（YAML snake_case）。
 * 语义与 core 的 `autoApprove` 一致：精确匹配工具名。
 *
 * 本模块属于应用层：core 不感知 YAML；TUI 选 "always" 时由 `src/bootstrap.ts`
 * 自动调用 `addAutoApproveRule()`，也可直接调用本模块的显式接口（如未来 `/permissions`）。
 *
 * q-env-card-visibility-fix（缺口B）：读写原语改用 `@vessel-agent/config` 的
 * `readUserConfigRoot` / `writeUserConfigRoot`，写操作统一包 `withConfigLock`
 * （与 `src/config/ui-settings.ts` / `src/plugin/plugin-config.ts` 同一把跨进程单写锁）。
 * 此前本模块自带 readFileSync/writeFileSync 全根 YAML 往返写、不走锁 —— 与用户
 * toggle 的 `config.set` 写同一份文件时，「读 → 写」毫秒窗口互相覆盖（toggle
 * false→true 被旧根快照盖回）。现在「读 → 改 → 写」整体在锁内，覆盖窗口消失。
 * 读侧不加锁：写是临时文件 + rename 原子替换，读到的永远是旧/新完整文件之一。
 * API 因此变为 async（调用方：cli.ts 写盘面 / bootstrap.ts 权限控制面，均已随之 await）。
 *
 * @module vessel/permission-store
 */

import {
  getUserConfigPath,
  readUserConfigRoot,
  withConfigLock,
  writeUserConfigRoot,
} from '../../packages/config/src/index';
import { DEFAULT_NEVER_AUTO_APPROVE } from '../config/permission-defaults';

/** 存储选项 */
export interface PermissionStoreOptions {
  /** 用户配置文件路径；缺省 `~/.vessel/config.yaml` */
  configPath?: string;
}

/** 免确认规则（旧接口；`permission.auto_approve`） */
export type AutoApproveRules = string[];

/** 工具确认策略三档（契约 §7） */
export type ToolPolicy = 'auto' | 'ask' | 'never';

/** 两个规则数组的完整快照 */
export interface ToolPolicySnapshot {
  autoApprove: string[];
  neverAutoApprove: string[];
}

/** 复用的权限规则存储（q-env-card-visibility-fix 起写读均 async：写走 withConfigLock） */
export interface PermissionStore {
  list(): Promise<string[]>;
  add(tool: string): Promise<string[]>;
  remove(tool: string): Promise<string[]>;
  set(rules: string[]): Promise<string[]>;
  /** 两个数组的快照（`auto` / `ask` / `never` 的判定来源） */
  policy(): Promise<ToolPolicySnapshot>;
  /** 三档策略写回：同时维护两个数组；返回写入后的快照 */
  setPolicy(tool: string, policy: ToolPolicy): Promise<ToolPolicySnapshot>;
}

/** 工具名：非空、无控制字符 */
function isValidToolName(tool: unknown): tool is string {
  if (typeof tool !== 'string' || tool.trim() === '') return false;
  for (const char of tool) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function resolveConfigPath(options: PermissionStoreOptions): string {
  return options.configPath ?? getUserConfigPath();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 permission 块读取规则（兼容 auto_approve / autoApprove） */
function readRules(root: Record<string, unknown>): string[] {
  const permission = root.permission;
  if (permission === undefined || permission === null) return [];
  if (!isRecord(permission)) {
    throw new Error('permission_store_invalid_config: permission must be a YAML object');
  }
  const raw = permission.auto_approve ?? permission.autoApprove;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      'permission_store_invalid_config: permission.auto_approve must be a YAML array',
    );
  }
  return normalizeRules(raw.filter((item): item is string => typeof item === 'string'));
}

/** 去重、去空白、保持顺序 */
function normalizeRules(rules: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rules) {
    const name = raw.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 锁内写规则：root 是**同一把锁里刚读到的**快照（读 → 改 → 写不隔锁），
 * permission 块其它键保留。调用方必须已持有 withConfigLock。
 */
async function writeRulesInLock(
  configPath: string,
  root: Record<string, unknown>,
  rules: readonly string[],
): Promise<string[]> {
  const normalized = normalizeRules(rules);
  const existing = root.permission;
  if (existing !== undefined && existing !== null && !isRecord(existing)) {
    throw new Error('permission_store_invalid_config: permission must be a YAML object');
  }
  const permission: Record<string, unknown> = { ...(existing ?? {}) };
  // 统一写 snake_case（仓库 YAML 约定）；清理 camelCase 旧键避免两份规则。
  delete permission.autoApprove;
  permission.auto_approve = normalized;
  root.permission = permission;
  await writeUserConfigRoot(configPath, root);
  return normalized;
}

function assertToolName(tool: string): string {
  if (!isValidToolName(tool)) {
    throw new Error(`invalid_tool_name: ${JSON.stringify(tool)}`);
  }
  return tool.trim();
}

/**
 * 从 permission 块读取 never_auto_approve（兼容 camelCase）。
 *
 * 缺省强制确认键用 perm-F1 的单一真源 `DEFAULT_NEVER_AUTO_APPROVE`（含 `pii_reveal`，
 * 与成员 wiring / `resolveRuntimePermission` 同源）。键缺失时读回它，避免 Web 首次
 * 写盘把默认保护落成 `never_auto_approve: []`。
 */
function readNeverRules(root: Record<string, unknown>): string[] {
  const permission = root.permission;
  // 显式配置（含空数组）优先；只有键缺失才补回运行时默认。
  if (permission === undefined || permission === null) return [...DEFAULT_NEVER_AUTO_APPROVE];
  if (!isRecord(permission)) {
    throw new Error('permission_store_invalid_config: permission must be a YAML object');
  }
  const raw = permission.never_auto_approve ?? permission.neverAutoApprove;
  if (raw === undefined || raw === null) return [...DEFAULT_NEVER_AUTO_APPROVE];
  if (!Array.isArray(raw)) {
    throw new Error(
      'permission_store_invalid_config: permission.never_auto_approve must be a YAML array',
    );
  }
  return normalizeRules(raw.filter((item): item is string => typeof item === 'string'));
}

/**
 * 「不在列表里」的同一份工具名列表（只去掉 exact 目标键；保持顺序）。
 *
 * scoped 键（`tool.*`，例如 `agent.close`）是独立开关：改父工具（`agent`）的档位
 * 不清除它，改 `agent.close` 也不动 `agent`。
 */
function without(rules: readonly string[], tool: string): string[] {
  return rules.filter((rule) => rule !== tool);
}

/** 「在列表里」的同一份工具名列表（追加到末尾；幂等） */
function withTool(rules: readonly string[], tool: string): string[] {
  return rules.includes(tool) ? [...rules] : [...rules, tool];
}

/**
 * 三档策略 → 两个数组（契约 §7：语义完全由现有两个数组表达，不新增字段）。
 * 只增删 exact 目标键；scoped 键（`tool.*`，例如 `agent.close`）是独立开关，
 * 不会被父工具（`agent`）的档位切换清除，反过来也一样。
 * - `auto`：进 `auto_approve`，出 `never_auto_approve`
 * - `ask`：两个都不进（缺省行为）
 * - `never`：进 `never_auto_approve`，出 `auto_approve`
 *
 * 因此给 `agent` 设 `auto` 不会移除默认的 `agent.close` 保护；要放开
 * `agent.close` 必须单独给它设 `auto`。
 */
export function applyToolPolicy(
  snapshot: ToolPolicySnapshot,
  tool: string,
  policy: ToolPolicy,
): ToolPolicySnapshot {
  const autoApprove = without(snapshot.autoApprove, tool);
  const neverAutoApprove = without(snapshot.neverAutoApprove, tool);
  if (policy === 'auto') return { autoApprove: withTool(autoApprove, tool), neverAutoApprove };
  if (policy === 'never')
    return { autoApprove, neverAutoApprove: withTool(neverAutoApprove, tool) };
  return { autoApprove, neverAutoApprove };
}

/**
 * 锁内写两个数组：root 是同一把锁里刚读到的快照；permission 块其它键保留，
 * 统一写 snake_case。调用方必须已持有 withConfigLock。
 */
async function writePolicyInLock(
  configPath: string,
  root: Record<string, unknown>,
  snapshot: ToolPolicySnapshot,
): Promise<ToolPolicySnapshot> {
  const autoApprove = normalizeRules(snapshot.autoApprove);
  const neverAutoApprove = normalizeRules(snapshot.neverAutoApprove);
  const existing = root.permission;
  if (existing !== undefined && existing !== null && !isRecord(existing)) {
    throw new Error('permission_store_invalid_config: permission must be a YAML object');
  }
  const permission: Record<string, unknown> = { ...(existing ?? {}) };
  // 统一写 snake_case；清理 camelCase 旧键避免两份规则。
  delete permission.autoApprove;
  delete permission.neverAutoApprove;
  permission.auto_approve = autoApprove;
  permission.never_auto_approve = neverAutoApprove;
  root.permission = permission;
  await writeUserConfigRoot(configPath, root);
  return { autoApprove, neverAutoApprove };
}

/** 读取当前免确认工具名（文件不存在返回 []） */
export async function listAutoApproveRules(
  options: PermissionStoreOptions = {},
): Promise<string[]> {
  return readRules(await readUserConfigRoot(resolveConfigPath(options)));
}

/** 添加一条 "always" 规则（幂等）；返回写入后的完整列表 */
export async function addAutoApproveRule(
  tool: string,
  options: PermissionStoreOptions = {},
): Promise<string[]> {
  const name = assertToolName(tool);
  const configPath = resolveConfigPath(options);
  return withConfigLock(configPath, async () => {
    const root = await readUserConfigRoot(configPath);
    const rules = readRules(root);
    if (!rules.includes(name)) rules.push(name);
    return writeRulesInLock(configPath, root, rules);
  });
}

/** 删除一条规则（不存在时 no-op）；返回写入后的完整列表 */
export async function removeAutoApproveRule(
  tool: string,
  options: PermissionStoreOptions = {},
): Promise<string[]> {
  const name = assertToolName(tool);
  const configPath = resolveConfigPath(options);
  return withConfigLock(configPath, async () => {
    const root = await readUserConfigRoot(configPath);
    const rules = readRules(root).filter((rule) => rule !== name);
    return writeRulesInLock(configPath, root, rules);
  });
}

/** 整体替换规则；返回规范化后的列表 */
export async function setAutoApproveRules(
  rules: readonly string[],
  options: PermissionStoreOptions = {},
): Promise<string[]> {
  const configPath = resolveConfigPath(options);
  return withConfigLock(configPath, async () => {
    const root = await readUserConfigRoot(configPath);
    return writeRulesInLock(configPath, root, rules);
  });
}

/**
 * 读取两个规则数组（文件 / key 不存在时 autoApprove 为空，neverAutoApprove 返回
 * 运行时默认 `DEFAULT_NEVER_AUTO_APPROVE`；显式配置优先）。
 */
export async function readToolPolicies(
  options: PermissionStoreOptions = {},
): Promise<ToolPolicySnapshot> {
  const root = await readUserConfigRoot(resolveConfigPath(options));
  return {
    autoApprove: readRules(root),
    neverAutoApprove: readNeverRules(root),
  };
}

/**
 * 三档策略写回（契约 §7）。工具名由调用方校验存在性；这里只校验形状。
 * 读 → 判定 → 写整体在同一把 withConfigLock 内（此前读与写分离，并发 toggle
 * 的写入会被旧根快照覆盖 —— 缺口B 的病灶）。
 * @returns 写入后的两个数组
 */
export async function setToolPolicy(
  tool: string,
  policy: ToolPolicy,
  options: PermissionStoreOptions = {},
): Promise<ToolPolicySnapshot> {
  const name = assertToolName(tool);
  const configPath = resolveConfigPath(options);
  return withConfigLock(configPath, async () => {
    const root = await readUserConfigRoot(configPath);
    const current: ToolPolicySnapshot = {
      autoApprove: readRules(root),
      neverAutoApprove: readNeverRules(root),
    };
    return writePolicyInLock(configPath, root, applyToolPolicy(current, name, policy));
  });
}

/** 构造可注入的存储对象（TUI / 测试用） */
export function createPermissionStore(options: PermissionStoreOptions = {}): PermissionStore {
  return {
    list: () => listAutoApproveRules(options),
    add: (tool) => addAutoApproveRule(tool, options),
    remove: (tool) => removeAutoApproveRule(tool, options),
    set: (rules) => setAutoApproveRules(rules, options),
    policy: () => readToolPolicies(options),
    setPolicy: (tool, policy) => setToolPolicy(tool, policy, options),
  };
}
