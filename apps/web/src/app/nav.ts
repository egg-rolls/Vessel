import type { Domain, Route } from './router';

type SettingsTab = Extract<Route, { domain: 'settings' }>['tab'];

export type PrimaryDomain = Exclude<Domain, 'settings'>;

export interface DomainDef {
  id: Domain;
  label: string;
}

/** 5 个主领域；Settings 固定在底部（D1）。 */
export const DOMAINS: readonly (DomainDef & { id: PrimaryDomain })[] = [
  { id: 'chat', label: '会话' },
  { id: 'runs', label: '运行' },
  { id: 'workflows', label: '工作流' },
  { id: 'integrations', label: '能力' },
  { id: 'observe', label: '可观测' },
];

export const SETTINGS_DOMAIN: DomainDef = { id: 'settings', label: '设置' };

/** 桌面侧栏分组；只影响导航展示，不改变路由。 */
export const NAV_GROUPS: readonly {
  id: string;
  label: string;
  domains: readonly PrimaryDomain[];
}[] = [
  { id: 'chat', label: 'CHAT', domains: ['chat'] },
  { id: 'observe', label: 'OBSERVE', domains: ['runs', 'observe'] },
  { id: 'workflows', label: 'WORKFLOWS', domains: ['workflows'] },
  { id: 'integrations', label: 'INTEGRATIONS', domains: ['integrations'] },
];

export function domainLabel(domain: Domain): string {
  if (domain === 'settings') return SETTINGS_DOMAIN.label;
  return DOMAINS.find((item) => item.id === domain)?.label ?? domain;
}

export function isDomainActive(route: Route, domain: Domain): boolean {
  return route.domain === domain;
}

/** 顶栏路径文本（不放 gateway/token 表单）。 */
export function routeBreadcrumb(route: Route): string {
  switch (route.domain) {
    case 'chat':
      return route.sessionId ? '会话 › 对话' : '会话';
    case 'runs': {
      const tab = route.tab === 'durable' ? '可恢复' : 'Live';
      return route.runId ? `运行 › ${tab} › 详情` : `运行 › ${tab}`;
    }
    case 'workflows':
      return route.workflowId ? '工作流 › 详情' : '工作流';
    case 'integrations':
      return `能力 › ${route.tab === 'mcp' ? 'MCP 服务' : route.tab === 'channels' ? '渠道' : '工具'}`;
    case 'observe':
      return `可观测 › ${route.tab === 'evals' ? '评测' : '指标'}`;
    case 'settings': {
      const labels: Record<SettingsTab, string> = {
        connection: '连接',
        nodes: '节点',
        config: '配置',
        capabilities: '能力清单',
        tenants: '租户',
        appearance: '外观',
      };
      return `设置 › ${labels[route.tab]}`;
    }
  }
}
