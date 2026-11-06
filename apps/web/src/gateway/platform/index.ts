/**
 * 平台客户端入口。平台目录与 node 客户端目录互不 import（D9）。
 */
export {
  isPlatformUnavailable,
  PlatformClient,
  type PlatformProbe,
  PlatformRpcError,
  probePlatform,
} from './client';
