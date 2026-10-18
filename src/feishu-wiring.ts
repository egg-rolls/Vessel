/**
 * 飞书渠道接线（0.4 A2）。
 *
 * - 默认关闭：`feishu.enabled !== true` 时不 import、不构造。
 * - 渠道自建专用 `InProcessRuntimeHost`（`maxMembers = feishu.max_members`）；
 *   asm 只注入 provider / model / pluginHost / session / events / 可选 runStore /
 *   可选 contextFactory / scheduler，**不注入主 Host**（Addendum B §11.3.3）。
 * - 只有显式 `--feishu` 才调用 `channel.start()`；enabled 单独不启动。
 */

import {
  DEFAULT_FEISHU_OPTIONS,
  DEFAULT_SCHEDULER_OPTIONS,
  type VesselConfig,
} from '../packages/config/src/index';
import type {
  ContextManager,
  EventStream,
  LLMProvider,
  PluginHost,
  RunStore,
  SessionBackend,
} from '../packages/core/src/index';
import type {
  FeishuChannelLike,
  FeishuChannelOptionsLike,
  FeishuModuleLike,
  FeishuSchedulerOptions,
} from './control-plane-types';
import type { PluginLoader } from './plugin-loader';

export interface ResolvedFeishuOptions {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  allowedChatIds: string[];
  sessionPrefix: string;
  replyTimeoutMs: number;
  maxReplyChars: number;
  maxMembers: number;
}

/** config → 渠道选项（凭据已由 loader 合并 env；此处不再读 env） */
export function resolveFeishuOptions(config: VesselConfig): ResolvedFeishuOptions {
  const feishu = config.feishu;
  return {
    appId: feishu?.appId ?? DEFAULT_FEISHU_OPTIONS.appId,
    appSecret: feishu?.appSecret ?? DEFAULT_FEISHU_OPTIONS.appSecret,
    domain: feishu?.domain ?? DEFAULT_FEISHU_OPTIONS.domain,
    allowedChatIds: [...(feishu?.allowedChatIds ?? DEFAULT_FEISHU_OPTIONS.allowedChatIds)],
    sessionPrefix: feishu?.sessionPrefix ?? DEFAULT_FEISHU_OPTIONS.sessionPrefix,
    replyTimeoutMs: feishu?.replyTimeoutMs ?? DEFAULT_FEISHU_OPTIONS.replyTimeoutMs,
    maxReplyChars: feishu?.maxReplyChars ?? DEFAULT_FEISHU_OPTIONS.maxReplyChars,
    maxMembers: feishu?.maxMembers ?? DEFAULT_FEISHU_OPTIONS.maxMembers,
  };
}

/** 专用 Host 的 Scheduler 选项：复用全局 scheduler.*，缺省用 core 默认值 */
export function resolveFeishuScheduler(config: VesselConfig): FeishuSchedulerOptions {
  return {
    maxConcurrency: config.scheduler?.maxConcurrency ?? DEFAULT_SCHEDULER_OPTIONS.maxConcurrency,
    maxQueueSize: config.scheduler?.maxQueueSize ?? DEFAULT_SCHEDULER_OPTIONS.maxQueueSize,
    perAgentSerial: config.scheduler?.perAgentSerial ?? DEFAULT_SCHEDULER_OPTIONS.perAgentSerial,
  };
}

/**
 * app_id 掩码（与 @vessel/feishu 的 maskAppId 同规则）：
 * 长度 > 4 → 前 4 位 + `***`；否则整体 `***`，避免短 id 被完整暴露。
 */
export function maskAppId(appId: string): string {
  return appId.length > 4 ? `${appId.slice(0, 4)}***` : '***';
}

/** 带稳定 code 的错误 */
export function feishuError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** `--feishu` 的配置门控；不满足时 exit 2 */
export function assertFeishuStartable(config: VesselConfig): void {
  if (config.feishu?.enabled !== true) {
    throw feishuError('channel_disabled', 'feishu.enabled is false');
  }
  const { appId, appSecret } = resolveFeishuOptions(config);
  if (appId.trim() === '' || appSecret.trim() === '') {
    throw feishuError(
      'feishu_invalid',
      'feishu requires app_id and app_secret (env VESSEL_FEISHU_APP_ID / VESSEL_FEISHU_APP_SECRET take precedence)',
    );
  }
}

