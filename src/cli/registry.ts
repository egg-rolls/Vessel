/**
 * CLI 一次性命令 locale 辅助（cli-single-source W2：手写注册表删除）。
 *
 * 执行分派唯一源 = command-spec.ts schema → project.ts projectDispatch
 * （DISPATCH_ENTRIES，路径相等命中）；run 实现经 schema load() thunk 懒加载。
 * 本模块只保留入口 locale 应用（cli.ts 分派前消费）。
 *
 * @module vessel/cli-registry
 */

import { loadConfig } from '../../packages/config/src/index';
import { applyLocale } from '../i18n';

/**
 * 一次性命令也尊重 `config.ui.language`（0.10 R2-20）：
 * 配置读取失败时保持入口的 env locale，不阻断命令。
 */
export async function applyCommandLocale(): Promise<void> {
  try {
    const { config } = await loadConfig();
    applyLocale((config.ui as { language?: string } | undefined)?.language);
  } catch {
    // 配置不可读：沿用 VESSEL_LANG / LANG / LC_ALL
  }
}
