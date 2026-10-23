/**
 * Hub token broker（S5）。
 *
 * hub 用配对时保存的 exchange token 向节点换一枚短期 `control` token，
 * 只把结果交给当前调用方：
 * - 明文 token 不持久化、不写 registry、不打日志；
 * - 不做自动 refresh；过期后由上层提示重新配对。
 *
 * @module vessel/hub/token-broker
 */

import { isLoopbackHostname } from '../../packages/config/src/index';
import {
  type HubDataToken,
  type HubTokenBrokerLike,
  pairingSecretKey,
  type SecretStore,
} from './types';

/** 单次 exchange 超时（毫秒）。 */
export const EXCHANGE_TIMEOUT_MS = 10_000;

/** 带稳定错误码的 broker 错误；message 永不含 token。 */
export class HubTokenBrokerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HubTokenBrokerError';
    this.code = code;
  }
}

export interface HubTokenBrokerOptions {
  secretStore: SecretStore;
  /** 测试注入；缺省用全局 fetch。 */
  fetch?: typeof fetch;
  /** 时钟注入（保留给确定性测试与后续过期判断）。 */
  now?: () => number;
}

type FetchInit = RequestInit & { tls?: { ca: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并归一化节点 URL：非回环必须 https，禁止 path / query / hash / userinfo。 */
function normalizeNodeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HubTokenBrokerError('invalid_params', 'node url must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HubTokenBrokerError('invalid_params', 'node url must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new HubTokenBrokerError('invalid_params', 'node url must not contain userinfo');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new HubTokenBrokerError('invalid_params', 'node url must not contain a path');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new HubTokenBrokerError('invalid_params', 'node url must not contain query or hash');
  }
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    throw new HubTokenBrokerError(
      'invalid_params',
      'non-loopback nodes require https (plaintext fallback is not supported)',
    );
  }
  return url.origin;
}

/** 读取 CA PEM；失败按输入错误处理（调用方给了坏路径）。 */
async function readCaFile(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    throw new HubTokenBrokerError('invalid_params', 'failed to read ca_file');
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function errorFromEnvelope(body: unknown, fallbackMessage: string): HubTokenBrokerError {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : 'internal';
    const message = typeof body.error.message === 'string' ? body.error.message : fallbackMessage;
    return new HubTokenBrokerError(code, message);
  }
  return new HubTokenBrokerError('internal', fallbackMessage);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createHubTokenBroker(options: HubTokenBrokerOptions): HubTokenBrokerLike {
  const { secretStore } = options;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async exchangeForTeam(input) {
      const baseUrl = normalizeNodeUrl(input.url);
      const exchangeToken = await secretStore.get(pairingSecretKey(input.pairing_id, 'exchange'));

      if (!isNonEmptyString(exchangeToken)) {
        throw new HubTokenBrokerError(
          'not_paired',
          `No exchange token for pairing ${input.pairing_id}`,
        );
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${exchangeToken}`,
        'Content-Type': 'application/json',
      };
      const body = {
        v: 1,
        id: crypto.randomUUID(),
        method: 'auth.exchange',
        params: {
          team_id: input.team_id,
          ...(input.ttl_s !== undefined ? { ttl_s: input.ttl_s } : {}),
        },
      };

      const init: FetchInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      };
      if (input.ca_file !== undefined) {
        init.tls = { ca: await readCaFile(input.ca_file) };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
      init.signal = controller.signal;

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/rpc`, init as RequestInit);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new HubTokenBrokerError(
            'node_unreachable',
            `node did not respond within ${EXCHANGE_TIMEOUT_MS}ms`,
          );
        }
        throw new HubTokenBrokerError(
          'node_unreachable',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timer);
      }

      const envelope = await readJson(response);

      if (response.status === 401 || response.status === 403) {
        throw new HubTokenBrokerError('unauthorized', 'node rejected the exchange token');
      }
      if (response.status !== 200) {
        if (isRecord(envelope) && isRecord(envelope.error)) {
          throw errorFromEnvelope(envelope, `node RPC failed with HTTP ${response.status}`);
        }
        // 没有明确 RPC 错误体：按传输失败处理。
        throw new HubTokenBrokerError(
          'node_unreachable',
          `node RPC failed with HTTP ${response.status}`,
        );
      }
      if (!isRecord(envelope)) {
        throw new HubTokenBrokerError('internal', 'node returned an invalid RPC envelope');
      }
      if (envelope.ok === false) {
        throw errorFromEnvelope(envelope, 'node RPC failed');
      }
      if (envelope.ok !== true || !isRecord(envelope.result)) {
        throw new HubTokenBrokerError('internal', 'node returned an invalid RPC envelope');
      }

      const result = envelope.result;
      if (
        !isNonEmptyString(result.token) ||
        !isNonEmptyString(result.token_id) ||
        typeof result.expires_at !== 'number' ||
        !Number.isFinite(result.expires_at)
      ) {
        throw new HubTokenBrokerError('internal', 'node returned an invalid control token');
      }
      if (typeof result.scope === 'string' && result.scope !== 'control') {
        throw new HubTokenBrokerError('internal', 'node returned a non-control token');
      }

      const token: HubDataToken = {
        node_id: input.node_id,
        pairing_id: input.pairing_id,
        team_id: input.team_id,
        url: baseUrl,
        token: result.token,
        token_id: result.token_id,
        expires_at: result.expires_at,
        scope: 'control',
      };
      return token;
    },
  };
}
