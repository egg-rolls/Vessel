/**
 * DirScanner —— 用户工具目录扫描 Provider（ADR-028）
 *
 * 扫描 `~/.vessel/tools/`（用户级）与 `./tools/`（项目级）目录，
 * 运行时加载自描述工具文件（#91）。用户放一个工具文件即被识别，
 * 无需改源码、无需构建。
 *
 * 支持的文件导出形态（default export）：
 * - 完整 `Plugin`（含 install()）
 * - 自描述工具对象 `ToolDefinition`（name/description/inputSchema/handler）
 * - 工具数组 `ToolDefinition[]`
 * - `{ tools: ToolDefinition[] }` / `{ tool: ToolDefinition }`
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plugin, PluginHost, ToolDefinition } from '../packages/core/src/index';
import type { PluginProvider } from './plugin-registry';

/** 默认扫描目录：用户级 + 项目级 */
function defaultDirs(): string[] {
  return [path.join(os.homedir(), '.vessel', 'tools'), path.join(process.cwd(), 'tools')];
}

/** 支持的文件扩展名（Bun 原生可 import .ts） */
const SUPPORTED_EXT = new Set(['.ts', '.js', '.mjs', '.cjs']);

/** 类型守卫：自描述工具对象 */
function isTool(value: unknown): value is ToolDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolDefinition).name === 'string' &&
    typeof (value as ToolDefinition).description === 'string' &&
    typeof (value as ToolDefinition).handler === 'function'
  );
}

/** 从模块导出中提取工具列表 */
function extractTools(exported: unknown): ToolDefinition[] {
  if (isTool(exported)) return [exported];
  if (Array.isArray(exported)) return exported.filter(isTool);
  if (exported && typeof exported === 'object') {
    const obj = exported as Record<string, unknown>;
    if (Array.isArray(obj.tools)) return obj.tools.filter(isTool);
    if (isTool(obj.tool)) return [obj.tool];
  }
  return [];
}

/** 将模块导出包装为 Plugin */
function toPlugin(name: string, exported: unknown): Plugin | null {
  if (exported && typeof (exported as Plugin).install === 'function') {
    return exported as Plugin;
  }
  const tools = extractTools(exported);
  if (tools.length === 0) return null;
  return {
    name,
    version: '0.1.0',
    description: `User tool(s) discovered from the tools directory`,
    install(host: PluginHost) {
      for (const tool of tools) {
        host.registerTool(tool);
      }
    },
  };
}

/**
 * 目录扫描 Provider —— 从用户工具目录运行时加载工具
 */
export class DirScanner implements PluginProvider {
  private readonly dirs: string[];

  constructor(dirs: string[] = defaultDirs()) {
    this.dirs = dirs;
  }

  getAvailablePlugins(): string[] {
    return this.scan().map((f) => f.name);
  }

  getProviders(): string[] {
    return [];
  }

  async loadPlugin(name: string): Promise<Plugin | null> {
    const file = this.scan().find((f) => f.name === name);
    if (!file) return null;
    try {
      const mod = (await import(file.path)) as { default?: unknown };
      const plugin = toPlugin(name, mod.default);
      if (!plugin) {
        console.warn(
          `[DirScanner] Tool file "${file.name}" has no recognized export ` +
            `(Plugin or self-describing ToolDefinition). Skipping.`,
        );
        return null;
      }
      return plugin;
    } catch (e) {
      console.warn(
        `[DirScanner] Failed to load user tool "${name}": ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  /** 扫描目录，返回 { 文件名, 绝对路径 } */
  private scan(): Array<{ name: string; path: string }> {
    const results: Array<{ name: string; path: string }> = [];
    for (const dir of this.dirs) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue; // 目录不存在，跳过
      }
      for (const entry of entries) {
        const ext = path.extname(entry);
        if (!SUPPORTED_EXT.has(ext)) continue;
        const base = path.basename(entry, ext);
        if (base.startsWith('_')) continue; // _ 前缀视为内部/局部文件，不注册
        results.push({ name: base, path: path.join(dir, entry) });
      }
    }
    return results;
  }
}
