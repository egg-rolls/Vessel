/**
 * Hash 路由（纯函数，便于单测）。
 *
 * 先处理 `#token=`（由 ConnectionProvider 在初始化时消费），再解析路由。
 * 未知/非法路由回落到 Chat；无法解码的 id 保留原文，不丢深链。
 */

export type Route =
  | { domain: 'chat'; sessionId?: string; agent?: string }
  /** 待批（ask 汇集）：`#/pending[?session=<id>]`，session 只用于默认展开。 */
  | { domain: 'pending'; sessionId?: string }
  /**
   * 运行列表与运行详情页。
   *
   * `runId` 存在即整页详情（`#/runs/<runId>`）；缺省是列表（`#/runs?tab=…`）。
   * 旧深链 `#/runs?tab=live&run=<id>` 仍解析成同一路由（同参数，不重定向）。
   */
  | { domain: 'runs'; tab: 'live' | 'durable'; runId?: string; sessionId?: string }
  | { domain: 'tools' }
  | { domain: 'mcp' }
  | { domain: 'channels' }
  | { domain: 'observe'; tab: 'metrics' | 'evals' | 'diagnostics' | 'attention' }
  /** plugin 页面：`#/plugins/<id>/<entry>`（CONTRACT-0.43 §2.1）。 */
  | { domain: 'plugins'; pluginId?: string; entry?: string }
  | { domain: 'hub' }
  | { domain: 'gateway' }
  | { domain: 'pluginHost' }
  | { domain: 'nodes'; nodeKey?: string }
  | { domain: 'teams' }
  | { domain: 'teams'; nodeKey: string; teamId: string; agentId?: string; bodyId?: string }
  | { domain: 'agents'; nodeKey?: string; teamId?: string; state?: string; presence?: string }
  | { domain: 'capabilities' }
  | { domain: 'visual' }
  | { domain: 'designLab' }
  | { domain: 'settings' };

export type Domain = Route['domain'];

export const DEFAULT_ROUTE: Route = { domain: 'chat' };

const RUN_TABS = new Set(['live', 'durable']);
const INTEGRATION_TABS = new Set(['tools', 'mcp', 'channels']);
const OBSERVE_TABS = new Set(['metrics', 'evals', 'diagnostics', 'attention']);

/** 安全解码：非法百分号编码时保留原值。 */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 查询参数的非空解码值；缺失 / 空串返回 undefined。 */
function queryText(query: URLSearchParams, key: string): string | undefined {
  const value = query.get(key);
  if (value === null || value === '') return undefined;
  return decodeSegment(value);
}

function pick<T extends string>(
  value: string | null,
  allowed: Set<string>,
  fallback: NoInfer<T>,
): T {
  return value !== null && allowed.has(value) ? (value as T) : fallback;
}

