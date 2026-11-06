/**
 * 0.49 G1：Platform Gateway 模块入口。
 *
 * 只导出平台入口与类型；不导出 node methods / node runtime。
 *
 * @module @vessel-agent/serve/platform
 */

export {
  bearerToken,
  type PlatformAuthMode,
  type PlatformAuthResult,
  type ResolvePlatformAuthInput,
  resolvePlatformAuth,
} from './auth.js';
export {
  createPlatformRegistry,
  PlatformNodeNotFoundError,
  type PlatformRegistry,
} from './registry.js';
export {
  handlePlatformRpc,
  PLATFORM_RPC_METHODS,
  type PlatformRpcContext,
  type PlatformRpcErrorCode,
  type PlatformRpcMethod,
} from './rpc.js';
export { startPlatformGateway } from './server.js';
export type {
  PlatformGateway,
  PlatformGatewayOptions,
  PlatformNodeDescriptor,
  PlatformNodeStatus,
  PlatformNodeSummary,
} from './types.js';
