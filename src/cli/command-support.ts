/**
 * 一次性命令共享辅助（cli-single-source P1 · S2 自 registry.ts 移居）。
 *
 * schema load() thunk 与 registry 投射共用的执行辅助：结果打印 / 数据根解析 /
 * 工具清单。移居到此使 thunk 不必动态 import registry 重闭包（registry 静态
 * import 全部实现；本模块只含轻依赖）。行为逐字不变。
 *
 * @module vessel/cli-command-support
 */

import { loadConfig, type VesselConfig } from '../../packages/config/src/index';
import { resolveDataDir } from '../data/data-paths';
import { listTools } from '../tools-engine/tools-list';
import { ui } from './output';

/** 打印一次性命令结果并返回退出码 */
export function printCommandResult(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): number {
  if (result.stdout !== '') console.log(result.stdout);
  if (result.stderr !== '') console.error(ui.err(result.stderr));
  return result.exitCode;
}

/** 本地命令的数据根（不 bootstrap） */
export async function resolveCommandDataDir(): Promise<string> {
  const { config } = await loadConfig();
  return resolveDataDir(config);
}

/** federation 等本地命令需要同时拿到 dataDir 与已解析配置 */
export async function resolveCommandContext(): Promise<{ dataDir: string; config: VesselConfig }> {
  const { config } = await loadConfig();
  return { dataDir: resolveDataDir(config), config };
}

/** `--tools`：列出当前配置下的工具（headless 口径，不需要 Key） */
export async function printTools(): Promise<void> {
  const { tools, warnings, aliases } = await listTools();
  for (const w of warnings) console.warn(`⚠ ${w}`);
  console.log(ui.section(`Tools (${tools.length}):`));
  for (const t of tools) console.log(`  - ${t.name}: ${t.description}`);
  // 0.33：headless 也注册 ask（请求落盘后挂起），这里仍不展开它的 schema。
  console.log('ask (interactive REPL / gateway / headless-async; not listed here)');
  // 0.55：旧名不是工具，只在这一版还能用；列出来是为了「改名不静默」。
  if (aliases.length > 0) {
    console.log(ui.section('Deprecated tool-name aliases (still accepted, removed next version):'));
    for (const a of aliases)
      console.log(`  - ${a.alias} → ${a.target} (deprecated, removed in ${a.removeIn})`);
  }
}
