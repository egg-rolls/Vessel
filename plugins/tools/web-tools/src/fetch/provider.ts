/**
 * 抓取后端的**接口 + 注册点**（宪法第十三条：后端能力做成插件包内的扩展点）。
 *
 * 加一个抓取后端（例如以后接某家 reader 服务）只需在插件包里
 * `registerFetchBackend(...)`，**不动 `web_fetch` 的输入/输出契约**：
 * 预算、缓存、限流、熔断、错误渲染都在工具层，后端只负责「把 URL 变成结果」。
 */

import type { WebToolsConfig } from '../config';
import type { DeepSeekDeps } from '../deepseek-client';
import type { WebFetchDeps } from '../http';
import type { FetchBackendId, WebFetchResult } from '../types';

export interface FetchRequest {
  /** 工具参数里的原始 URL（trim 过） */
  url: string;
  config: WebToolsConfig;
  /** 生效的字符预算（配置 + 工具参数 clamp 之后） */
  maxChars: number;
  deps: WebFetchDeps;
  /** 上游调用注入点（deepseek 后端用；缺省回落到 `deps.fetch`/`deps.now`） */
  api?: DeepSeekDeps;
  /** 退避毫秒（带抖动）；由 CostController 提供，只有计费后端用得上 */
  backoff: (attempt: number, retryAfterMs?: number) => number;
  signal?: AbortSignal;
}

export interface FetchBackend {
  readonly id: FetchBackendId;
  /** 是否计费（决定是否走三道成本闸与 QPS/host 限流；`local` = false） */
  readonly billed: boolean;
  /** 是否需要 key（true ⇒ 缺 key 时本地拒，不发请求） */
  readonly requiresKey: boolean;
  /**
   * 本地校验（**不发请求**）：URL 语法 / 端口 / userinfo / 私网字面量 / query string 策略。
   * 抛 `WebFetchError`。注意它跑在成本闸**之前**（参数校验是五步闸的第一步）。
   */
  validate(request: FetchRequest): void;
  /** 真正的抓取；成功返回统一结果，失败抛 `WebFetchError` */
  fetch(request: FetchRequest): Promise<WebFetchResult>;
}

const backends = new Map<FetchBackendId, FetchBackend>();

/** 注册（或覆盖）一个抓取后端。幂等。 */
export function registerFetchBackend(backend: FetchBackend): void {
  backends.set(backend.id, backend);
}

export function getFetchBackend(id: FetchBackendId): FetchBackend | undefined {
  return backends.get(id);
}

export function listFetchBackends(): FetchBackendId[] {
  return [...backends.keys()].sort();
}
