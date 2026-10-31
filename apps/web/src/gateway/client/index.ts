/**
 * GatewayClient 最终组合：域方法由抽象类链逐层加入。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import { IntegrationsClient } from './integrations';

export class GatewayClient extends IntegrationsClient {}
