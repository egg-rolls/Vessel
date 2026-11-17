/**
 * 插件安装 / init / dispose 生命周期（Stage 4，装配缝）。
 *
 * 从 `ExecutionUnit` 等价搬出，供 Assembly 在多个 per-session EU 之间共享
 * 同一个 `PluginHost`：tenant 插件只安装一次，事件仍由调用方提供的 `publish`
 * 投递，事件名 / 顺序 / `run_id:'plugin'` / 时间戳生成方式与 EU 内联实现一致。
 *
 * @module @vessel-agent/core/runtime
 */

import type { RunEvent } from '../types/event.js';
import type { Logger } from '../types/logging.js';
import type { Plugin, PluginHost } from '../types/plugin.js';
import { assertToolNameLegality } from './tool-name.js';

/** 一次安装的句柄：已安装插件（安装顺序）+ 逆序 dispose。 */
export interface InstalledPlugins {
  readonly plugins: readonly Plugin[];
  dispose(): Promise<void>;
}

/** 安装依赖；publish 由调用方提供（EU / Assembly 各自的观察流）。 */
export interface InstallPluginsOptions {
  host: PluginHost;
  plugins: readonly Plugin[];
  /** 按插件名的安装配置；缺省保持 `install(host)` */
  pluginConfigs?: Record<string, Record<string, unknown>>;
  /** 事件投递（EU 传 publishEvent，Assembly 传 events.publish） */
  publish: (event: RunEvent) => void;
  logger?: Logger;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 安装全部插件（fail-fast + rollback），随后按安装顺序 init。
 * 返回的 handle.dispose() 按逆安装顺序 best-effort 调用插件 dispose。
 */
export async function installPluginsIntoHost(
  opts: InstallPluginsOptions,
): Promise<InstalledPlugins> {
  const installed: Plugin[] = [];

  for (const plugin of opts.plugins) {
    const scope = opts.host.beginPluginInstall?.(plugin.name);
    try {
      const config = opts.pluginConfigs?.[plugin.name];
      const result =
        config === undefined ? plugin.install(opts.host) : plugin.install(opts.host, { config });
      if (result instanceof Promise) {
        await result; // 如果失败，让 async 构造函数抛出
      }
      scope?.commit();
      installed.push(plugin);
      opts.publish({
        type: 'plugin.loaded',
        run_id: 'plugin',
        data: {
          name: plugin.name,
          ...(plugin.version !== undefined ? { version: plugin.version } : {}),
        },
        ts: Date.now(),
      });
    } catch (error) {
      scope?.rollback();
      opts.publish({
        type: 'plugin.failed',
        run_id: 'plugin',
        data: {
          name: plugin.name,
          error: errorText(error),
        },
        ts: Date.now(),
      });
      throw error;
    }
  }

  // 所有 install 成功后按安装顺序 init；单个插件异常被隔离（0.9）
  for (const plugin of installed) {
    if (plugin.init === undefined) continue;
    try {
      await plugin.init({ host: opts.host });
    } catch (error) {
      opts.publish({
        type: 'plugin.init.failed',
        run_id: 'plugin',
        data: { name: plugin.name, error: errorText(error) },
        ts: Date.now(),
      });
    }
  }

  // 0.55 工具名审计（装配期的**唯一闸**：EU / Assembly / tenant 装配都经过这里）。
  //
  // 为什么在装配收尾而不是「等模型调错工具」：工具名原样进 provider 的
  // `tools[].function.name`，不合规会让**整个请求** 400 —— 失败粒度是整条会话，
  // 不是那一个工具。所以内置 / 插件工具名不合规一律在这里抛错，并列出全部违规项 + 建议名；
  // 外部来源（MCP server 等）的名字由对方决定，我们原样透传，同样校验但只记 warning
  // —— 判据一致，只是「我们改不了」这件事要在日志里看得见。
  const audit = assertToolNameLegality(opts.host, 'plugin assembly');
  for (const warning of audit.warnings) {
    opts.logger?.warn('external tool name is not snake_case; passed through as-is', {
      tool_name: warning.name,
      suggestion: warning.suggestion,
      source: warning.external ? 'external' : 'internal',
      detail: warning.message,
    });
  }

  return {
    plugins: installed,
    async dispose(): Promise<void> {
      // 逆安装顺序；异常只发 `plugin.dispose.failed`，不外抛（0.9）
      for (let index = installed.length - 1; index >= 0; index -= 1) {
        const plugin = installed[index] as Plugin;
        if (plugin.dispose === undefined) continue;
        try {
          await plugin.dispose();
        } catch (error) {
          opts.publish({
            type: 'plugin.dispose.failed',
            run_id: 'plugin',
            data: { name: plugin.name, error: errorText(error) },
            ts: Date.now(),
          });
        }
      }
    },
  };
}
