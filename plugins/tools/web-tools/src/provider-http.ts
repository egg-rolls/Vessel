/**
 * `ProviderHttp` 的两个实现：
 * 1. `createDeepSeekHttp` —— DeepSeek tools API（Bearer + `config.base_url`，历史第一个）；
 * 2. `createJsonHttp` —— 通用 JSON 传输（固定 host + 自定义鉴权头，Tavily / Serper 用）。
 *
 * 两者共用 `deepseek-client.ts` 里**同一套**重试/退避/错误映射/擦除：把「这家怎么鉴权」
 * 与「重试几次、429 怎么退避、错误码怎么映射」彻底隔开。
 * 以后接一家 auth 风格又不同的后端：在插件包里再写一个 `ProviderHttp` 即可，
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

/**
 * 通用 JSON 传输层：**同一套**重试/退避/错误码映射/整体 deadline/`sk-` 擦除，
 * 只换「host」与「鉴权头」两件东西（Tavily = 固定 host + Bearer，Serper = 固定 host + `X-API-KEY`）。
 *
 * 为什么不是各写一份 `ProviderHttp`：重试策略、429/402/413 的语义、`Retry-After` ≤5s 的
 * 取舍、错误体擦除，这些一旦分叉就会出现「同一家后端两套闸」——本单的硬要求正是反过来的。
 */
export interface JsonHttpOptions {
  config: WebToolsConfig;
  keyKind: KeyKind;
  /** 已解析好的 key 环境变量名（只存名字） */
  keyEnvName: string;
  /** 绝对地址（固定 host 的后端用它，绕开 `config.baseUrl`） */
  endpoint: string;
  /** 鉴权头构造（值只在这一处出现，不进 URL/日志） */
  authHeaders: (key: string) => Record<string, string>;
  signal?: AbortSignal;
  deps?: DeepSeekDeps;
  backoff: (attempt: number, retryAfterMs?: number) => number;
}

export function createJsonHttp(options: JsonHttpOptions): ProviderHttp {
  return {
    async postJson(request) {
      const result = await callDeepSeekTool({
        config: options.config,
        keyKind: options.keyKind,
        keyEnvName: options.keyEnvName,
        endpoint: options.endpoint,
        authHeaders: options.authHeaders,
        path: request.path,
        body: request.body,
        ...(request.hint !== undefined ? { badRequestHint: request.hint } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.deps !== undefined ? { deps: options.deps } : {}),
        backoff: options.backoff,
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
