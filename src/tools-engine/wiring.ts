/**
 * tools-engine 批次 1 装配接线（P2 seams 契约 §3；N 装配层）。
 *
 * 白名单 read/edit/write/bash(sync) 就地换转发 handler（def 身份不变 ⇒ install scope /
 * applyTools 回滚 / P0 tools[] 快照全不受影响）；bash(async:true) 逐调用分流 callback
 * （jobs map / 通知槽 / dispose 留 host）。boundary / config 权威在 host：每次装配与
 * 热应用都用**当时**的 basic-tools 安装配置重建，下一信封自然带新值。
 *
 * 幂等：同一 def 对象二次 wire 是 no-op（engine-client WeakSet）；热应用产生的新 def
 * 对象重新 wire（新指纹覆盖）；工具被移除 → unwire（恢复原 handler + 账本 remove）。
 *
 * @module tools-engine/wiring
 */

import {
  type BasicToolsConfig,
  buildPathBoundary,
  type PathBoundary,
  parseBasicToolsConfig,
} from '@vessel-agent/basic-tools';
import type { PluginHost } from '@vessel-agent/core';
import type { EngineClient, ExecClass, ToolRoute } from '@vessel-agent/engine-client';

/** 批次 1 白名单（设计契约 §1；顺序无关，逐个按名取 live 定义）。 */
const BASIC_TOOLS_WHITELIST: readonly string[] = ['read', 'edit', 'write', 'bash'];

/** bash 逐调用分流：args.async === true → callback（host 编排），否则 worker。 */
function bashExecClass(args: unknown): ExecClass {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    if ((args as Record<string, unknown>).async === true) return 'callback';
  }
  return 'worker';
}

/**
 * 按当前宿主工具面 + 安装配置同步白名单接线（装配与热应用共用同一函数）。
 * rawConfig = buildPluginConfigMap(...)['basic-tools']（host 权威安装配置）。
 */
export function syncBasicToolsEngineWiring(
  client: EngineClient,
  host: PluginHost,
  rawConfig: unknown,
): void {
  const config: BasicToolsConfig = parseBasicToolsConfig(rawConfig);
  const boundary: PathBoundary = buildPathBoundary(config);
  for (const name of BASIC_TOOLS_WHITELIST) {
    const def = host.getTool(name);
    if (def === undefined) {
      client.unwireTool(name);
      continue;
    }
    const route: ToolRoute = {
      execClass: 'worker',
      ...(name === 'bash' ? { exec: bashExecClass } : {}),
      source: 'basic-tools',
      boundary,
      config,
    };
    client.wireTool(def, route);
  }
}
