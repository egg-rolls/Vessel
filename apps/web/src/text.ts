/**
 * 宿主共享纯文本工具（块 P0 消重复矩阵，probe-block-protocol-report §3）。
 *
 * 零 import 叶模块：stores / domains / 根 typecheck（无 DOM lib）都可消费。
 * 插件 embed 侧因 bundle 隔离保留自有副本（刻意代价，不算债）——这里只收编宿主。
 */

/** UTF-16 高代理项（emoji 等增补平面字符的前半）；截断不得劈开它。 */
export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 字符口径截断（唯一实现）：超过 `max` 个 UTF-16 码元时截到前 `max` 并补 `…`；
 * 截断点恰在高代理项上则退一格（不劈开代理对）。未超长原样返回（不加省略号）。
 *
 * 收编自 quote-ref.quoteSnippetOf 与 StreamItems.truncate（后者原本无代理对保护）。
 * 注意：composerDraftStore.truncateDraftText 是**字节预算**口径（另一算法），
 * 只共用 isHighSurrogate，不并进来。
 */
export function truncateSnippet(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/**
 * 表格 → markdown 文本（唯一实现）：按 header/rows 重建 `| … |` 行。
 * 单元格里内容级的 `|` 重新转义回 `\|`，粘回 markdown 仍是同一张表；
 * 粘进纯文本编辑器也是可读的管道分隔行。
 *
 * 收编自 Markdown.tsx 私有 tableToMarkdown（块 P1）：表格复制与 vessel-block
 * table payload 的渲染投影共用同一序列化，口径不漂移。
 */
export function tableToMarkdown(header: readonly string[], rows: readonly string[][]): string {
  const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|');
  const line = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  const separator = `| ${header.map(() => '---').join(' | ')} |`;
  return [line(header), separator, ...rows.map(line)].join('\n');
}

/**
 * 「同一路径的第几次引用」key（唯一实现）：`<path>#<seen>`，seen 从 0 起。
 * 同一路径可被引用多次，删除回写 / React key 都要认到那一条 —— 只靠 path 反查
 * 会永远命中第一条。收编自 MessageRefs / ToolImageCard / ComposerChrome 三处
 * 同一口径的 occurrence Map 循环。
 *
 * 返回与输入同序的 key 数组（调用方按下标取）；列表不排序不重排时 key 稳定。
 */
export function occurrenceKeys(paths: readonly string[]): string[] {
  const occurrence = new Map<string, number>();
  return paths.map((path) => {
    const seen = occurrence.get(path) ?? 0;
    occurrence.set(path, seen + 1);
    return `${path}#${seen}`;
  });
}
