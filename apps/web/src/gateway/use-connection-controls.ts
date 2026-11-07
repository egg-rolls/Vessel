import { type Dispatch, type SetStateAction, useCallback } from 'react';
import { t } from '../i18n';
import type { EventStore } from '../state/event-store';
import type { GatewayClient } from './client';
import type { ConnectionMode, ConnectionOptions } from './connection-context';
import { LEGACY_TOKEN_KEY, PLATFORM_TOKEN_KEY } from './connection-initial';
import { removeNodeToken, storeNodeToken } from './nodes';
import { probeThenConnect } from './reconnect';
import { checkGatewayUrl, GATEWAY_URL_KEY } from './url';

interface Current<T> {
  current: T;
}

interface NodeIdentity {
  nodeId?: string;
  name?: string;
}

export interface ConnectionControlsDeps {
  client: GatewayClient;
  eventStore: EventStore;
  nodeToken: string;
  mode: ConnectionMode;
  nodeIdentity: NodeIdentity | null;
  canConnect: boolean;
  tenantIdRef: Current<string | null>;
  reportConnectError: (error: unknown) => void;
  setPlatformUrl: Dispatch<SetStateAction<string>>;
  setPlatformToken: Dispatch<SetStateAction<string>>;
  setGatewayError: Dispatch<SetStateAction<string | null>>;
  setPlatformError: Dispatch<SetStateAction<string | null>>;
  setUrlInvalid: Dispatch<SetStateAction<boolean>>;
  setBootstrapSeq: Dispatch<SetStateAction<number>>;
  setNodeToken: Dispatch<SetStateAction<string>>;
  setAnonymousNode: Dispatch<SetStateAction<boolean>>;
  setTokenError: Dispatch<SetStateAction<string | null>>;
  setLastError: Dispatch<SetStateAction<string | null>>;
  setConnectSeq: Dispatch<SetStateAction<number>>;
  manualNodeTokenRef: Current<string>;
  legacyTokenRef: Current<string>;
}

function nodeTokenSlot(identity: NodeIdentity | null): string | null {
  const value = identity?.nodeId ?? identity?.name ?? '';
  return value === '' ? null : value;
}

/** 显式连接 / 断开 / 重试：写持久化后由 effect 的依赖变化触发重建。 */
export function useConnectionControls({
  client,
  eventStore,
  nodeToken,
  mode,
  nodeIdentity,
  canConnect,
  tenantIdRef,
  reportConnectError,
  setPlatformUrl,
  setPlatformToken,
  setGatewayError,
  setPlatformError,
  setUrlInvalid,
  setBootstrapSeq,
  setNodeToken,
  setAnonymousNode,
  setTokenError,
  setLastError,
  setConnectSeq,
  manualNodeTokenRef,
  legacyTokenRef,
}: ConnectionControlsDeps): {
  connect: (options: ConnectionOptions) => boolean;
  disconnect: () => void;
  retry: () => void;
} {
  // biome-ignore lint/correctness/useExhaustiveDependencies: useState setters 与 React 保证稳定
  const connect = useCallback(
    (options: ConnectionOptions): boolean => {
      if (options.platformUrl !== undefined || options.token !== undefined) {
        const urlCheck = checkGatewayUrl(options.platformUrl ?? '', window.location.protocol);
        if (!urlCheck.ok) {
          setGatewayError(urlCheck.error ?? t('gateway.connection.invalidUrl'));
          return false;
        }
        const nextToken = (options.token ?? '').trim();
        if (options.nodeToken !== undefined) manualNodeTokenRef.current = options.nodeToken.trim();
        if (urlCheck.value) localStorage.setItem(GATEWAY_URL_KEY, urlCheck.value);
        else localStorage.removeItem(GATEWAY_URL_KEY);
        if (nextToken) sessionStorage.setItem(PLATFORM_TOKEN_KEY, nextToken);
        else sessionStorage.removeItem(PLATFORM_TOKEN_KEY);
        setPlatformUrl(urlCheck.value);
        setPlatformToken(nextToken);
        setUrlInvalid(false);
        setGatewayError(null);
        setPlatformError(null);
        setTokenError(null);
        setLastError(null);
        setBootstrapSeq((value) => value + 1);
        return true;
      }

      if (options.nodeToken !== undefined) {
        const next = options.nodeToken.trim();
        manualNodeTokenRef.current = next;
        if (mode === 'legacy') {
          if (next) sessionStorage.setItem(LEGACY_TOKEN_KEY, next);
          else sessionStorage.removeItem(LEGACY_TOKEN_KEY);
          legacyTokenRef.current = next;
        } else {
          const slot = nodeTokenSlot(nodeIdentity);
          if (slot !== null) {
            if (next) storeNodeToken(slot, next);
            else removeNodeToken(slot);
          }
        }
        setNodeToken(next);
        setAnonymousNode(false);
        setTokenError(null);
        setLastError(null);
        setConnectSeq((value) => value + 1);
        return true;
      }

      // CONTRACT-0.49 C7：T1 不再提供切换 tenant 的入口；
      // `ConnectionOptions.tenantId` 类型保留（defer-T4），此处忽略。
      return false;
    },
    [mode, nodeIdentity],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: useState setters 与 React 保证稳定
  const disconnect = useCallback(() => {
    if (mode === 'legacy') {
      sessionStorage.removeItem(LEGACY_TOKEN_KEY);
      legacyTokenRef.current = '';
    } else {
      const slot = nodeTokenSlot(nodeIdentity);
      if (slot !== null) removeNodeToken(slot);
    }
    manualNodeTokenRef.current = '';
    setNodeToken('');
    setAnonymousNode(false);
    client.close();
    eventStore.reset(0);
  }, [client, eventStore, mode, nodeIdentity]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs 与 useRef 一样稳定
  const retry = useCallback(() => {
    // legacy 模式仍要求显式 token（旧行为）；平台模式空 token 只在
    // credentials mode:'none' 时由 Provider 放行。
    if (!canConnect) return;
    setLastError(null);
    probeThenConnect(
      client,
      nodeToken,
      () => ({ since: eventStore.currentSeq, tenantId: tenantIdRef.current ?? undefined }),
      reportConnectError,
    );
  }, [client, eventStore, nodeToken, canConnect, reportConnectError]);

  return { connect, disconnect, retry };
}
