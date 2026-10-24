/**
 * Hub 状态推导（纯函数，便于单测）。
 *
 * 输入是 `config.get` 返回的 `config` 对象；只读 `hub` 段，不新增 RPC。
 * DECISION-039：`hub.autoStart` 缺省视为 true（本地 hub 随 gateway 启动）。
 */

export type HubState = 'not_configured' | 'local' | 'joined';

export interface HubInfo {
  state: HubState;
  autoStart: boolean;
  direction?: 'hub' | 'node';
  url?: string;
  listen?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `listen.hostname` / `listen.port` → `hostname:port`；两段都缺失时不写。 */
function listenText(listen: unknown): string | undefined {
  if (!isRecord(listen)) return undefined;
  const hostname =
    typeof listen.hostname === 'string' && listen.hostname.trim()
      ? listen.hostname.trim()
      : undefined;
  const port =
    typeof listen.port === 'number' && Number.isInteger(listen.port) ? listen.port : undefined;
  if (hostname === undefined && port === undefined) return undefined;
  return `${hostname ?? ''}:${port ?? ''}`;
}

/** hub 段 → 三态；非对象输入按 local（默认开启，不做隐式告警）。 */
export function hubInfoFromConfig(config: unknown): HubInfo {
  if (!isRecord(config) || !isRecord(config.hub)) {
    return { state: 'local', autoStart: true };
  }
  const hub = config.hub;

  const direction: HubInfo['direction'] =
    hub.direction === 'hub' ? 'hub' : hub.direction === 'node' ? 'node' : undefined;
  const url = typeof hub.url === 'string' && hub.url.trim() ? hub.url.trim() : undefined;
  const autoStart = hub.autoStart !== false;
  const listen = listenText(hub.listen);

  const base = {
    autoStart,
    ...(direction ? { direction } : {}),
    ...(url ? { url } : {}),
    ...(listen ? { listen } : {}),
  };

  if (direction === 'node' && url) return { state: 'joined', ...base };
  if (direction === 'hub' || autoStart) return { state: 'local', ...base };
  return { state: 'not_configured', ...base };
}
