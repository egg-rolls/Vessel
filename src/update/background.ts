/**
 * REPL 启动后台检查。
 *
 * 只在真正进入 Ink REPL（TTY）时由 cli.ts 调用；失败静默、最多每天一次。
 * 有新版本时发布 `update.available` 事件（开放字符串协议），
 * 载荷：{ current, latest, channel, installHint }，由 TUI 消费。
 */

import type { VesselConfig } from '../../packages/config/src/index';
import type { ReplContext } from '../../packages/tui/src/index';
import { readPackageVersion } from '../version';
import { readUpdateCache, shouldCheck, writeUpdateCache } from './cache';
import { checkForUpdate } from './check';
import type { UpdateChannel } from './manifest';

/** 给 Ink 订阅者挂载留出时间，再发布事件 */
const PUBLISH_DELAY_MS = 300;

export async function scheduleUpdateCheck(ctx: ReplContext, config: VesselConfig): Promise<void> {
  try {
    if (!shouldCheck(await readUpdateCache())) return;

    const channel = resolveUpdateChannel(config);
    const result = await checkForUpdate({
      currentVersion: readPackageVersion(),
      channel,
      source: process.env.VESSEL_UPDATE_SOURCE ?? config.update?.source,
      timeoutMs: 1500,
    });

    await writeUpdateCache({
      checkedAt: Date.now(),
      current: result.current,
      latest: result.latest,
      channel: result.channel,
    });

    if (result.upToDate) return;

    await new Promise((resolve) => setTimeout(resolve, PUBLISH_DELAY_MS));
    ctx.events.publish({
      type: 'update.available',
      run_id: 'system',
      data: {
        current: result.current,
        latest: result.latest,
        channel: result.channel,
        installHint: result.installHint,
      },
      ts: Date.now(),
    });
  } catch {
    // 断网 / 404 / 清单损坏：静默跳过，不影响 REPL 启动
  }
}

/** 后台检查的通道：VESSEL_CHANNEL > 配置 > latest；非法值回退 latest */
export function resolveUpdateChannel(
  config: Pick<VesselConfig, 'update'>,
  env: Record<string, string | undefined> = process.env,
): UpdateChannel {
  const raw = env.VESSEL_CHANNEL ?? config.update?.channel ?? 'latest';
  return raw === 'beta' ? 'beta' : 'latest';
}