export interface CreateFeishuOptions {
  config: VesselConfig;
  provider: LLMProvider;
  model: string;
  pluginHost: PluginHost;
  session: SessionBackend;
  events: EventStream;
  runStore?: RunStore;
  contextFactory?: () => ContextManager;
  /** 测试/示例注入 mock transport */
  transport?: unknown;
  /** 0.5：tenant 作用域；事件与状态带 tenant_id */
  tenantId?: string;
  /** 0.5：环境变量来源；tenant 实例缺省 `{}`（不读 ambient VESSEL_FEISHU_*） */
  env?: Record<string, string | undefined>;
  loader?: Pick<PluginLoader, 'loadModule'>;
  /** 测试注入口；优先于 loader */
  loadModule?: () => Promise<unknown | null>;
}

/** 一个 tenant 的有效配置（用于飞书 app_id 唯一性检查） */
export interface FeishuTenantConfig {
  tenantId: string;
  config: VesselConfig;
}

/**
 * 同一 `app_id` 只能绑定一个 tenant（A-6 §13.4 / A-3 §10.7）。
 * 只检查启用飞书的 tenant；错误信息里的 app_id 只保留前 4 位 + `***`。
 */
export function assertUniqueFeishuAppIds(entries: FeishuTenantConfig[]): void {
  const owners = new Map<string, string>();
  for (const entry of entries) {
    if (entry.config.feishu?.enabled !== true) continue;
    const appId = resolveFeishuOptions(entry.config).appId.trim();
    if (appId === '') continue;
    const existing = owners.get(appId);
    if (existing !== undefined && existing !== entry.tenantId) {
      throw feishuError(
        'feishu_duplicate_app_id',
        `app_id ${maskAppId(appId)} is bound to tenants "${existing}" and "${entry.tenantId}"`,
      );
    }
    owners.set(appId, entry.tenantId);
  }
}

/**
 * 构造飞书渠道；未启用时返回 undefined（不 import）。
 * @throws error.code=feishu_invalid 凭据缺失
 * @throws error.code=feishu_plugin_unavailable 模块缺失
 */
export async function createFeishuFromConfig(
  options: CreateFeishuOptions,
): Promise<FeishuChannelLike | undefined> {
  if (options.config.feishu?.enabled !== true) return undefined;

  const resolved = resolveFeishuOptions(options.config);
  if (resolved.appId.trim() === '' || resolved.appSecret.trim() === '') {
    throw feishuError(
      'feishu_invalid',
      'feishu requires app_id and app_secret (env takes precedence)',
    );
  }

  const load = options.loadModule ?? (async () => options.loader?.loadModule('feishu') ?? null);
  const mod = (await load()) as FeishuModuleLike | null | undefined;

  if (!mod || typeof mod.createFeishuPlugin !== 'function') {
    throw feishuError(
      'feishu_plugin_unavailable',
      'plugin "feishu" not found or does not export createFeishuPlugin()',
    );
  }

  const scheduler = resolveFeishuScheduler(options.config);
  const channelOptions: FeishuChannelOptionsLike = {
    config: {
      enabled: true,
      appId: resolved.appId,
      appSecret: resolved.appSecret,
      domain: resolved.domain,
      allowedChatIds: resolved.allowedChatIds,
      sessionPrefix: resolved.sessionPrefix,
      replyTimeoutMs: resolved.replyTimeoutMs,
      maxReplyChars: resolved.maxReplyChars,
      maxMembers: resolved.maxMembers,
    },
    events: options.events,
    provider: options.provider,
    model: options.model,
    pluginHost: options.pluginHost,
    session: options.session,
    maxConcurrency: scheduler.maxConcurrency,
    maxQueueSize: scheduler.maxQueueSize,
    perAgentSerial: scheduler.perAgentSerial,
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(options.contextFactory ? { contextFactory: options.contextFactory } : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    // tenant 实例显式 `{}`：凭据已由 config loader 合并，禁止插件再读 ambient env。
    env: options.env ?? {},
  };

  return mod.createFeishuPlugin(channelOptions);
}

/** 幂等 stop（best-effort；shutdown 第一顺位） */
export async function stopFeishuChannel(channel: FeishuChannelLike | undefined): Promise<void> {
  if (!channel) return;
  try {
    await channel.stop();
  } catch {
    // 关闭失败不阻断退出
  }
}
