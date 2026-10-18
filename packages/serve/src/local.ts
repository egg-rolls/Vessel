/**
 * 非监听本地 dispatcher（0.5 E16 / A-5 §12.1）。
 *
 * 本地 CLI/REPL 不能为了拿 `gateway.rpc` 占用端口。本入口复用
 * `startGateway` 的同一方法表、同一运行引擎与同一 tenant/quota 语义，
 * 但跳过 `Bun.serve`、心跳与 team 轮询。
 *
 * @module @vessel/serve/local
 */

import { type GatewayOptions, startGateway } from './gateway.js';
import type { CapabilityManifest, RpcDispatcher } from './rpc.js';

/** 本地 dispatcher 选项：GatewayOptions 去掉网络字段 */
export type LocalRpcOptions = Omit<
  GatewayOptions,
  'port' | 'hostname' | 'tls' | 'allowRemote' | 'localOnly'
>;

/** 本地 dispatcher 结果 */
export interface LocalRpcDispatcher {
  /** 与 asm `RpcDispatcher` 结构一致，可直接交给 LocalRpcClient */
  dispatch: RpcDispatcher;
  manifest: () => CapabilityManifest;
  /** 释放事件订阅与队列（additive；本地模式建议在退出时调用） */
  dispose(): void;
}

/**
 * 创建不监听端口的本地 RPC dispatcher。
 *
 * 与 `startGateway` 共用同一方法表/引擎；`sessions.list`、`capabilities.list`
 * 等全部方法均可直接调用。
 */
export function createLocalRpcDispatcher(opts: LocalRpcOptions): LocalRpcDispatcher {
  const gateway = startGateway({
    ...opts,
    hostname: '127.0.0.1',
    port: 0,
    allowRemote: false,
    localOnly: true,
  });
  return {
    dispatch: gateway.rpc,
    manifest: gateway.manifest,
    dispose: () => gateway.stop(),
  };
}
