/**
 * 前端协议类型（vessel.gateway/1 的最小契约）。
 *
 * 与 packages/serve/src/protocol.ts 对齐，但不 import 服务端源码——
 * 前端独立构建，避免把 Bun/Node 类型带进来。
 *
 * S0：实现按域拆到 `./types/*`；本文件只做 barrel，导出面与拆分前一致。
 */

export * from './types/agents';
export * from './types/integrations';
export * from './types/protocol';
export * from './types/runs';
export * from './types/sessions';
export * from './types/teams';
