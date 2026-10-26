/**
 * 全局节点展示名：优先 `health.get.node.name`（nodeStore 轮询），并把已解析
 * 的名字按 nodeKey 缓存到 sessionStorage。健康检查短暂失败时继续显示上次名字，
 * 不把 UUID / IP 暴露到列表；从未拿到名字时才回退到 URL。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNodes } from '../../gateway/NodeProvider';
import { nodeKeyOf } from '../../gateway/nodes';
import { nodeHealthNames, useNodeStore } from '../../stores/nodeStore';
import { nodeDisplayNames } from './display-names';

const NODE_NAMES_STORAGE_KEY = 'vessel.node-names';

type NameCache = Record<string, string>;

function readNameCache(): NameCache {
  try {
    if (typeof sessionStorage === 'undefined') return {};
    const raw = sessionStorage.getItem(NODE_NAMES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const cache: NameCache = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim() !== '') cache[key] = value;
    }
    return cache;
  } catch {
    return {};
  }
}

function writeNameCache(cache: NameCache): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(NODE_NAMES_STORAGE_KEY, JSON.stringify(cache));
    }
  } catch {
    // 隐私模式 / 配额满：本次页面仍用内存中的名字。
  }
}

function pageOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** 只缓存真正的节点名；node_id / 空值不写缓存。 */
function cacheableName(name: string | undefined, nodeId: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === nodeId) return undefined;
  return trimmed;
}

export function useNodeNames(provided?: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const { nodes } = useNodes();
  const health = useNodeStore((state) => state.health);
  const [cache, setCache] = useState<NameCache>(readNameCache);

  const names = useMemo(() => nodeHealthNames(health), [health]);

  useEffect(() => {
    if (names.size === 0) return;
    const next: NameCache = {};
    for (const [key, name] of names) {
      const node = nodes.find((item) => nodeKeyOf(item) === key);
      const cacheable = cacheableName(name, node?.nodeId);
      if (cacheable) next[key] = cacheable;
    }
    if (Object.keys(next).length === 0) return;
    setCache((previous) => {
      const merged = { ...previous, ...next };
      writeNameCache(merged);
      return merged;
    });
  }, [names, nodes]);

  return useMemo(
    () =>
      nodeDisplayNames(
        nodes.map((node) => {
          const key = nodeKeyOf(node);
          const healthName = provided?.get(key) ?? names.get(key) ?? cache[key];
          return {
            key,
            name: node.name,
            url: node.url,
            ...(node.nodeId ? { nodeId: node.nodeId } : {}),
            ...(healthName ? { healthName } : {}),
          };
        }),
        pageOrigin(),
      ),
    [nodes, provided, names, cache],
  );
}
