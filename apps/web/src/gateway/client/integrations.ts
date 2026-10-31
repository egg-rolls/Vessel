/**
 * Integrations / 观测域方法：tools、config、tenants、health、metrics、MCP、Feishu、evals。
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
  TenantInfo,
  TenantResponse,
  ToolInfo,
  ToolPolicy,
  ToolPolicyResult,
} from '../types';
import { canFallbackToRest } from './rpc';
import { TeamsClient } from './teams';

export abstract class IntegrationsClient extends TeamsClient {
  /** 工具目录：canonical RPC 优先，旧 gateway 回退 WS legacy `tools.list`。 */
  async listTools(): Promise<ToolInfo[]> {
    try {
      const body = await this.rpc<{ tools?: ToolInfo[] }>('tools.list');
      return body.tools ?? [];
    } catch (error) {
      if (!canFallbackToRest(error)) throw error;
      const body = await this.request<{ tools?: ToolInfo[] }>('tools.list');
      return body.tools ?? [];
    }
  }

  getCapabilities(): Promise<CapabilityManifest> {
    return this.rpc<CapabilityManifest>('capabilities.list');
  }

  async getConfig(tenantId?: string): Promise<ConfigResponse> {
    return this.rpc<ConfigResponse>(
      'config.get',
      tenantId !== undefined ? { tenant_id: tenantId } : {},
    );
  }

  async getConfigSources(tenantId?: string): Promise<ConfigSourcesResponse> {
    return this.rpc<ConfigSourcesResponse>(
      'config.sources',
      tenantId !== undefined ? { tenant_id: tenantId } : {},
    );
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

  async listTenants(): Promise<TenantInfo[]> {
    const body = await this.rpc<{ tenants?: TenantInfo[] }>('tenants.list');
    return body.tenants ?? [];
  }

  async createTenant(
    tenantId: string,
    options: { name?: string; quota?: Record<string, number> } = {},
  ): Promise<TenantInfo> {
    const body = await this.rpc<TenantResponse>('tenants.create', {
      tenant_id: tenantId,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.quota !== undefined ? { quota: options.quota } : {}),
    });
    return body.tenant;
  }

  async updateTenant(
    tenantId: string,
    options: {
      name?: string;
      status?: 'active' | 'disabled';
      quota?: Record<string, number>;
    } = {},
  ): Promise<TenantInfo> {
    const body = await this.rpc<TenantResponse>('tenants.update', {
      tenant_id: tenantId,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.quota !== undefined ? { quota: options.quota } : {}),
    });
    return body.tenant;
  }

  async getHealth(): Promise<HealthResponse> {
    return this.rpc<HealthResponse>('health.get');
  }

  async getTenantId(): Promise<string | undefined> {
    const body = await this.rpc<{ tenant_id?: string }>('health.get');
    return body.tenant_id;
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

  reconnectMcp(name: string): Promise<{ ok: boolean; tenant_id: string }> {
    return this.rpc<{ ok: boolean; tenant_id: string }>('mcp.reconnect', { name });
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
