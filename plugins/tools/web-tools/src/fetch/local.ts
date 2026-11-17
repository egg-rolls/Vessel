/**
 * `local` 抓取后端（缺省）：本进程直接连目标，走 `http.ts` 的全套 SSRF / robots / 抽取。
 *
 * 免费、离线可用、内网可调试（显式开 `allow_private_networks`）、每一跳都在我们眼里。
 * 它不计费 ⇒ 不进三道成本闸，也不改任何现有行为（设计 §10 第 1 条）。
 */

import { withMaxChars } from '../config';
import { fetchPage, type WebFetchDeps } from '../http';
import { checkUrl } from '../ssrf';
import type { WebFetchResult } from '../types';
import type { FetchBackend, FetchRequest } from './provider';

export const localFetchBackend: FetchBackend = {
  id: 'local',
  billed: false,
  requiresKey: false,

  validate(request: FetchRequest): void {
    // 静态校验（不发 DNS、不发请求）：连 URL 都不合法就不用往下走了
    checkUrl(request.url, {
      allowPrivateNetworks: request.config.allowPrivateNetworks,
      domainAllowlist: request.config.domainAllowlist,
      domainDenylist: request.config.domainDenylist,
    });
  },

  async fetch(request: FetchRequest): Promise<WebFetchResult> {
    const deps: WebFetchDeps = request.deps;
    return fetchPage(request.url, {
      config: withMaxChars(request.config, request.maxChars),
      deps,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
  },
};
