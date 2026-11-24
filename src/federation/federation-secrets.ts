/**
 * q-fed-simple：node 侧 federation peer token 的 SecretStore 接线。
 *
 * 复用 `src/hub/secret-store.ts` 的平台适配器（DPAPI / keychain / secret-tool +
 * AES-256-GCM 0600 文件回退），独立命名空间：
 * - keychain service `vessel-federation`（与 hub `vessel-hub` / node `vessel-node` 不交叉）；
 * - 文件回退目录 `<dataDir>/federation/`（与 hub / hub-node 的 secrets.bin 不共文件）。
 *
 * token 只在 SecretStore ↔ 运行时内存对象之间流动：绝不进配置 / 日志 / CLI 输出。
 * `federation.allowFileSecrets` 缺省 true（加密 0600 文件，与既有 env_file 明文落盘
 * 相比只强不弱）；显式 false 时平台密钥库不可用即 fail-closed。
 *
 * @module vessel/federation-secrets
 */

import { join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import type { FederationConfig } from '../../packages/config/src/index';
import { type CreateSecretStoreOptions, createSecretStore } from '../hub/secret-store';
import type { SecretStore } from '../hub/types';

/** keychain service 名（独立命名空间，不与 hub / node 凭据交叉）。 */
export const FEDERATION_KEYCHAIN_SERVICE = 'vessel-federation';

/** SecretStore 文件回退目录（`<dataDir>/federation/`）。 */
export function federationSecretsDir(dataDir: string): string {
  return join(dataDir, 'federation');
}

/** peer token 的存储 key：`peer:<nodeId>:<teamId>`。 */
export function federationPeerSecretKey(nodeId: string, teamId: string): string {
  return `peer:${nodeId}:${teamId}`;
}

/** resolver `secrets` map 的 key：`<nodeId>:<teamId>`（与存储 key 一一对应）。 */
export function federationPeerSecretLabel(nodeId: string, teamId: string): string {
  return `${nodeId}:${teamId}`;
}

export interface FederationSecretsOptions {
  dataDir: string;
  /** 缺省 true；显式 false 时平台密钥库不可用即 fail-closed。 */
  allowFileSecrets?: boolean;
  logger?: Logger;
  /** 测试注入 */
  createSecretStore?: (options: CreateSecretStoreOptions) => SecretStore;
}

/** 创建 federation 专用 SecretStore（平台适配器 + 可选加密文件回退）。 */
export function createFederationSecretStore(options: FederationSecretsOptions): SecretStore {
  const create = options.createSecretStore ?? createSecretStore;
  return create({
    dataDir: federationSecretsDir(options.dataDir),
    allowFileSecrets: options.allowFileSecrets !== false,
    keychainService: FEDERATION_KEYCHAIN_SERVICE,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/** 配置里声明了 `tokenSecret: true` 且身份合法的 peer 标签。 */
function secretPeerLabels(federation: FederationConfig | undefined): string[] {
  const configured = Array.isArray(federation?.peers) ? federation.peers : [];
  const labels: string[] = [];
  for (const peer of configured) {
    if (peer === null || typeof peer !== 'object') continue;
    if (peer.tokenSecret !== true) continue;
    if (typeof peer.nodeId !== 'string' || typeof peer.teamId !== 'string') continue;
    labels.push(federationPeerSecretLabel(peer.nodeId, peer.teamId));
  }
  return labels;
}

/**
 * 预加载 `tokenSecret` peer 的 token，供同步 `resolveFederationOptions` 消费。
 *
 * - 没有 secret peer ⇒ 直接返回 `{}`（不构造 SecretStore，零平台命令开销）；
 * - 单个 key 读取失败 / 缺失 ⇒ 该 peer 缺席（resolver 按 missing_token fail-closed
 *   丢弃），不影响其它 peer；
 * - SecretStore 构造失败（fail-closed 配置）⇒ 返回 `{}` + 一行 warn，绝不抛。
 */
export async function loadFederationPeerSecrets(options: {
  dataDir: string;
  federation?: FederationConfig;
  logger?: Logger;
  createSecretStore?: (options: CreateSecretStoreOptions) => SecretStore;
}): Promise<Record<string, string>> {
  const labels = secretPeerLabels(options.federation);
  if (labels.length === 0) return {};
  let store: SecretStore;
  try {
    store = createFederationSecretStore({
      dataDir: options.dataDir,
      allowFileSecrets: options.federation?.allowFileSecrets,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.createSecretStore !== undefined
        ? { createSecretStore: options.createSecretStore }
        : {}),
    });
  } catch (error) {
    options.logger?.warn('federation.secrets.unavailable', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
  const secrets: Record<string, string> = {};
  for (const label of labels) {
    const [nodeId, teamId] = label.split(':');
    if (nodeId === undefined || teamId === undefined) continue;
    try {
      const token = await store.get(federationPeerSecretKey(nodeId, teamId));
      if (typeof token === 'string' && token !== '') secrets[label] = token;
    } catch (error) {
      // 单 peer 失败不拖垮整批；resolver 会按 missing_token 丢弃该 peer。
      options.logger?.warn('federation.secrets.read_failed', {
        peer: label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return secrets;
}

/** 写入 / 轮转一个 peer 的共享 token（配对握手两侧都用它）。 */
export async function saveFederationPeerSecret(
  options: FederationSecretsOptions,
  peer: { nodeId: string; teamId: string },
  token: string,
): Promise<void> {
  const store = createFederationSecretStore(options);
  await store.set(federationPeerSecretKey(peer.nodeId, peer.teamId), token);
}

/** 删除一个 peer 的共享 token（peer remove 时清理；缺失幂等）。 */
export async function deleteFederationPeerSecret(
  options: FederationSecretsOptions,
  peer: { nodeId: string; teamId: string },
): Promise<void> {
  const store = createFederationSecretStore(options);
  await store.delete(federationPeerSecretKey(peer.nodeId, peer.teamId));
}
