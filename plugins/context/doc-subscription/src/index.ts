/**
 * @vessel-agent/doc-subscription - 显式文档订阅插件
 * @module @vessel-agent/doc-subscription
 *
 * 提供三件东西：
 * - `subscribe` 工具：显式 add / remove / list / inspect 具体文件（无 glob、无目录、无自动发现）；
 *   source:'health' 泛化（q-health-subscription）：订阅 node 健康（本机 node_id 或联邦地址），
 *   观察宿主 node-health-watch 落的快照文件，reachable 翻转 / 版本 / 重启（started_at）变化通知。
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
import { type AgentEventsPort, registerFriendEdges } from './friend-edges.js';
import { createBeforeLlmHook } from './hook.js';
import { ScriptRunner } from './script.js';
import { SubscriptionStore } from './store.js';
import { createSubscribeTool } from './tool.js';

export { AUTO_SUBSCRIBE_HOOK, createAutoSubscribeHook } from './auto-sub.js';
export {
  type DocSubscriptionConfig,
  isValidScriptName,
  parseDocSubscriptionConfig,
  parseScriptSpecs,
  REGISTERED_SCRIPT_SCOPES,
  type ScriptSchedule,
  type ScriptSpec,
} from './config.js';
export { type UnifiedDiffOptions, type UnifiedDiffResult, unifiedDiff } from './diff.js';
export {
  type AgentEventsPort,
  type FriendSpawnEvent,
  registerFriendEdges,
} from './friend-edges.js';
export {
  describeHealthRev,
  type HealthSnapshot,
  healthSignature,
  healthSnapshotPath,
  healthSubscriptionKey,
  healthTargetNodeId,
  isValidHealthTarget,
  readHealthSnapshot,
} from './health.js';
export { type BeforeLlmHookDeps, createBeforeLlmHook, MAX_FILE_BYTES } from './hook.js';
export { consumeClearedToolResults } from './lifecycle.js';
export {
  CODE_HEAVINESS_NOTICE_SCOPE,
  DOC_LAG_NOTICE_SCOPE,
  fitDiffContentLines,
  formatHealthNotice,
  formatScriptNotice,
  formatSubscriptionNotice,
  HEALTH_NOTICE_SCOPE,
  SCRIPT_NOTICE_SCOPE,
  type ScriptNoticeEntry,
  SUBSCRIPTION_NOTICE_DETAIL_MARK,
  SUBSCRIPTION_NOTICE_DETAILS_MAX,
  SUBSCRIPTION_NOTICE_DIFF_TRUNCATED,
  SUBSCRIPTION_NOTICE_MAX_LINES,
  SUBSCRIPTION_NOTICE_MESSAGE_NAME,
  SUBSCRIPTION_NOTICE_SCOPE,
  type SubscriptionNoticeContent,
} from './notice.js';
export {
  type ScriptResult,
  ScriptRunner,
  scriptFlightKey,
  scriptSubscriptionKey,
} from './script.js';
export {
  type ChangeOrigin,
  emptyState,
  type ReadRef,
  type ScriptEntryState,
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

/** agentEvents 端口形状守卫（装配注入；缺省 / 非法 ⇒ 不记边，零回归）。 */
function isAgentEventsPort(value: unknown): value is AgentEventsPort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AgentEventsPort).subscribe === 'function' &&
    typeof (value as AgentEventsPort).sessionOf === 'function'
  );
}

/**
 * 创建插件实例。
 * 显式传入的 install options.config 优先于工厂 options.config；
 * `enabled: false` 时 install 不注册任何工具 / hook。
 */
export function createDocSubscriptionPlugin(options: DocSubscriptionPluginOptions = {}): Plugin {
  // 本实例的执行器（dispose 可达；install 前 / enabled:false 时缺省）。
  let installedRunner: ScriptRunner | undefined;
  // 好友边 listener 退订口（q-sub-unify-p1 M6；dispose 可达）。
  let unsubscribeFriendEdges: (() => void) | undefined;
  return {
    name: DOC_SUBSCRIPTION_PLUGIN_NAME,
    version: '0.27.0',
    description:
      'Per-session file & node-health & script subscriptions: `subscribe` tool (source file|health|script) + ' +
      'edit/write auto-subscribe (subscribe:false opt-out) + read line-range auto-subscribe + ' +
      'BeforeLlm change notices with line-level diffs and cleared-tool-result lifecycle; ' +
      'script source runs user-config allowlisted detection commands async (fire-and-forget; ' +
      'run/request/interval-real-timer schedules; per-scope env cards: script/doc-lag/code-heaviness)',
    install(host: PluginHost, installOptions?: { config?: Record<string, unknown> }): void {
      const rawConfig = installOptions?.config ?? options.config;
      const config: DocSubscriptionConfig = parseDocSubscriptionConfig(rawConfig);
      if (!config.enabled) return;

      // live 配置 getter（q-subscription-script，hot-gate 同族修复）：装配层在 install
      // config 里注入 `liveConfig: () => 活合并配置记录`（buildPluginConfigMap 同源）。
      // 每次 hook run / 工具调用重新解析 ⇒ cadence / channel / scripts 热改即时生效；
      // 成员 runtime 复制父 hook 引用后读的也是活配置（非 install 快照）。
      const rawLive =
        typeof rawConfig === 'object' && rawConfig !== null
          ? (rawConfig as Record<string, unknown>).liveConfig
          : undefined;
      const liveConfig =
        typeof rawLive === 'function'
          ? (): DocSubscriptionConfig => parseDocSubscriptionConfig((rawLive as () => unknown)())
          : undefined;

      const boundary = buildPathBoundary({
        allowedRoots: config.allowedRoots,
        denyPaths: config.denyPaths,
        cwd: config.cwd,
      });
      const store = new SubscriptionStore(config.stateDir);
      // script 执行器：每实例一份（成员共享 hook 引用 ⇒ 单飞按 session+name 键控）。
      const runner = new ScriptRunner();

      // 好友边自动互记（q-sub-unify-p1 M6）：装配层注入 agentEvents 端口（晚绑定
      // fan-out bridge）；缺省 ⇒ 不记边（裸宿主 / 旧装配零回归）。写入走本实例 store
      // 的 per-session 串行链，零竞态。
      const rawEvents =
        typeof rawConfig === 'object' && rawConfig !== null
          ? (rawConfig as Record<string, unknown>).agentEvents
          : undefined;
      if (isAgentEventsPort(rawEvents)) {
        unsubscribeFriendEdges = registerFriendEdges(store, rawEvents);
      }

      host.registerTool(createSubscribeTool({ boundary, store, config, liveConfig, runner }));
      host.registerHook(createBeforeLlmHook({ boundary, store, config, liveConfig, runner }));
      // auto-sub 同注入 live getter（q-doc-subscription-hot-gate 残留修复）：edit/write/read
      // 自动订阅的 cwd / maxFullBytes 热改即时生效，与手动 add / BeforeLlm 同一份活配置。
      host.registerHook(createAutoSubscribeHook({ boundary, store, config, liveConfig }));
      installedRunner = runner;
    },
    dispose(): void {
      // kill 在飞脚本 + 清 timer / 队列（不永久禁用：成员持旧 hook 引用经 live getter
      // 继续工作，见 script.ts 模块注释）。
      installedRunner?.dispose();
      installedRunner = undefined;
      unsubscribeFriendEdges?.();
      unsubscribeFriendEdges = undefined;
    },
  };
}

/** 默认插件实例（无配置；装配层可经 pluginConfigs 透传 config） */
export const docSubscriptionPlugin: Plugin = createDocSubscriptionPlugin();

export default docSubscriptionPlugin;
