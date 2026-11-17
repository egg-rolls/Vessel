/**
 * 内置后端的**唯一注册点**（宪法第十三条）。
 *
 * 以后加 Bing / SearxNG（P2）或另一种抓取后端：在插件包里写一个实现，
 * 在这里 `registerSearchProvider(...)` / `registerFetchBackend(...)` 加上一行，
 * **工具层（`index.ts` 的 web_search / web_fetch）、预算、缓存、闸一行都不用动**。
 *
 * ## 为什么「光有注册点」不够用（期 2 实测发现，别再踩）
 *
 * 搜索侧曾经把后端和传输写死在共用层里：`search/index.ts` 直接
 * `getSearchProvider(DEFAULT_SEARCH_PROVIDER_ID)` + `createDeepSeekHttp(...)`，
 * key 也只有一张环境变量名（`key_env` / `search_key_env`）。
 * ⇒ 那时在这里 `registerSearchProvider(tavily)` 是**假的**：注册了也永远不会被调用。
 * 只有真的加第二家才会暴露，加之前谁都觉得「注册一下就好了」。
 *
 * 现在要让一家新后端**真的能跑**，需要的是 `search/provider.ts` 上这三个字段：
 * - `keyEnv`：这家缺省读哪个环境变量（配置 `search_key_env` 仍可覆盖）；
 * - `createHttp?()`：鉴权风格不同（Serper 只认 `X-API-KEY`）时自带传输层，
 *   **重试/退避/错误映射/擦除仍复用 `provider-http.ts` 的同一份**，不许另写闸；
 * - `maxCount?`：上游条数上限（Tavily 20），由 provider 自己夹紧。
 *
 * ## 注册顺序 = `search_provider=auto` 的优先级
 *
 * deepseek → tavily → serper → custom:bocha。多个 key 同时在场时，按这个顺序取第一个 key 在位的。
 * 想固定用某一家就显式配，别靠顺序：
 *
 * ```yaml
 * plugins:
 *   - name: web-tools
 *     config:
 *       search_provider: tavily   # 显式优先于注册顺序
 * ```
 */

import { deepseekFetchBackend } from './deepseek-fetch';
import { localFetchBackend } from './fetch/local';
import { registerFetchBackend } from './fetch/provider';
import { BOCHA_PRESET, createCustomProvider } from './search/custom';
import { deepseekSearchProvider } from './search/deepseek';
import { registerSearchProvider } from './search/provider';
import { serperSearchProvider } from './search/serper';
import { tavilySearchProvider } from './search/tavily';

let registered = false;

/** 幂等：重复调用不会重复注册（Map 覆盖也安全，这里只是省事） */
export function registerBuiltinBackends(): void {
  if (registered) return;
  registered = true;
  // 顺序 = `search_provider=auto` 的优先级（见文件头）：deepseek → tavily → serper → custom:bocha
  registerSearchProvider(deepseekSearchProvider);
  registerSearchProvider(tavilySearchProvider);
  registerSearchProvider(serperSearchProvider);
  // Bocha 不再有专用适配器：它是「声明式自定义后端」的内置预设（`custom:bocha`）
  registerSearchProvider(createCustomProvider(BOCHA_PRESET));
  registerFetchBackend(localFetchBackend);
  registerFetchBackend(deepseekFetchBackend);
}

// 模块加载即注册：直接 import 本包做结构化调用（真机脚本、上层装配）也能拿到后端
registerBuiltinBackends();
