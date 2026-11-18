/**
 * plugin-embed 契约 §8：内嵌模块加载（fail-closed）。
 *
 * 加载前先做运行时 semver 核对（React.version / SDK_VERSION 对 manifest
 * runtime 范围）；不满足 → incompatible（渲染错误卡 + 隔离动作）。通过后
 * `import(url + '?v=' + ui_bundle_hash)`（入口 no-cache + 哈希查询双保险），
 * 取 `module[page.component]` 具名导出；不是函数 → failed。
 */
import {
  type PluginModule,
  type PluginMountProps,
  satisfiesVersionRange,
} from '@vessel-agent/plugin-sdk';
import type { ComponentType } from 'react';
import { version as reactVersion } from 'react';

export type EmbedLoadResult =
  | { status: 'ready'; module: PluginModule; component: ComponentType<PluginMountProps> }
  | { status: 'incompatible'; detail: string }
  | { status: 'failed'; detail: string };

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadPluginEmbed(options: {
  /** 模块 URL（不含查询串）；必须与 WebUI 同源（契约 §4）。 */
  url: string;
  hash: string;
  component: string;
  runtime: { react: string; sdk: string };
}): Promise<EmbedLoadResult> {
  if (!satisfiesVersionRange(reactVersion, options.runtime.react)) {
    return {
      status: 'incompatible',
      detail: `react ${reactVersion} does not satisfy "${options.runtime.react}"`,
    };
  }
  if (!satisfiesVersionRange(__VESSEL_PLUGIN_SDK_VERSION__, options.runtime.sdk)) {
    return {
      status: 'incompatible',
      detail: `sdk ${__VESSEL_PLUGIN_SDK_VERSION__} does not satisfy "${options.runtime.sdk}"`,
    };
  }
  let module: PluginModule;
  try {
    // 动态 URL 不由 vite 分析；?v=<hash> 让热更新拿到新模块实例。
    module = (await import(/* @vite-ignore */ `${options.url}?v=${options.hash}`)) as PluginModule;
  } catch (error) {
    return { status: 'failed', detail: errorDetail(error) };
  }
  const exported = module[options.component];
  if (typeof exported !== 'function') {
    return {
      status: 'failed',
      detail: `named export "${options.component}" is not a component function`,
    };
  }
  return { status: 'ready', module, component: exported as ComponentType<PluginMountProps> };
}

/** 热更新切换 / 卸载前调用旧模块的可选 dispose（幂等、吞错）。 */
export function disposeEmbedModule(module: PluginModule | null): void {
  if (module === null || typeof module.dispose !== 'function') return;
  try {
    module.dispose();
  } catch {
    // dispose 失败不阻断切换；旧 ESM 模块本身无法卸载（泄漏有限次可接受）。
  }
}
