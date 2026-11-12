/**
 * 核心区三个导航点（hub / gateway / pluginHost）的状态色推导（纯函数，便于单测）。
 *
 * ## 四档语义（唯一判据；三个来源都必须对齐，不许出现第五档）
 *
 * | 语义              | tone     | 含义                                                          |
 * | ----------------- | -------- | ------------------------------------------------------------- |
 * | 已连接 / 正常     | `accent` | 有证据表明当前是通的、正常的                                   |
 * | 正在连接 / 未就绪 | `amber`  | 进行中，尚未有结论                                             |
 * | 出错              | `danger` | 明确失败（token 错 / 协议不兼容 / 不可达 / unhealthy / invalid） |
 * | 未配置 / 不使用   | `muted`  | 用户没开它，或信息未知                                         |
 *
 * 曾经的 `ok` / `warn` 两档已删除：它们与 `accent` / `amber` 表达同一件事，两套并行
 * 只会让「同一个已连接」在三个点上不同色。颜色的实际取值见 `NavItem`，只用既有 token
 * （`--accent` / `--amber` / `--danger` / `--faint`），不新增颜色。
 *
 * ## 三个来源的证据是什么（点色只看证据，不看「想让它变绿」）
 *
 * - **gateway**：浏览器 ↔ gateway 的 WebSocket 连接状态（`ConnectionState`）；
 * - **hub**：浏览器 → Hub 的直连快照（`gateway/platform/hub-storage`），启动探测
 *   （`useNavStatus` 的 `probeHubNavStatus`）与 Hub 页共写同一份 store，不从
 *   `config.get.hub` 推导；
 * - **pluginHost**：插件宿主**与 gateway 同进程**（`packages/serve/src/plugin-host`），
 *   所以「宿主在跑」的证据就是 gateway 连接是 open；`plugins.list` 的**读取态**再分一层
 *   ——读取中 = amber（还没结论）、读取失败 = danger、读完且条目在才算「用没用」；
 *   条目自带的 `status` 是**该插件**的加载状态，不是宿主连接状态，只有
 *   `unhealthy` / `invalid` 才算失败证据（详见 `pluginHostNavStatus`）。
 *
 * 版本：gateway 取 `config.get.version`；hub 取 Hub directory 的 version；pluginHost 取
 * `plugins.list` 里 marketplace 条目的 `version`（即 marketplace 插件 manifest 的版本，
 * 不是 gateway 版本）。缺失时调用方显示 `—`。
 *
 * 需要 React 绑定时用 `useNavStatus.ts`，本文件不 import provider。
 */

import type { ConnectionState } from '../gateway/client';
import type { HubNavStatus } from '../gateway/platform/hub-storage';
import type { PluginListItem } from '../gateway/types';

/**
 * 四档语义的 tone 名：**运行时数组 = 唯一事实源**（类型由它派生）。
 *
 * `NavStatusMeta.tone` 与设计实验室的圆点图例都从这里来 —— 新增一档时图例会
 * 自动多一行，`TONE_TOKENS` 之类的 `Record<NavStatusTone, …>` 会因缺键而编译报错。
 */
export const NAV_STATUS_TONES = ['accent', 'amber', 'danger', 'muted'] as const;

/** 四档语义；见文件头表格。 */
export type NavStatusTone = (typeof NAV_STATUS_TONES)[number];

export interface NavStatusMeta {
  tone: NavStatusTone;
  /** 状态文案的 i18n key；导航点使用它作为 aria-label / tooltip。 */
  labelKey: string;
  /** 版本：gateway / hub 是进程版本，pluginHost 是 marketplace 插件 manifest 的版本。 */
  version?: string;
}

/**
 * gateway 状态点：证据是浏览器 ↔ gateway 的 WebSocket 连接。
 *
 * - 没 token（用户没配置）→ muted；还没开始连（idle）→ muted（信息未知）；
 * - open → accent；connecting / reconnecting → amber（进行中，不下结论）；
 * - closed / error → danger（明确连不上，含 token 被拒）。
 */
