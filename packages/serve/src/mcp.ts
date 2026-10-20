/**
 * MCP server 状态网关边界（0.3 W1，DECISION-008 §4.4 + Addendum B §9.1）。
 *
 * gateway 只读：asm 把 ext 的 `McpClientPlugin.listServers()` 适配成 `listServers`。
 * 线上只暴露冻结的 `name/status/tools/error`，不透传 transport/protocolVersion/serverInfo。
 *
 * @module @vessel-agent/serve/mcp
 */

/** server 状态（与 ext MCP 控制面一致） */
export type McpServerState = 'connected' | 'failed' | 'disabled';

/** 允许的状态集合 */
export const MCP_SERVER_STATES: readonly McpServerState[] = ['connected', 'failed', 'disabled'];

/** gateway MCP 注入面；缺省 = 端点关闭 */
export interface McpGatewayOptions {
  listServers: () => McpServerStatus[] | Promise<McpServerStatus[]>;
  /** A-3 §10.1：重连指定 server；缺省 = mcp.reconnect 返回 not_found */
  reconnect?: (name: string) => Promise<void> | void;
}

/** 注入方可以返回 ext 的完整状态；gateway 只读取这四个字段 */
export interface McpServerStatus {
  name: string;
  status: McpServerState;
  tools: string[];
  error?: string;
}

/** GET /v1/mcp/servers 的线上形状（冻结字段） */
export interface WireMcpServerStatus {
  name: string;
  status: McpServerState;
  tools: string[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 归一化 provider 返回值：跳过非法条目、同名去重（保留第一条）。
 * provider 数据属于内部输入，缺字段时按最保守的值处理，但绝不抛给调用方。
 */
export function normalizeMcpServers(input: unknown): WireMcpServerStatus[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: WireMcpServerStatus[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const name = item.name;
    const status = item.status;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof status !== 'string' || !MCP_SERVER_STATES.includes(status as McpServerState)) {
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const tools = Array.isArray(item.tools)
      ? item.tools.filter((tool): tool is string => typeof tool === 'string')
      : [];
    const error = typeof item.error === 'string' ? item.error : undefined;
    result.push({
      name,
      status: status as McpServerState,
      tools,
      ...(error !== undefined ? { error } : {}),
    });
  }
  return result;
}
