/**
 * `vessel update [--check] [--channel latest|beta] [--json]`
 *
 * 0.1.0：只做版本检查与升级提示，不下载、不校验、不自替换。
 * 退出码：0 成功（含已最新）、1 网络/清单失败、2 参数/通道错误。
 */

import { loadConfig } from '../packages/config/src/index';
import { checkForUpdate } from './update/check';
import type { UpdateChannel } from './update/manifest';
import { readPackageVersion } from './version';

export interface UpdateCommandOptions {
  check: boolean;
  channel?: UpdateChannel;
  json: boolean;
  force: boolean;
}

/** 执行更新检查命令，返回进程退出码 */
export async function runUpdateCommand(options: UpdateCommandOptions): Promise<number> {
  const { config } = await loadConfig();

  const channel = resolveChannel(options.channel, config.update?.channel);
  if (!channel) {
    console.error('Invalid update channel. Use "latest" or "beta" (--channel or VESSEL_CHANNEL).');
    return 2;
  }

  const current = readPackageVersion();

  try {
    const result = await checkForUpdate({
      currentVersion: current,
      channel,
      source: process.env.VESSEL_UPDATE_SOURCE ?? config.update?.source,
      timeoutMs: 5000,
    });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            current: result.current,
            latest: result.latest,
            channel: result.channel,
            up_to_date: result.upToDate,
            install_hint: result.installHint,
          },
          null,
          2,
        ),
      );
    } else if (result.upToDate) {
      console.log(`Vessel is up to date (${current}, channel: ${result.channel}).`);
    } else {
      console.log(`Update available: ${current} -> ${result.latest} (channel: ${result.channel})`);
      console.log(result.installHint);
      console.log(
        'Self-update is disabled in 0.1.0; install the new version with the command above.',
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Update check failed: ${message}`);
    return 1;
  }
}

/** CLI > VESSEL_CHANNEL > 配置 > latest；非法环境变量返回 null */
function resolveChannel(
  cliChannel: UpdateChannel | undefined,
  configChannel: UpdateChannel | undefined,
): UpdateChannel | null {
  const raw = cliChannel ?? process.env.VESSEL_CHANNEL ?? configChannel ?? 'latest';
  if (raw === 'latest' || raw === 'beta') return raw;
  return null;
}
