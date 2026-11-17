/**
 * `ProviderHttp` 的第一个实现：DeepSeek tools API（Bearer + POST JSON）。
 *
 * 把「共用层的重试/退避/错误映射/整体 deadline」与「某家的鉴权与路径」隔开：
 * 搜索 provider 只拿到一个 `postJson()`，它不知道有几次重试、也不知道 429 怎么退避。
 * 以后接一家 auth 风格不同的搜索后端时，在插件包里再写一个 `ProviderHttp` 即可，
 * 工具层与预算/缓存/闸一行都不用动。
 */

import type { WebToolsConfig } from './config';
import { callDeepSeekTool, type DeepSeekDeps } from './deepseek-client';
import type { ProviderHttp } from './search/provider';
import type { KeyKind } from './secrets';

export interface DeepSeekHttpOptions {
  config: WebToolsConfig;
  keyKind: KeyKind;
  signal?: AbortSignal;
  deps?: DeepSeekDeps;
  /** 退避毫秒（带抖动）；由 CostController 提供 */
  backoff: (attempt: number, retryAfterMs?: number) => number;
}

export function createDeepSeekHttp(options: DeepSeekHttpOptions): ProviderHttp {
  return {
    async postJson(request) {
      const result = await callDeepSeekTool({
        config: options.config,
        keyKind: options.keyKind,
        path: request.path,
        body: request.body,
        signal: options.signal,
        deps: options.deps,
        backoff: options.backoff,
        badRequestHint: request.hint,
      });
      return {
        json: result.json,
        status: result.status,
        attempts: result.attempts,
        upstreamMs: result.upstreamMs,
      };
    },
  };
}
