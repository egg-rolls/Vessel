import { t } from '../i18n';
import type { GatewayClient } from './client';

/** 1s 起指数退避，上限 30s，带 jitter。 */
export function nextReconnectDelay(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export type CloseClassification =
  | { kind: 'terminal'; tokenError?: string; lastError?: string }
  | { kind: 'reconnect' };

/** 4400/4401/4403 是协议 / 鉴权终态，不重连。 */
export function classifyCloseCode(code: number): CloseClassification {
  if (code === 4401) return { kind: 'terminal', tokenError: t('gateway.connection.authFailed') };
  if (code === 4403)
    return { kind: 'terminal', lastError: t('gateway.connection.forbiddenTenant') };
  if (code === 4400) {
    return { kind: 'terminal', lastError: t('gateway.connection.protocolMismatch') };
  }
  return { kind: 'reconnect' };
}

export interface ConnectTarget {
  since: number;
  tenantId: string | undefined;
}

/** 先探 /health，成功后再建 WS；target 在 probe 落地后才求值。 */
export function probeThenConnect(
  client: GatewayClient,
  token: string,
  target: () => ConnectTarget,
  onError: (error: unknown) => void,
): void {
  void client
    .probeHealth()
    .then(() => {
      const { since, tenantId } = target();
      return client.connect(token, since, tenantId);
    })
    .catch(onError);
}
