/**
 * Hub 目录客户端协议帧（S5 / `vessel.hub/1`）。
 *
 * `/v1/hub/events` 面向目录客户端（Web / CLI watch），与节点控制的
 * `HubHelloFrame` / `HubSnapshotFrame` 不同：hub 不是节点，也不建模 tenant，
 * 因此这里只发 hub 自己的 hello + 整个目录。
 *
 * 指针仍复用节点 scoped 的 `HubPointerFrame`（带 `node_id` / `team_id`）；
 * 本文件只定义 hub → 目录客户端的两帧。
 *
 * @module vessel/hub/client-protocol
 */

import type { HUB_PROTOCOL } from '@vessel-agent/serve';
import type { HubNodeRecord } from './types.js';

/** 鉴权成功后的第一帧（hub 身份 + 目录 revision）。 */
export interface HubClientHelloFrame {
  v: 1;
  kind: 'hello';
  protocol: typeof HUB_PROTOCOL;
  dialer: 'hub';
  hub_id: string;
  /** 目录 revision；目录变化时递增。 */
  revision: number;
  observed_at: number;
}

/** 完整目录（只含 registry 元数据；不含 token / 正文）。 */
export interface HubDirectoryFrame {
  v: 1;
  kind: 'directory';
  protocol: typeof HUB_PROTOCOL;
  dialer: 'hub';
  hub_id: string;
  revision: number;
  observed_at: number;
  nodes: HubNodeRecord[];
}

export type HubClientServerFrame = HubClientHelloFrame | HubDirectoryFrame;