export function gatewayNavStatus(
  connectionState: ConnectionState,
  hasToken: boolean,
): NavStatusMeta {
  if (!hasToken) return { tone: 'muted', labelKey: 'nav.status.offline' };
  if (connectionState === 'open') return { tone: 'accent', labelKey: 'nav.status.online' };
  if (connectionState === 'connecting' || connectionState === 'reconnecting') {
    return { tone: 'amber', labelKey: 'nav.status.connecting' };
  }
  if (connectionState === 'closed' || connectionState === 'error') {
    return { tone: 'danger', labelKey: 'nav.status.error' };
  }
  return { tone: 'muted', labelKey: 'nav.status.unknown' };
}

/**
 * Hub 状态点：只反映浏览器 → Hub 的直连状态，不借用 gateway 连接。
 *
 * 四档（同上表）：没配置 = muted、探测中 = amber、连上（含空目录）= accent、
 * 出错 = danger（`unauthorized` / `incompatible` / `network` 三类共用红色，靠文案区分）。
 */
export function hubNavStatus(status: HubNavStatus): NavStatusMeta {
  switch (status) {
    case 'unconfigured':
      return { tone: 'muted', labelKey: 'nav.status.hubNotConfigured' };
    case 'loading':
      return { tone: 'amber', labelKey: 'nav.status.connecting' };
    case 'connected':
    case 'empty':
      return { tone: 'accent', labelKey: 'nav.status.hubConnected' };
    case 'unauthorized':
      return { tone: 'danger', labelKey: 'nav.status.hubUnauthorized' };
    case 'incompatible':
      return { tone: 'danger', labelKey: 'nav.status.hubIncompatible' };
    case 'network':
      return { tone: 'danger', labelKey: 'nav.status.hubNetwork' };
    default:
      return { tone: 'muted', labelKey: 'nav.status.unknown' };
  }
}

/**
 * `plugins.list` 的读取态（宿主有没有给出条目集合）。
 *
 * 由调用方从 `usePluginContributions().state`（`ResourceState`）折算：`idle` /
 * 首帧 `loading` → `loading`，`success`（以及带旧数据的刷新）→ `ready`，
 * `error` → `error`。本文件不 import `state/useResource`，保持纯函数可单测。
 */
export type PluginListReadState = 'loading' | 'ready' | 'error';

export interface PluginHostNavInput {
  connectionState: ConnectionState;
  hasToken: boolean;
  /** `plugins.list` 里的 marketplace 条目；真的没有条目时 undefined。 */
  marketplace: PluginListItem | undefined;
  /** `plugins.list` 的读取态。 */
  read: PluginListReadState;
}

