/**
 * @vessel-agent/doc-subscription - 显式文档订阅插件
 * @module @vessel-agent/doc-subscription
 *
 * 提供三件东西：
 * - `subscribe` 工具：显式 add / remove / list / inspect 具体文件（无 glob、无目录、无自动发现）。
 * - `AfterTool` hook：edit/write 自动订阅所改文件（subscribe:false 可 opt-out；蜂群 Phase 1 第二重）；
 *   read 自动订阅所读行范围（line-level，subscribe:false 可 opt-out；蜂群协作增强）。
 * - `BeforeLlm` hook：每个 run 第一次 LLM 请求前先消费会话壳清除集合（read 引用释放 / 过期，
 *   lifecycle.ts），再检查订阅文件，向 `ctx.messages` 追加一条持久化尾部消息
 *   （`role: user` + `name: 'vessel:notice'` + 首行 `files: …`，不改写 system）；
 *   元数据行之外，第一个 line-level 变化条目可带范围 diff 明细行；整文件正文只在模型显式
 *   `inspect` 时返回。线格式见 `./notice.ts`。
 *
 * 不新增 core 模型 / 事件；订阅状态按 session 存在 `stateDir` 下。
 */

import { buildPathBoundary } from '@vessel-agent/basic-tools';
import type { Plugin, PluginHost } from '@vessel-agent/core';
import { createAutoSubscribeHook } from './auto-sub.js';
import { type DocSubscriptionConfig, parseDocSubscriptionConfig } from './config.js';
import { createBeforeLlmHook } from './hook.js';
import { SubscriptionStore } from './store.js';
import { createSubscribeTool } from './tool.js';

export { AUTO_SUBSCRIBE_HOOK, createAutoSubscribeHook } from './auto-sub.js';
export type { DocSubscriptionConfig } from './config.js';
export { parseDocSubscriptionConfig } from './config.js';
export { type UnifiedDiffOptions, type UnifiedDiffResult, unifiedDiff } from './diff.js';
export { type BeforeLlmHookDeps, createBeforeLlmHook, MAX_FILE_BYTES } from './hook.js';
export { consumeClearedToolResults } from './lifecycle.js';
export {
  fitDiffContentLines,
  formatSubscriptionNotice,
  SUBSCRIPTION_NOTICE_DETAIL_MARK,
  SUBSCRIPTION_NOTICE_DETAILS_MAX,
  SUBSCRIPTION_NOTICE_DIFF_TRUNCATED,
  SUBSCRIPTION_NOTICE_MAX_LINES,
  SUBSCRIPTION_NOTICE_MESSAGE_NAME,
  SUBSCRIPTION_NOTICE_SCOPE,
  type SubscriptionNoticeContent,
} from './notice.js';
export {
  emptyState,
  type ReadRef,
  type SessionSubscriptionState,
  type SubscriptionEntry,
  SubscriptionStore,
  subscriptionId,
} from './store.js';
export {
  autoSubscribePath,
  createSubscribeTool,
  MAX_SUBSCRIBE_BYTES,
  readSubscribePath,
  type SubscribeToolDeps,
} from './tool.js';

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
      'Per-session file subscriptions: `subscribe` tool + edit/write auto-subscribe ' +
      '(subscribe:false opt-out) + read line-range auto-subscribe + BeforeLlm change notices ' +
      'with line-level diffs and cleared-tool-result lifecycle',
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
      host.registerHook(createAutoSubscribeHook({ boundary, store, config }));
    },
  };
}

/** 默认插件实例（无配置；装配层可经 pluginConfigs 透传 config） */
export const docSubscriptionPlugin: Plugin = createDocSubscriptionPlugin();

export default docSubscriptionPlugin;
