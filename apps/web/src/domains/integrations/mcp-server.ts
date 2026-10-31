/** `mcp__<server>__<tool>` → server 名；普通工具返回 undefined。 */
export function mcpServerOf(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) return undefined;
  return rest.slice(0, separator);
}