/**
 * 插件宿主状态点。
 *
 * **灰点根因（上一轮修的那个 bug）**：旧实现只看 marketplace 条目的 `status`，把
 * `status === 'inactive'` 映射成 muted。但 `inactive` 是**懒激活 child 插件的初始加载
 * 状态**，与「宿主是否在跑 / 是否连上」是两件事：
 *
 * - `PluginHostManager.makeEntry`：`status = enabled ? 'inactive' : 'disabled'`
 *   （`packages/serve/src/plugin-host/manager.ts`）——宿主启动后 marketplace 条目一律
 *   先是 `inactive`，直到 `plugin.activate` 才变 `active`；
 * - marketplace manifest 的 `activationEvents` 是 `["onPage:marketplace"]`：只有真的打开
 *   marketplace 页面 / 调它的 RPC 才会被激活；
 * - 导航上显示的 `v0.1.0` 正是这条目 manifest 的 `version`
 *   （`plugins/marketplace/marketplace/package.json` 的 `vessel.version`），说明宿主已经把
 *   manifest 读进来并正常应答了 `plugins.list` —— 宿主明显是连上的，点却是灰的。
 *
 * 因此把「宿主连接状态」「`plugins.list` 读取态」「该插件的运行期状态」分成三层取证据
 * （按顺序判定）：
 *
 * | 证据                                                       | tone   | 文案 key                            |
 * | ---------------------------------------------------------- | ------ | ----------------------------------- |
 * | 没有 gateway token（用户没连，宿主未知）                   | muted  | nav.status.offline                  |
 * | gateway 连不上 / 报错（宿主与 gateway 同进程 ⇒ 不可达）     | danger | nav.status.error                    |
 * | 连接中 / 重连中（还没结论）                                | amber  | nav.status.connecting               |
 * | 还没开始连（idle，信息未知）                               | muted  | nav.status.unknown                  |
 * | 连上了但 `plugins.list` 读取失败（明确失败，不信旧快照）    | danger | nav.status.pluginHostListError      |
 * | 连上了、`plugins.list` 还没回来（进行中）                  | amber  | nav.status.pluginHostLoading        |
 * | 读完了但没有 marketplace 条目（宿主没有它 ⇒ 不使用）       | muted  | nav.status.pluginHostNoMarketplace  |
 * | 读完了但 marketplace 被禁用（用户没开它）                  | muted  | pluginHost.enabled.off              |
 * | `status` 为 `unhealthy` / `invalid`（明确失败）            | danger | pluginHost.status.<status>          |
 * | `status` 为 `disabled` 而 `enabled` 为真（wire 矛盾，按未知） | muted | pluginHost.status.disabled         |
 * | `status` 为 `active`（已激活）                             | accent | pluginHost.status.active            |
 * | `status` 为 `inactive`（懒激活待触发，宿主正常）           | accent | pluginHost.status.lazy              |
 * | 没有 `status`（旧 gateway 无 E10 元数据，宿主仍已应答）    | accent | pluginHost.status.hostConnected     |
 *
 * accent 的判据是「有连接证据 + 读取完成 + 没有失败证据」，不是「把 inactive 硬当绿」：
 * 这里只有 `unhealthy` / `invalid` 算失败证据，`inactive` 只说明插件还没被懒激活。
 * 「读取中」与「真的没有条目」是两件事：前者 amber + 「正在读取插件列表」，后者 muted +
 * 「未安装 marketplace 插件」。
 *
 * 读取失败判 danger 而不是 muted：四档语义里「出错」就是 danger，且我们拿不到当前
 * 条目集合（旧快照可能是过期的），不该用灰点冒充「未配置」。
 */
export function pluginHostNavStatus(input: PluginHostNavInput): NavStatusMeta {
  const { connectionState, hasToken, marketplace, read } = input;
  const base = marketplace?.version !== undefined ? { version: marketplace.version } : {};
  if (!hasToken) return { tone: 'muted', labelKey: 'nav.status.offline', ...base };
  if (connectionState === 'closed' || connectionState === 'error') {
    return { tone: 'danger', labelKey: 'nav.status.error', ...base };
  }
  if (connectionState === 'connecting' || connectionState === 'reconnecting') {
    return { tone: 'amber', labelKey: 'nav.status.connecting', ...base };
  }
  if (connectionState !== 'open') {
    return { tone: 'muted', labelKey: 'nav.status.unknown', ...base };
  }
  // 宿主确实在应答（gateway 连接 open）：先看 `plugins.list` 读到了没有。
  if (read === 'error') {
    return { tone: 'danger', labelKey: 'nav.status.pluginHostListError', ...base };
  }
  if (read === 'loading') {
    return { tone: 'amber', labelKey: 'nav.status.pluginHostLoading', ...base };
  }
  // 读完了：只看「用没用」与「有没有失败证据」。
  if (!marketplace) {
    return { tone: 'muted', labelKey: 'nav.status.pluginHostNoMarketplace', ...base };
  }
  if (!marketplace.enabled) {
    return { tone: 'muted', labelKey: 'pluginHost.enabled.off', ...base };
  }
  switch (marketplace.status) {
    case 'unhealthy':
    case 'invalid':
      return { tone: 'danger', labelKey: `pluginHost.status.${marketplace.status}`, ...base };
    case 'disabled':
      return { tone: 'muted', labelKey: 'pluginHost.status.disabled', ...base };
    case 'active':
      return { tone: 'accent', labelKey: 'pluginHost.status.active', ...base };
    case 'inactive':
      return { tone: 'accent', labelKey: 'pluginHost.status.lazy', ...base };
    default:
      return { tone: 'accent', labelKey: 'pluginHost.status.hostConnected', ...base };
  }
}

export interface NavStatuses {
  hub: NavStatusMeta;
  gateway: NavStatusMeta;
  pluginHost: NavStatusMeta;
}
