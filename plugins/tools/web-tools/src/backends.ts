/**
 * 内置后端的**唯一注册点**（宪法第十三条）。
 *
 * 以后加 Bing / Tavily / SearxNG（P2）或另一种抓取后端：在插件包里写一个实现，
 * 在这里 `registerSearchProvider(...)` / `registerFetchBackend(...)` 加上一行，
 * **工具层（`index.ts` 的 web_search / web_fetch）、预算、缓存、闸一行都不用动**。
 * DeepSeek 只是第一个实现。
 */

import { deepseekFetchBackend } from './deepseek-fetch';
import { localFetchBackend } from './fetch/local';
import { registerFetchBackend } from './fetch/provider';
import { deepseekSearchProvider } from './search/deepseek';
import { registerSearchProvider } from './search/provider';

let registered = false;

/** 幂等：重复调用不会重复注册（Map 覆盖也安全，这里只是省事） */
export function registerBuiltinBackends(): void {
  if (registered) return;
  registered = true;
  registerSearchProvider(deepseekSearchProvider);
  registerFetchBackend(localFetchBackend);
  registerFetchBackend(deepseekFetchBackend);
}

// 模块加载即注册：直接 import 本包做结构化调用（真机脚本、上层装配）也能拿到后端
registerBuiltinBackends();
