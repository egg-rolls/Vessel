/**
 * `vessel --feishu` 的启动与错误分类（0.4 A2）。
 *
 * - `--feishu` 是附加开关：REPL / serve / 非 TTY 仅渠道前台；
 * - 配置错误（disabled / 缺凭据 / 模块缺失）→ exit 2；
 * - `channel.start()` 的 SDK / 连接失败 → exit 1（Addendum B §11.3.8）。
 */

import type { BootstrapResult } from './bootstrap';
import type { FeishuChannelLike } from './control-plane-types';
import { assertFeishuStartable, feishuError } from './feishu-wiring';

/** 飞书启动错误 → 退出码 */
export function feishuExitCode(error: unknown): number {
  const code = (error as { code?: string } | undefined)?.code;
  if (
    code === 'channel_disabled' ||
    code === 'feishu_invalid' ||
    code === 'feishu_plugin_unavailable'
  ) {
    return 2;
  }
  return 1;
}

/**
 * 校验 enabled/凭据并 start 渠道。
 * @throws channel_disabled / feishu_invalid（配置）或 SDK/连接错误（运行期）
 */
export async function startFeishuChannel(result: BootstrapResult): Promise<FeishuChannelLike> {
  assertFeishuStartable(result.config);

  const channel = result.feishu;
  if (!channel) {
    throw feishuError('channel_disabled', 'feishu channel was not constructed');
  }

  await channel.start();
  return channel;
}

/** SIGINT → 130；SIGTERM → 143 */
export function signalExitCode(signal: 'SIGINT' | 'SIGTERM'): number {
  return signal === 'SIGTERM' ? 143 : 130;
}
