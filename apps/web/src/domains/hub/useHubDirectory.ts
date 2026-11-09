/**
 * Hub 页 React 绑定：只订阅 `HubSession` 快照并渲染（CONTRACT-0.49 §8）。
 *
 * 鉴权、失效分类、重连退避、清 token 全部在 `gateway/platform/hub.ts` 的数据层；
 * 本 hook 不持有安全逻辑，只负责生命周期与导航状态同步。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  type HubConnectInput,
  type HubErrorKind,
  HubSession,
  type HubSessionSnapshot,
} from '../../gateway/platform/hub';
import { readHubConnection, setHubNavStatus } from '../../gateway/platform/hub-storage';

export type HubViewStatus = HubSessionSnapshot['status'];
export type HubConnectErrorKind = HubErrorKind;

export interface HubDirectoryState extends HubSessionSnapshot {
  connect(input: HubConnectInput): Promise<boolean>;
  disconnect(): void;
  retry(): void;
}

export function useHubDirectory(): HubDirectoryState {
  const [session] = useState(() => new HubSession());
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useEffect(() => {
    void session.connect();
    return () => {
      session.close();
      // 离开 Hub 页后不再保留上一次的绿点：已存 URL = 状态未知，否则未配置。
      setHubNavStatus(readHubConnection().url !== '' ? 'unknown' : 'unconfigured');
    };
  }, [session]);

  const status = snapshot.status;
  const version = snapshot.directory?.version;
  useEffect(() => {
    setHubNavStatus(status, version);
  }, [status, version]);

  const connect = useCallback(
    async (input: HubConnectInput): Promise<boolean> => (await session.connect(input)).ok,
    [session],
  );
  const disconnect = useCallback(() => session.disconnect(), [session]);
  const retry = useCallback(() => {
    void session.retry();
  }, [session]);

  return { ...snapshot, connect, disconnect, retry };
}
