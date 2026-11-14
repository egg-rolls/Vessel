import { t } from '../i18n';
import type { GatewayClient } from './client';

/**
 * 连接层：关码分类 + 建连流程。
 *
 * 退避数学在 `./backoff`（纯算术、零依赖），好让探针直接 import 生产实现；
 * 本文件依赖 `../i18n`，探针不该被它牵着走。
 */

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
    .then(() => client.connect(token, target().since))
    .catch(onError);
}
