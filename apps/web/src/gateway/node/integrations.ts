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
   * 同一份工具清单，只是按某具成员身体去读（`tools.list{agent_id}`）。
   *
   * 0.51 起 `agent_id` 只是定位用的诊断参数：响应形状与不传时逐字段相同 —— 成员用的
   * 就是节点那一份工具面，所以没有 `surface` / `source` / `unavailable` 之类第二层字段。
   * 传它的唯一用处是拿到那具身体上运行期注入的 `inbox`（只注册在成员自己的宿主里，
   * 待 inbox 插件化后自然归位到节点面）。
   */
  async listToolsForAgent(agentId: string): Promise<ToolInfo[]> {
    const body = await this.listToolsRaw({ agent_id: agentId });
    return body.tools ?? [];
  }

  /** 唯一的传输路径：`params` 缺省 = 节点口径（与不传 `agent_id` 的请求逐字节一致）。 */
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