/** 解析 location.hash（可带或不带 `#`）。`#token=` 由调用方先剥离。 */
export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const withoutSlash = raw.startsWith('/') ? raw.slice(1) : raw;
  const [pathPart = '', queryPart = ''] = withoutSlash.split('?', 2);
  const rawSegments = pathPart.split('/');
  const segments = rawSegments.filter(Boolean);
  const query = new URLSearchParams(queryPart);
  const domain = segments[0];

  switch (domain) {
    case 'chat': {
      const sessionId = segments[1] !== undefined ? decodeSegment(segments[1]) : undefined;
      // 0.14：`?agent=` 指向子 agent 深链；不校验 id，找不到时由 UI 降级。
      const agent =
        query.get('agent') !== null ? decodeSegment(query.get('agent') ?? '') : undefined;
      return {
        domain: 'chat',
        ...(sessionId ? { sessionId } : {}),
        ...(agent ? { agent } : {}),
      };
    }
    case 'pending': {
      // 只接受 `?session=<id>` 作为默认展开提示；无值即「总的」。
      const focus = queryText(query, 'session');
      return { domain: 'pending', ...(focus ? { sessionId: focus } : {}) };
    }
    case 'runs': {
      const tab = pick<'live' | 'durable'>(query.get('tab'), RUN_TABS, 'live');
      // 详情页规范形态是 `#/runs/<id>`；`?run=<id>` 是 0.x 的旧深链接口，保留。
      const runId =
        segments[1] !== undefined ? decodeSegment(segments[1]) : queryText(query, 'run');
      const sessionId = queryText(query, 'session');
      return {
        domain: 'runs',
        tab,
        ...(runId ? { runId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
    }
    case 'integrations': {
      // 0.45：旧合并页 `#/integrations/<tab>` 作为别名，落到拆出的顶层域。
      const tab = pick<'tools' | 'mcp' | 'channels'>(
        segments[1] ?? query.get('tab'),
        INTEGRATION_TABS,
        'tools',
      );
      return { domain: tab };
    }
    case 'tools':
      return { domain: 'tools' };
    case 'mcp':
      return { domain: 'mcp' };
    case 'channels':
      return { domain: 'channels' };
    case 'observe': {
      const tab = pick<'metrics' | 'evals' | 'diagnostics' | 'attention'>(
        segments[1] ?? query.get('tab'),
        OBSERVE_TABS,
        'metrics',
      );
      return { domain: 'observe', tab };
    }
    case 'plugins': {
      const pluginId = segments[1] !== undefined ? decodeSegment(segments[1]) : undefined;
      // entry 允许子路径：`#/plugins/<id>/sub/index.html` 与编码后的单段都接受。
      const entry = segments.length > 2 ? decodeSegment(segments.slice(2).join('/')) : undefined;
      return {
        domain: 'plugins',
        ...(pluginId ? { pluginId } : {}),
        ...(entry ? { entry } : {}),
      };
    }
    case 'hub':
      return { domain: 'hub' };
    case 'gateway':
      return { domain: 'gateway' };
    case 'plugin-host':
      return { domain: 'pluginHost' };
    case 'nodes': {
      const nodeKey = segments[1] !== undefined ? decodeSegment(segments[1]) : undefined;
      return nodeKey ? { domain: 'nodes', nodeKey } : { domain: 'nodes' };
    }
    case 'teams': {
      // `#/teams//...` 的空 nodeKey 段不能被 filter(Boolean) 吞掉。
      if (rawSegments[1] === '') return { domain: 'teams' };
      const nodeKey = segments[1] !== undefined ? decodeSegment(segments[1]) : undefined;
      const teamId = segments[2] !== undefined ? decodeSegment(segments[2]) : undefined;
      if (!nodeKey || !teamId) return { domain: 'teams' };
      const agentId =
        segments[3] === 'agents' && segments[4] !== undefined
          ? decodeSegment(segments[4])
          : undefined;
      const bodyId =
        agentId && query.get('body') !== null ? decodeSegment(query.get('body') ?? '') : undefined;
      return {
        domain: 'teams',
        nodeKey,
        teamId,
        ...(agentId ? { agentId } : {}),
        ...(bodyId ? { bodyId } : {}),
      };
    }
    case 'agents': {
      const nodeKey = queryText(query, 'node');
      const teamId = queryText(query, 'team');
      const state = queryText(query, 'state');
      const presence = queryText(query, 'presence');
      return {
        domain: 'agents',
        ...(nodeKey ? { nodeKey } : {}),
        ...(teamId ? { teamId } : {}),
        ...(state ? { state } : {}),
        ...(presence ? { presence } : {}),
      };
    }
    case 'capabilities':
      return { domain: 'capabilities' };
    case 'visual':
      return { domain: 'visual' };
    case 'designLab':
      return { domain: 'designLab' };
    case 'settings': {
      // 0.45 IA：旧 settings 子页作为别名跳到新的顶层页面。
      const tab = segments[1] ?? query.get('tab');
      if (tab === 'connection') return { domain: 'gateway' };
      if (tab === 'capabilities') return { domain: 'capabilities' };
      if (tab === 'appearance' || tab === 'display') return { domain: 'visual' };
      return { domain: 'settings' };
    }
    default:
      return { ...DEFAULT_ROUTE };
  }
}

/** Route → hash（带 `#`），保证 parseRoute(formatRoute(r)) 往返一致。 */
export function formatRoute(route: Route): string {
  switch (route.domain) {
    case 'chat': {
      const query = new URLSearchParams();
      if (route.agent) query.set('agent', route.agent);
      const suffix = query.toString();
      const base = route.sessionId ? `#/chat/${encodeURIComponent(route.sessionId)}` : '#/chat';
      return suffix ? `${base}?${suffix}` : base;
    }
    case 'pending': {
      if (!route.sessionId) return '#/pending';
      return `#/pending?${new URLSearchParams({ session: route.sessionId }).toString()}`;
    }
    case 'runs': {
      // 详情页把 run id 放进路径（可深链、可新窗口打开、可分享）；tab / session
      // 作为同一 run 的视图参数留在 query 里。
      if (route.runId) {
        const query = new URLSearchParams();
        if (route.tab !== 'live') query.set('tab', route.tab);
        if (route.sessionId) query.set('session', route.sessionId);
        const suffix = query.toString();
        const base = `#/runs/${encodeURIComponent(route.runId)}`;
        return suffix ? `${base}?${suffix}` : base;
      }
      const query = new URLSearchParams({ tab: route.tab });
      if (route.sessionId) query.set('session', route.sessionId);
      return `#/runs?${query.toString()}`;
    }
    case 'tools':
      return '#/tools';
    case 'mcp':
      return '#/mcp';
    case 'channels':
      return '#/channels';
    case 'observe':
      return `#/observe/${route.tab}`;
    case 'plugins': {
      if (!route.pluginId) return '#/plugins';
      const base = `#/plugins/${encodeURIComponent(route.pluginId)}`;
      return route.entry ? `${base}/${encodeURIComponent(route.entry)}` : base;
    }
    case 'hub':
      return '#/hub';
    case 'gateway':
      return '#/gateway';
    case 'pluginHost':
      return '#/plugin-host';
    case 'nodes':
      return route.nodeKey ? `#/nodes/${encodeURIComponent(route.nodeKey)}` : '#/nodes';
    case 'teams': {
      if (!('teamId' in route)) return '#/teams';
      const base = `#/teams/${encodeURIComponent(route.nodeKey)}/${encodeURIComponent(route.teamId)}`;
      if (!route.agentId) return base;
      const agentBase = `${base}/agents/${encodeURIComponent(route.agentId)}`;
      if (!route.bodyId) return agentBase;
      return `${agentBase}?${new URLSearchParams({ body: route.bodyId }).toString()}`;
    }
    case 'agents': {
      const query = new URLSearchParams();
      if (route.nodeKey) query.set('node', route.nodeKey);
      if (route.teamId) query.set('team', route.teamId);
      if (route.state) query.set('state', route.state);
      if (route.presence) query.set('presence', route.presence);
      const suffix = query.toString();
      return suffix ? `#/agents?${suffix}` : '#/agents';
    }
    case 'capabilities':
      return '#/capabilities';
    case 'visual':
      return '#/visual';
    case 'designLab':
      return '#/designLab';
    case 'settings':
      return '#/settings';
  }
}

/** 是否为同一路由（用于避免无意义的 hash 写入）。 */
export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}

export interface HashTokenResult {
  /** 从 `#token=` 提取的 token；没有则为 undefined。 */
  token?: string;
  /** 剥离 token 后剩余的 hash；token 模式下为空（保持旧行为）。 */
  restHash: string;
}

/**
 * 先于路由解析处理 `#token=...`：token 不进入历史、不发给服务端。
 * 只识别 hash 以 `token=` 开头的形式，避免把普通 query 误判为凭据。
 */
export function extractTokenFromHash(hash: string): HashTokenResult {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('token=')) return { restHash: hash };
  const params = new URLSearchParams(raw);
  const token = params.get('token') ?? undefined;
  return token ? { token, restHash: '' } : { restHash: hash };
}
