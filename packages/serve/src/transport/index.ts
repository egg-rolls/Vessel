/**
 * @vessel-agent/serve/transport — 本机 Transport 实现（R3）
 * @module @vessel-agent/serve/transport
 */

export {
  createLoopbackTransport,
  LoopbackTransport,
  type LoopbackTransportOptions,
  PeerTransportError,
  type PeerTransportErrorCode,
} from './loopback.js';
export {
  ensurePeersDir,
  isLoopbackEndpoint,
  type PeerFileRecord,
  PeerRegistry,
  type PeerRegistryOptions,
} from './registry.js';
