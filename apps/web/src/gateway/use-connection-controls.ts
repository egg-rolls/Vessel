import { type Dispatch, type SetStateAction, useCallback } from 'react';
import { t } from '../i18n';
import type { EventStore } from '../state/event-store';
import type { ConnectionState, GatewayClient } from './client';
import type { ConnectionOptions } from './connection-context';
import { TOKEN_KEY } from './connection-initial';
import { probeThenConnect } from './reconnect';
import { checkGatewayUrl, GATEWAY_URL_KEY } from './url';

interface Current<T> {
  current: T;
}

export interface ConnectionControlsDeps {
  client: GatewayClient;
  eventStore: EventStore;
  token: string;
  gatewayUrl: string;
  connectionState: ConnectionState;
  tokenRef: Current<string>;
  tenantIdRef: Current<string | null>;
  reportConnectError: (error: unknown) => void;
  setGatewayUrl: Dispatch<SetStateAction<string>>;
  setGatewayError: Dispatch<SetStateAction<string | null>>;
  setTokenError: Dispatch<SetStateAction<string | null>>;
  setLastError: Dispatch<SetStateAction<string | null>>;
  setTargetTenantId: Dispatch<SetStateAction<string | undefined>>;
  setToken: Dispatch<SetStateAction<string>>;
  setConnectSeq: Dispatch<SetStateAction<number>>;
}

/** 显式连接 / 断开 / 重试：写持久化后由 effect 的依赖变化触发重建。 */
export function useConnectionControls({
  client,
  eventStore,
  token,
  gatewayUrl,
  connectionState,
  tokenRef,
  tenantIdRef,
  reportConnectError,
  setGatewayUrl,
  setGatewayError,
  setTokenError,
  setLastError,
  setTargetTenantId,
  setToken,
  setConnectSeq,
}: ConnectionControlsDeps): {
  connect: (options: ConnectionOptions) => boolean;
  disconnect: () => void;
  retry: () => void;
} {
  // biome-ignore lint/correctness/useExhaustiveDependencies: useState setters 与 React 保证稳定
  const connect = useCallback(
    (options: ConnectionOptions): boolean => {
      const urlCheck = checkGatewayUrl(options.gatewayUrl, window.location.protocol);
      if (!urlCheck.ok) {
        setGatewayError(urlCheck.error ?? t('gateway.connection.invalidUrl'));
        return false;
      }
      const nextToken = options.token.trim();
      if (!nextToken) {
        setTokenError(t('gateway.connection.tokenRequired'));
        return false;
      }
      setGatewayError(null);
      if (urlCheck.value) localStorage.setItem(GATEWAY_URL_KEY, urlCheck.value);
      else localStorage.removeItem(GATEWAY_URL_KEY);
      sessionStorage.setItem(TOKEN_KEY, nextToken);
      setTokenError(null);
      setLastError(null);
      setTargetTenantId(options.tenantId);

      const sameTarget =
        urlCheck.value === gatewayUrl && nextToken === token && options.tenantId === undefined;
      if (sameTarget && connectionState === 'open') return true;

      if (urlCheck.value !== gatewayUrl) setGatewayUrl(urlCheck.value);
      setToken(nextToken);
      setConnectSeq((value) => value + 1);
      return true;
    },
    [connectionState, gatewayUrl, token],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: useState setters 与 React 保证稳定
  const disconnect = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setTargetTenantId(undefined);
    client.close();
    eventStore.reset(0);
  }, [client, eventStore]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs 与 useRef 一样稳定
  const retry = useCallback(() => {
    const tk = tokenRef.current.trim();
    if (!tk) return;
    setLastError(null);
    probeThenConnect(
      client,
      tk,
      () => ({ since: eventStore.currentSeq, tenantId: tenantIdRef.current ?? undefined }),
      reportConnectError,
    );
  }, [client, eventStore, reportConnectError]);

  return { connect, disconnect, retry };
}
