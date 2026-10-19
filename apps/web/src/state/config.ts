/** Config 快照的纯函数：把嵌套 JSON 展平为可搜索的 path/value 行。 */
export interface ConfigEntry {
  path: string;
  value: string;
  type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
}

const MAX_ENTRIES = 2000;
const MAX_DEPTH = 12;

function scalarOf(value: unknown): { text: string; type: ConfigEntry['type'] } {
  if (value === null) return { text: 'null', type: 'null' };
  if (Array.isArray(value)) return { text: `[${value.length}]`, type: 'array' };
  if (typeof value === 'object') {
    return { text: `{${Object.keys(value as object).length}}`, type: 'object' };
  }
  if (typeof value === 'string') return { text: value, type: 'string' };
  return { text: String(value), type: typeof value as 'number' | 'boolean' };
}

/**
 * 深度优先展平；数组按索引展开。超过 2000 项或 12 层时停止，
 * 避免 UI 被超大的 config 卡死。
 */
export function flattenConfig(value: unknown): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (out.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const entries = Object.entries(node as Record<string, unknown>);
      for (const [key, child] of entries) {
        walk(child, path ? `${path}.${key}` : key, depth + 1);
        if (out.length >= MAX_ENTRIES) return;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], `${path}[${index}]`, depth + 1);
        if (out.length >= MAX_ENTRIES) return;
      }
      return;
    }
    const scalar = scalarOf(node);
    out.push({ path, value: scalar.text, type: scalar.type });
  };
  walk(value, '', 0);
  return out;
}

/** 按 path/value 子串过滤（大小写不敏感）。 */
export function filterConfigEntries(entries: readonly ConfigEntry[], query: string): ConfigEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (entry) =>
      entry.path.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle),
  );
}
