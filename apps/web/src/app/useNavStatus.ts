/**
 * Status 导航组的 React 绑定 + 打开 WebUI 时的**一次性 Hub 探测**。
 *
 * config 只用于 gateway 版本；Hub 状态与版本来自浏览器 → Hub 的直连快照
 * （`gateway/platform/hub-storage`）。这份快照有两个写入者，共用同一个 store：
 * - 启动探测（下面的 `probeHubNavStatus`）：打开 WebUI / gateway 会话重建时各跑一次；
 * - Hub 页（`domains/hub/useHubDirectory`）：进入页面时本来就会连，页面在时页面说了算。
 *
 * 探测体就是 Hub 页同一个 `HubSession`（health → directory → WS 首帧），所以
 * `loading / connected / empty / unauthorized / incompatible / network` 的分类与页面
 * **完全一致**，不另写一套。
 *
 * 核心区三个点的四档语义见 `nav-status.ts` 文件头。pluginHost 点额外需要 gateway 的
 * 连接证据（宿主与 gateway 同进程）：连接状态由 `useConnection()` 提供，marketplace
 * 条目由调用方传进来的 `plugins` 里取。
 */
import { useSyncExternalStore } from 'react';
import { useConnection } from '../gateway/ConnectionProvider';
import { type HubErrorKind, HubSession, implicitHubUrl } from '../gateway/platform/hub';
import {
  getHubNavStatus,
  type HubNavStatus,
  readHubConnection,
  setHubNavStatus,
  subscribeHubNavStatus,
} from '../gateway/platform/hub-storage';
import type { PluginListItem } from '../gateway/types';
import { resourceData } from '../state/useResource';
import { useConfigStoreApi } from '../stores/useConfigStoreApi';
import {
  gatewayNavStatus,
  hubNavStatus,
  type NavStatuses,
  pluginHostNavStatus,
} from './nav-status';

/** `plugins` 来自 `usePluginContributions()`，避免重复拉取 `plugins.list`。 */
export function useNavStatus(plugins: readonly PluginListItem[]): NavStatuses {
  const { connectionState, hasToken } = useConnection();
  const { config } = useConfigStoreApi({ pollMs: 60_000 });
  const hub = useSyncExternalStore(subscribeHubNavStatus, getHubNavStatus, getHubNavStatus);

  const data = resourceData(config);
  const gateway = gatewayNavStatus(connectionState, hasToken);
  const version = data?.version;
  const marketplace = plugins.find((plugin) => plugin.name === 'marketplace');
  const hubMeta = hubNavStatus(hub.status);
  return {
    hub: hub.version !== undefined ? { ...hubMeta, version: hub.version } : hubMeta,
    gateway: version !== undefined ? { ...gateway, version } : gateway,
    pluginHost: pluginHostNavStatus(connectionState, hasToken, marketplace),
  };
}

/**
 * 一次探测最多等这么久（本地 Hub 是毫秒级）；超时按 `network` 收口，
 * 时间窗口到就停，绝不留 WS / 定时器在线程上。
 */
const HUB_PROBE_TIMEOUT_MS = 12_000;

/**
 * `network` 档先看一眼能不能自己好：`HubSession` 在 WS 首帧失败时会先报 `network`
 * （`directory === null` 那条分支），而 HTTP directory 可能随后就成功 —— 页面里这条
 * 是瞬时的。启动探测只判一次，所以要给这档一个观察窗，别把「握手慢」判成「连不上」。
 */
const HUB_PROBE_NETWORK_GRACE_MS = 1_500;

/** `HubSession.connect()` 的失败档 → 导航状态档：沿用既有几档，不新造分类。 */
function probeStatusForError(kind: HubErrorKind): HubNavStatus {
  if (kind === 'unauthorized') return 'unauthorized';
  if (kind === 'incompatible') return 'incompatible';
  // network / forbidden / http / invalid_url：都是「连不上这个 Hub」这一档，
  // 与 Hub 页 connect form 的错误面同义（detail 仍在页面上）。
  return 'network';
}

let probeInFlight: Promise<void> | null = null;

/**
 * 打开 WebUI 时的 Hub 探测（**一次性**：不轮询，失败也不自己重试）。
 *
 * - 有已存 URL（`vessel.hub.url`，用户在 Hub 页连过）⇒ 用它 + 已存 token 探；
 * - 没有已存 URL、但页面是回环 http ⇒ 探同机默认 Hub（`implicitHubUrl()`，
 *   即 0.50 里 `HubSession.connect()` / Hub 页走的那条隐式连接路径，端口 8643）；
 * - 两者都没有 ⇒ 没配置：直接 `unconfigured`（灰），**一个请求都不发**
 *   （下面这段只读 sessionStorage 与 `location`，不碰网络）。
 *
 * 并发去重：同一时刻只有一条探测在飞；结果写回 `hub-storage` 那份 store。
 */
export function probeHubNavStatus(): Promise<void> {
  if (probeInFlight !== null) return probeInFlight;
  if (readHubConnection().url === '' && implicitHubUrl() === null) {
    setHubNavStatus('unconfigured');
    return Promise.resolve();
  }
  probeInFlight = runHubProbe().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

async function runHubProbe(): Promise<void> {
  const session = new HubSession();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | null = null;

  function settle(status: HubNavStatus, version?: string): void {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    unsubscribe?.();
    // 过期探测不覆盖更权威的判定：只有本探测占着的档（loading / 未探测的 unknown）才可写。
    const current = getHubNavStatus().status;
    if (current === 'loading' || current === 'unknown') setHubNavStatus(status, version);
    // 探完就关：不留 WS 连接、不留退避重连定时器。
    session.close();
  }

  unsubscribe = session.subscribe(() => {
    const snapshot = session.getSnapshot();
    // `loading` 不是判定；`unconfigured` 在 health 失败时也会出现（真因在 connect() 的返回值里）。
    if (snapshot.status === 'loading' || snapshot.status === 'unconfigured') return;
    if (snapshot.status === 'network') {
      // 可能只是 WS 首帧没通、HTTP directory 随后就成功：先开观察窗，窗口内变好就不记红。
      if (graceTimer === undefined) {
        graceTimer = setTimeout(() => settle('network'), HUB_PROBE_NETWORK_GRACE_MS);
      }
      return;
    }
    settle(snapshot.status, snapshot.directory?.version);
  });

  setHubNavStatus('loading');
  timer = setTimeout(() => settle('network'), HUB_PROBE_TIMEOUT_MS);
  const result = await session.connect();
  // health 明确不通（network / 401 / 地址非法）：不用等观察窗，直接按 connect 的分类收口。
  if (!result.ok) settle(probeStatusForError(result.error ?? 'network'));
}
