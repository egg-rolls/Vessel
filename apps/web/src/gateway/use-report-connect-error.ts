import { type Dispatch, type SetStateAction, useCallback } from 'react';
import { t } from '../i18n';
import { type ConnectionState, type GatewayClient, GatewayHttpError } from './client';
import { errorMessage } from './connection-utils';

/** probe / connect 失败统一落到 UI 错误：鉴权 / 来源 / 网络分别给可诊断文案。 */
export function useReportConnectError(
  client: GatewayClient,
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>,
  setTokenError: Dispatch<SetStateAction<string | null>>,
  setLastError: Dispatch<SetStateAction<string | null>>,
): (error: unknown) => void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: useState setters 与 React 保证稳定
  return useCallback(
    (error: unknown) => {
      // probe/connect 失败可能发生在 WS close 之前；显式落到 error，
      // 避免 UI 一直停在「正在连接」。
      setConnectionState('error');
      if (client.closedWithCode === 4401) {
        setTokenError(t('gateway.connection.authFailed'));
        return;
      }
      if (error instanceof GatewayHttpError) {
        if (
          error.status === 403 ||
          error.code === 'forbidden_origin' ||
          error.code === 'invalid_host'
        ) {
          setLastError(t('gateway.connection.originRejected', { detail: error.message }));
          return;
        }
        if (error.status === 401 || error.code === 'unauthorized') {
          setTokenError(t('gateway.connection.authFailed'));
          return;
        }
        if (error.code === 'network') {
          setLastError(t('gateway.connection.unreachable', { detail: error.message }));
          return;
        }
        setLastError(error.message);
        return;
      }
      setLastError(errorMessage(error));
    },
    [client],
  );
}
