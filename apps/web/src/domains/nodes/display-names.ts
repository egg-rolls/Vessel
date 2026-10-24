/**
 * Nodes 列表的展示名与搜索（纯函数，便于单测）。
 *
 * 展示名优先级：`health.get` 的 `node.name`（0.25 additive）> `NodeView.name`。
 * 若展示名退化为 node_id（节点没有人类可读名），改用 gateway URL，
 * 保证列表里不出现原始 UUID。重名按列表顺序追加 `-1`、`-2`。
 */
import { displayGatewayUrl } from '../../gateway/url';

export interface NodeDisplayInput {
  /** 路由 / React key 使用的稳定键。 */
  key: string;
  /** NodeProvider 提供的名称（当前节点来自 hello，额外节点来自用户命名）。 */
  name: string;
  nodeId?: string;
  url?: string;
  /** `health.get` 返回的节点展示名；旧 gateway 缺省。 */
  healthName?: string;
}

/**
 * 对展示名去重：第一个保持原名，后续重复项依次追加 `-1`、`-2`。
 * 已占用后缀会继续向后找，避免 `SoulKiller-1` 与生成的同名冲突。
 */
export function dedupeDisplayNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = raw.trim() === '' ? raw : raw.trim();
    let candidate = base;
    let index = 1;
    while (used.has(candidate)) {
      candidate = `${base}-${index}`;
      index += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

/** 节点键本身 / IP / IPv6 / UUID 都不是可展示的人类名。 */
export function isOpaqueNodeName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) return true;
  if (trimmed.includes(':')) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
}

/** 单个节点的基础展示名；不在此处去重。 */
export function baseNodeDisplayName(
  input: Pick<NodeDisplayInput, 'name' | 'nodeId' | 'url' | 'healthName'>,
  pageOrigin = '',
): string {
  const raw = input.healthName?.trim() || input.name?.trim() || '';
  if (raw !== '' && raw !== input.nodeId && !isOpaqueNodeName(raw)) return raw;
  if (input.url !== undefined) return displayGatewayUrl(input.url, pageOrigin);
  return input.nodeId ?? (isOpaqueNodeName(raw) ? '—' : raw);
}

/** 按输入顺序生成 `key → 去重后的展示名`。 */
export function nodeDisplayNames(
  inputs: readonly NodeDisplayInput[],
  pageOrigin = '',
): Map<string, string> {
  const names = dedupeDisplayNames(inputs.map((input) => baseNodeDisplayName(input, pageOrigin)));
  return new Map(inputs.map((input, index) => [input.key, names[index] ?? input.name]));
}

/** 搜索匹配展示名、node_id（可粘贴深链）或 NodeProvider 名称。 */
export function matchesNodeQuery(
  displayName: string,
  nodeId: string | undefined,
  providerName: string,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [displayName, nodeId ?? '', providerName].some((value) =>
    value.toLowerCase().includes(needle),
  );
}
