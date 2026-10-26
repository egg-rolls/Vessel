/**
 * @vessel-agent/doc-subscription - 显式文档订阅插件
 * @module @vessel-agent/doc-subscription
 *
 * 提供两件东西：
 * - `subscribe` 工具：显式 add / remove / list / inspect 具体文件（无 glob、无自动订阅）。
 * - `BeforeLlm` hook：每个 run 第一次 LLM 请求前检查订阅文件，向 `ctx.messages`
 *   追加一条只含 path / id / rev / bytes 的持久化尾部消息
 *   （`role: user` + `name: 'vessel:subscription'`，不改写 system）；
 *   正文只在模型显式 `inspect` 时返回。
 *
 * 不新增 core 模型 / 事件；订阅状态按 session 存在 `stateDir` 下。
 */

import { buildPathBoundary } from '@vessel-agent/basic-tools';
import type { Plugin, PluginHost } from '@vessel-agent/core';
import { type DocSubscriptionConfig, parseDocSubscriptionConfig } from './config.js';
import { createBeforeLlmHook } from './hook.js';
import { SubscriptionStore } from './store.js';
import { createSubscribeTool } from './tool.js';

export type { DocSubscriptionConfig } from './config.js';
export { parseDocSubscriptionConfig } from './config.js';
export { type UnifiedDiffOptions, type UnifiedDiffResult, unifiedDiff } from './diff.js';
export { type BeforeLlmHookDeps, createBeforeLlmHook, MAX_FILE_BYTES } from './hook.js';
export {
  emptyState,
  type SessionSubscriptionState,
  type SubscriptionEntry,
  SubscriptionStore,
  subscriptionId,
} from './store.js';
export { createSubscribeTool, MAX_SUBSCRIBE_BYTES, type SubscribeToolDeps } from './tool.js';

/** 插件构造选项（与 install 的第二参数同形） */
export interface DocSubscriptionPluginOptions {
  config?: Record<string, unknown>;
}

/** 插件描述 */
export const DOC_SUBSCRIPTION_PLUGIN_NAME = 'doc-subscription';

/**
 * 创建插件实例。
 * 显式传入的 install options.config 优先于工厂 options.config；
 * `enabled: false` 时 install 不注册任何工具 / hook。
 */
export function createDocSubscriptionPlugin(options: DocSubscriptionPluginOptions = {}): Plugin {
  return {
    name: DOC_SUBSCRIPTION_PLUGIN_NAME,
    version: '0.26.2',
    description:
      'Explicit per-session file subscriptions: `subscribe` tool + BeforeLlm change notices',
    install(host: PluginHost, installOptions?: { config?: Record<string, unknown> }): void {
      const config: DocSubscriptionConfig = parseDocSubscriptionConfig(
        installOptions?.config ?? options.config,
      );
      if (!config.enabled) return;

      const boundary = buildPathBoundary({
        allowedRoots: config.allowedRoots,
        denyPaths: config.denyPaths,
        cwd: config.cwd,
      });
      const store = new SubscriptionStore(config.stateDir);

      host.registerTool(createSubscribeTool({ boundary, store, config }));
      host.registerHook(createBeforeLlmHook({ boundary, store, config }));
    },
  };
}

/** 默认插件实例（无配置；装配层可经 pluginConfigs 透传 config） */
export const docSubscriptionPlugin: Plugin = createDocSubscriptionPlugin();

export default docSubscriptionPlugin;
