/**
 * SDK 组合入口（R2）
 *
 * 构造 EventBus / Scheduler / Host，注入 session / contextFactory / permission /
 * transport 等 port 实现。**不自动 spawn owner**；调用方显式 `host.spawn(ownerSpec)`。
 *
 * @module @vessel-agent/core/kernel
 */

import { MemoryEventBus } from './event-bus.js';
import { InProcessRuntimeHost } from './runtime-host.js';
import { InProcessScheduler } from './scheduler.js';
import type { RuntimeHost, RuntimeOptions } from './types.js';

/** 用模块实现组装一个 RuntimeHost */
export async function createRuntime(options: RuntimeOptions = {}): Promise<RuntimeHost> {
  const events = options.events ?? new MemoryEventBus();
  const scheduler = new InProcessScheduler(options.scheduler);

  return new InProcessRuntimeHost({
    events,
    scheduler,
    ...(options.pluginHost ? { pluginHost: options.pluginHost } : {}),
    ...(options.contextFactory ? { contextFactory: options.contextFactory } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(options.permission ? { permission: options.permission } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.defaults ? { defaults: options.defaults } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.pluginConfigs !== undefined ? { pluginConfigs: options.pluginConfigs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.includeReasoning !== undefined
      ? { includeReasoning: options.includeReasoning }
      : {}),
    ...(options.eventLog !== undefined ? { eventLog: options.eventLog } : {}),
  });
}
