/**
 * ConfigDeclared —— vessel.yaml 声明式工具 Provider（ADR-028）
 *
 * 读 `vessel.yaml` 的 `tools` 声明（命令/url），启动即连接注册。
 * 用户在配置里声明一个工具，无需改源码、无需构建。
 *
 * 声明形态（VesselConfig.tools 中带 command/url 的条目）：
 * ```yaml
 * tools:
 *   - name: my-weather
 *     description: 查询天气
 *     command: "curl -s https://api.weather.com/?city={{city}}"
 *     input_schema:
 *       type: object
 *       properties:
 *         city: { type: string }
 *   - name: my-api
 *     url: "https://api.example.com/{{endpoint}}"
 *     method: GET
 * ```
 *
 * 不带 command/url 的条目（如内置工具的 enabled 开关）不属于声明式连接，被忽略。
 * 工具 handler 用安全模板构建（占位符替换 + fetch/spawn），不使用 eval（与 meta-tools 一致）。
 */

import type { ToolConfig, VesselConfig } from '../packages/config/src/index';
import type { Plugin, PluginHost, ToolDefinition } from '../packages/core/src/index';
import type { PluginProvider } from './plugin-registry';

/** 替换模板中的 {{ key }} 占位符 */
function substituteArgs(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    return args[key] ?? `{{${key}}}`;
  });
}

/** 从声明构建自描述工具对象 */
function buildDeclaredTool(tool: ToolConfig): ToolDefinition {
  const kind = tool.type ?? (tool.url ? 'http' : 'shell');
  const inputSchema = tool.inputSchema ?? { type: 'object', properties: {} };

  if (kind === 'http' && tool.url) {
    return {
      name: tool.name,
      description: tool.description ?? `HTTP tool "${tool.name}" declared in vessel.yaml`,
      inputSchema,
      handler: async (args: unknown) => {
        const url = substituteArgs(tool.url as string, args as Record<string, string>);
        try {
          const res = await fetch(url, {
            method: tool.method ?? 'GET',
            headers: tool.headers ?? {},
          });
          return await res.text();
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : e}`;
        }
      },
    };
  }

  return {
    name: tool.name,
    description: tool.description ?? `Shell tool "${tool.name}" declared in vessel.yaml`,
    inputSchema,
    handler: async (args: unknown) => {
      const cmd = substituteArgs(tool.command ?? '', args as Record<string, string>);
      try {
        const proc = Bun.spawnSync({
          cmd: ['sh', '-c', cmd],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        return proc.stdout.toString().trim() || proc.stderr.toString().trim() || 'ok';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : e}`;
      }
    },
  };
}

/**
 * 配置声明 Provider —— 从 vessel.yaml 的 tools 声明连接并注册
 */
export class ConfigDeclared implements PluginProvider {
  private readonly declared: ToolConfig[];

  constructor(config: VesselConfig) {
    this.declared = (config.tools ?? []).filter((t) => t.command || t.url);
  }

  getAvailablePlugins(): string[] {
    return this.declared.map((t) => t.name);
  }

  getProviders(): string[] {
    return [];
  }

  async loadPlugin(name: string): Promise<Plugin | null> {
    const tool = this.declared.find((t) => t.name === name);
    if (!tool) return null;
    return {
      name,
      version: '0.1.0',
      description: `Declared tool from vessel.yaml`,
      install(host: PluginHost) {
        host.registerTool(buildDeclaredTool(tool));
      },
    };
  }
}
