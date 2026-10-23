/**
 * Hash 路由（纯函数，便于单测）。
 *
 * 先处理 `#token=`（由 ConnectionProvider 在初始化时消费），再解析路由。
 * 未知/非法路由回落到 Chat；无法解码的 id 保留原文，不丢深链。
 */

export type Route =
  | { domain: 'chat'; sessionId?: string; agent?: string }
  | { domain: 'runs'; tab: 'live' | 'durable'; runId?: string; sessionId?: string }
  | { domain: 'workflows'; workflowId?: string }
  | {
      domain: 'integrations';
      tab: 'tools' | 'mcp' | 'channels';
    }
  | { domain: 'observe'; tab: 'metrics' | 'evals' | 'diagnostics' | 'tasks' }
  | { domain: 'team' }
  | { domain: 'team'; teamId: string; memberId?: string; bodyId?: string }
  | {
      domain: 'settings';
      tab:
        | 'connection'
        | 'nodes'
        | 'config'
        | 'capabilities'
        | 'tenants'
        | 'appearance'
        | 'display';
    };

export type Domain = Route['domain'];

export const DEFAULT_ROUTE: Route = { domain: 'chat' };

const RUN_TABS = new Set(['live', 'durable']);
const INTEGRATION_TABS = new Set(['tools', 'mcp', 'channels']);
const OBSERVE_TABS = new Set(['metrics', 'evals', 'diagnostics', 'tasks']);
const SETTINGS_TABS = new Set([
  'connection',
  'nodes',
  'config',
  'capabilities',
  'tenants',
  'appearance',
  'display',
]);

/** 安全解码：非法百分号编码时保留原值。 */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
    case 'runs': {
      const tab = pick<'live' | 'durable'>(query.get('tab'), RUN_TABS, 'live');
      // 同时接受 `#/runs/<id>` 深链。
      const runId = query.get('run') ?? segments[1] ?? undefined;
      const sessionId = query.get('session') ?? undefined;
      return {
        domain: 'runs',
        tab,
        ...(runId ? { runId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
    }
    case 'workflows': {
      const workflowId = segments[1] !== undefined ? decodeSegment(segments[1]) : undefined;
      return workflowId ? { domain: 'workflows', workflowId } : { domain: 'workflows' };
    }
    case 'integrations': {
      const tab = pick<'tools' | 'mcp' | 'channels'>(
        segments[1] ?? query.get('tab'),
        INTEGRATION_TABS,
        'tools',
      );
      return { domain: 'integrations', tab };
    }
    case 'observe': {
      const tab = pick<'metrics' | 'evals' | 'diagnostics' | 'tasks'>(
        segments[1] ?? query.get('tab'),
        OBSERVE_TABS,
        'metrics',
      );
      return { domain: 'observe', tab };
    }
    case 'team': {
      // `#/team//members/x` 的空 teamId 段不能被 filter(Boolean) 吞掉，
      // 否则会误解析成 teamId='members' 并请求不存在的 Team。
      if (rawSegments[1] === '') return { domain: 'team' };
      const teamId = segments[1] !== undefined ? decodeSegment(segments[1]) : undefined;
      if (!teamId) return { domain: 'team' };
      const memberId =
        segments[2] === 'members' && segments[3] !== undefined
          ? decodeSegment(segments[3])
          : undefined;
      const bodyId =
        memberId && query.get('body') !== null ? decodeSegment(query.get('body') ?? '') : undefined;
      return {
        domain: 'team',
        teamId,
        ...(memberId ? { memberId } : {}),
        ...(bodyId ? { bodyId } : {}),
      };
    }
    case 'settings': {
      const tab = pick<
        'connection' | 'nodes' | 'config' | 'capabilities' | 'tenants' | 'appearance' | 'display'
      >(segments[1] ?? query.get('tab'), SETTINGS_TABS, 'connection');
      return { domain: 'settings', tab };
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
    case 'runs': {
      const query = new URLSearchParams({ tab: route.tab });
      if (route.runId) query.set('run', route.runId);
      if (route.sessionId) query.set('session', route.sessionId);
      return `#/runs?${query.toString()}`;
    }
    case 'workflows':
      return route.workflowId
        ? `#/workflows/${encodeURIComponent(route.workflowId)}`
        : '#/workflows';
    case 'integrations':
      return `#/integrations/${route.tab}`;
    case 'observe':
      return `#/observe/${route.tab}`;
    case 'team': {
      if (!('teamId' in route) || !route.teamId) return '#/team';
      const base = `#/team/${encodeURIComponent(route.teamId)}`;
      if (!('memberId' in route) || !route.memberId) return base;
      const memberBase = `${base}/members/${encodeURIComponent(route.memberId)}`;
      if (!('bodyId' in route) || !route.bodyId) return memberBase;
      return `${memberBase}?${new URLSearchParams({ body: route.bodyId }).toString()}`;
    }
    case 'settings':
      return `#/settings/${route.tab}`;
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
