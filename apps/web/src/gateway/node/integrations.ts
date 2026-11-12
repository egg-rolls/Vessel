/**
 * Integrations / 观测域方法：tools、config、health、metrics、MCP、Feishu、evals。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import type {
  CapabilityManifest,
  ConfigResponse,
  ConfigSourcesResponse,
  EvalReport,
  EvalReportResponse,
  EvalRunResponse,
  FeishuResponse,
  FeishuStatus,
  GatewayReloadResult,
  HealthResponse,
  McpServerStatus,
  McpServersResponse,
  MetricsResponse,
  MetricsSnapshot,
  PluginListItem,
  ToolInfo,
  ToolListResponse,
  ToolPolicy,
  ToolPolicyResult,
} from '../types';
import { canFallbackToRest } from './rpc';
import { TeamsClient } from './teams';

export abstract class IntegrationsClient extends TeamsClient {
  /** 工具目录：canonical RPC 优先，旧 gateway 回退 WS legacy `tools.list`。 */
  async listTools(): Promise<ToolInfo[]> {
    const body = await this.listToolsRaw();
    return body.tools ?? [];
  }

  /**
   * 0.51：某个成员的**真实**工具面（`tools.list{agent_id}`，含 `inbox` 这类成员内置工具）。
   *
   * 旧 gateway 会忽略不认识的参数、照旧回节点插件面（响应里没有 `surface`），
   * 所以调用方按「有没有 `surface`」判断这次是不是真拿到了成员口径 —— 这里不猜、不报错。
   */
  async listToolsForAgent(agentId: string): Promise<ToolListResponse> {
    const body = await this.listToolsRaw({ agent_id: agentId });
    return {
      tools: body.tools ?? [],
      ...(body.surface !== undefined ? { surface: body.surface } : {}),
      ...(body.agent_id !== undefined ? { agent_id: body.agent_id } : {}),
      // 0.51 additive：节点有但该成员拿不到的工具 + 原因。旧 gateway 不返回 ⇒ 保持缺省
      // （界面按「不知道有没有被挡」展示，而不是假装一个都没被挡）。
      ...(body.unavailable !== undefined ? { unavailable: body.unavailable } : {}),
    };
  }

  /** 两种口径共用一条传输：参数为 undefined = 节点插件面（与 0.50 的请求逐字节一致）。 */
  private async listToolsRaw(params?: { agent_id: string }): Promise<ToolListResponse> {
    try {
      return await this.rpc<ToolListResponse>('tools.list', params);
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      return await this.request<ToolListResponse>('tools.list', params);
    }
  }

  getCapabilities(): Promise<CapabilityManifest> {
    return this.rpc<CapabilityManifest>('capabilities.list');
  }

  /**
   * `plugins.list`：只读渲染所需字段。`contributions` 是 additive（CONTRACT-0.43
   * §2.7），旧 gateway / 能力插件不返回时按空贡献处理。
   */
  async listPlugins(): Promise<PluginListItem[]> {
    try {
      const body = await this.rpc<{ plugins?: PluginListItem[] }>('plugins.list', {});
      return body.plugins ?? [];
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.request<{ plugins?: PluginListItem[] }>('plugins.list');
      return body.plugins ?? [];
    }
  }

  async getConfig(): Promise<ConfigResponse> {
    return this.rpc<ConfigResponse>('config.get', {});
  }

  async getConfigSources(): Promise<ConfigSourcesResponse> {
    return this.rpc<ConfigSourcesResponse>('config.sources', {});
  }

  /** 0.15：只写服务端白名单键；未注入 writer 时返回 not_found。 */
  setConfigValue(
    key: string,
    value: string | boolean,
  ): Promise<{ ok: boolean; key: string; value: string | boolean }> {
    return this.rpc('config.set', { key, value });
  }

  /**
   * 写入单个工具的确认策略（canonical `permissions.setToolPolicy`）。
   * 旧 gateway 没有该方法，调用方须先用 `capabilities.list` 判定是否可用。
   */
  setToolPolicy(tool: string, policy: ToolPolicy): Promise<ToolPolicyResult> {
    return this.rpc<ToolPolicyResult>('permissions.setToolPolicy', { tool, policy });
  }

  /**
   * 热应用（canonical `gateway.reload`）。
   * 只接受 serve 声明的 scope；写策略后调 `['permission']` 让存活 runtime 换规则。
   */
  reload(scopes: string[]): Promise<GatewayReloadResult> {
    return this.rpc<GatewayReloadResult>('gateway.reload', { scopes });
  }

  async getHealth(): Promise<HealthResponse> {
    return this.rpc<HealthResponse>('health.get');
  }

  /** metrics：优先 canonical `metrics.get`（可带 source），旧 gateway 回退 REST。 */
  async getMetricsSnapshot(source: 'live' | 'trace' = 'live'): Promise<{
    metrics: MetricsSnapshot;
    source: 'live' | 'trace';
  }> {
    try {
      const body = await this.rpc<{ metrics: MetricsSnapshot; source: 'live' | 'trace' }>(
        'metrics.get',
        { source },
      );
      return body;
    } catch (error) {
      if (source === 'live' && canFallbackToRest(error)) {
        const body = await this.httpJson<MetricsResponse>('/v1/metrics');
        return { metrics: body.metrics, source: 'live' };
      }
      throw error;
    }
  }

  resetMetrics(): Promise<{ ok: boolean }> {
    return this.rpc<{ ok: boolean }>('metrics.reset', {});
  }

  reconnectMcp(name: string): Promise<{ ok: boolean }> {
    return this.rpc<{ ok: boolean }>('mcp.reconnect', { name });
  }

  runEval(suite: string): Promise<EvalReport> {
    return this.rpc<EvalRunResponse>('evals.run', { suite }).then((body) => body.report);
  }

  /** MCP server 连接状态快照：canonical `mcp.list` 优先，旧 gateway 回退 REST。 */
  async listMcpServers(): Promise<McpServerStatus[]> {
    try {
      const body = await this.rpc<McpServersResponse>('mcp.list', {});
      return body.servers ?? [];
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.httpJson<McpServersResponse>('/v1/mcp/servers');
      return body.servers ?? [];
    }
  }

  async getMetrics(source: 'live' | 'trace' = 'live'): Promise<MetricsSnapshot> {
    return (await this.getMetricsSnapshot(source)).metrics;
  }

  async getFeishuStatus(): Promise<FeishuStatus> {
    try {
      const body = await this.rpc<FeishuResponse>('feishu.status', {});
      return body.channel;
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.httpJson<FeishuResponse>('/v1/channels/feishu');
      return body.channel;
    }
  }

  async getLatestEval(suite: string): Promise<EvalReport> {
    try {
      const body = await this.rpc<EvalReportResponse>('evals.latest', { suite });
      return body.report;
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const query = new URLSearchParams({ suite });
      const body = await this.httpJson<EvalReportResponse>(`/v1/evals/latest?${query.toString()}`);
      return body.report;
    }
  }
}
