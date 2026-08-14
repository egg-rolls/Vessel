/**
 * @vessel/meta-tools - 元工具插件
 * @module @vessel/meta-tools
 *
 * 提供元工具，让 Agent 自我管理工具模板（asset-decentralization 线A 瘦身后）：
 * - add_tool: 注册工具模板（shell/http），直接 registerTool + 持久化
 * - remove_tool: 从持久化文件移除工具模板（当前会话无法真撤，重启后生效）
 *
 * 工具真相源 = PluginHost；本插件不再持有 tools/skills/mcpConnections 台账副本。
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Plugin,
  PluginHost,
  ToolContext,
  ToolDefinition,
} from '../../../../packages/core/src/index';

/** 持久化工具模板（安全，不使用 eval/new Function） */
interface PersistedToolTemplate {
  name: string;
  description: string;
  type: 'shell' | 'http';
  command?: string; // shell 模板，用 {{key}} 占位
  url?: string; // http 模板，用 {{key}} 占位
  method?: string; // GET / POST
  headers?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
}

/** 默认持久化路径（保持历史 ./tools/custom-tools.json 不变，spec §5 向后兼容） */
const DEFAULT_TOOLS_FILE = './tools/custom-tools.json';

/** 替换模板中的 {{ key }} 占位符 */
function substituteArgs(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    return args[key] ?? `{{${key}}}`;
  });
}

/**
 * 从文件读取已保存的工具模板。
 * 向后兼容：旧格式（handlerCode）静默跳过，不再支持 eval/new Function。
 */
function readPersistedTemplates(toolsFilePath: string): PersistedToolTemplate[] {
  try {
    if (!fs.existsSync(toolsFilePath)) {
      return [];
    }
    const data = fs.readFileSync(toolsFilePath, 'utf-8');
    const raw = JSON.parse(data) as Array<Record<string, unknown>>;

    const templates: PersistedToolTemplate[] = [];
    for (const item of raw) {
      // 向后兼容：旧格式（handlerCode）静默跳过
      if (!item.type || (item.type !== 'shell' && item.type !== 'http')) {
        continue;
      }
      templates.push(item as unknown as PersistedToolTemplate);
    }
    return templates;
  } catch (error) {
    console.error('Failed to read persisted tools:', error);
    return [];
  }
}

/** 将工具模板写入持久化文件 */
function writePersistedTemplates(toolsFilePath: string, templates: PersistedToolTemplate[]): void {
  try {
    const dir = path.dirname(toolsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(toolsFilePath, JSON.stringify(templates, null, 2));
  } catch (error) {
    console.error('Failed to persist tools:', error);
  }
}

/**
 * 从模板构建工具 handler（安全，无 eval）
 */
function buildToolFromTemplate(tpl: PersistedToolTemplate): ToolDefinition {
  switch (tpl.type) {
    case 'shell':
      return {
        name: tpl.name,
        description: tpl.description,
        inputSchema: tpl.inputSchema ?? {
          type: 'object',
          properties: {},
        },
        handler: async (args: unknown) => {
          const cmd = substituteArgs(tpl.command ?? '', args as Record<string, string>);
          try {
            const proc = Bun.spawnSync({
              cmd: ['sh', '-c', cmd],
              stdout: 'pipe',
              stderr: 'pipe',
            });
            return proc.stdout.toString() || proc.stderr.toString() || 'ok';
          } catch (e) {
            return `Error: ${e}`;
          }
        },
      };

    case 'http':
      return {
        name: tpl.name,
        description: tpl.description,
        inputSchema: tpl.inputSchema ?? {
          type: 'object',
          properties: {},
        },
        handler: async (args: unknown) => {
          const url = substituteArgs(tpl.url ?? '', args as Record<string, string>);
          try {
            const res = await fetch(url, {
              method: tpl.method ?? 'GET',
              headers: tpl.headers ?? {},
            });
            return await res.text();
          } catch (e) {
            return `Error: ${e}`;
          }
        },
      };

    default:
      throw new Error(`Unknown template type: ${tpl.type}. Supported: shell, http`);
  }
}

/**
 * 用事件流等待用户授权（ADR-029）。
 * 发 `tool.permission.request` 事件 → `waitFor('tool.permission.response', { requestId })`。
 * 无订阅者/超时时兜底返回 'ask'，交由运行时决定。
 */
async function requestPermission(
  ctx: ToolContext,
  tool: string,
  input: unknown,
  timeout = 30000,
): Promise<'allow' | 'deny' | 'ask'> {
  const requestId = randomUUID();
  ctx.events.publish({
    type: 'tool.permission.request',
    run_id: ctx.run_id,
    data: { requestId, tool, input },
    ts: Date.now(),
  });
  try {
    const data = (await ctx.events.waitFor('tool.permission.response', {
      requestId,
      timeout,
    })) as { decision?: 'allow' | 'deny' | 'ask'; allowed?: boolean };
    return data.decision ?? (data.allowed === false ? 'deny' : 'allow');
  } catch {
    return 'ask';
  }
}

/**
 * 创建元工具
 */
export function createMetaTools(
  pluginHost: PluginHost,
  toolsFilePath = DEFAULT_TOOLS_FILE,
): ToolDefinition[] {
  const addToolTool: ToolDefinition = {
    name: 'add_tool',
    description:
      'Add a new tool using a safe template (shell command or HTTP request). ' +
      'Use {{ key }} placeholders for parameters.',
    // 自描述：add_tool 会注册可执行 shell/http 的新工具，属于危险操作，需用户授权
    interactive: true,
    checkPermission: async (input, ctx) => requestPermission(ctx, 'add_tool', input),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name' },
        description: { type: 'string', description: 'Tool description' },
        type: {
          type: 'string',
          enum: ['shell', 'http'],
          description: 'Template type: "shell" or "http"',
        },
        command: {
          type: 'string',
          description: 'Shell template, e.g. "curl -s https://api.example.com/{{query}}"',
        },
        url: {
          type: 'string',
          description: 'HTTP URL template, e.g. "https://api.example.com/{{endpoint}}"',
        },
        method: {
          type: 'string',
          description: 'HTTP method (default: GET)',
        },
        inputSchema: {
          type: 'object',
          description: 'JSON Schema for tool parameters',
        },
      },
      required: ['name', 'description', 'type'],
    },
    handler: async (args) => {
      const a = args as {
        name: string;
        description: string;
        type: 'shell' | 'http';
        command?: string;
        url?: string;
        method?: string;
        inputSchema?: Record<string, unknown>;
      };

      // 异常 2（缺参）：shell 缺 command、http 缺 url
      if (a.type === 'shell' && !a.command) {
        return '参数缺失：type=shell 需要 command';
      }
      if (a.type === 'http' && !a.url) {
        return '参数缺失：type=http 需要 url';
      }

      // 异常 1（重名）：PluginHost 是工具唯一真相源
      if (pluginHost.getTool(a.name)) {
        return '工具名已存在';
      }

      const tpl: PersistedToolTemplate = {
        name: a.name,
        description: a.description,
        type: a.type,
        command: a.command,
        url: a.url,
        method: a.method,
        inputSchema: a.inputSchema,
      };

      try {
        const tool = buildToolFromTemplate(tpl);
        pluginHost.registerTool(tool);

        const templates = readPersistedTemplates(toolsFilePath);
        templates.push(tpl);
        writePersistedTemplates(toolsFilePath, templates);

        return `工具「${a.name}」已注册`;
      } catch (error) {
        return `Failed to add tool: ${error}`;
      }
    },
  };

  const removeToolTool: ToolDefinition = {
    name: 'remove_tool',
    description: 'Remove a custom tool template (takes effect after restart)',
    // 自描述：remove_tool 删除工具模板不可恢复，属破坏性操作，需用户授权
    interactive: true,
    checkPermission: async (input, ctx) => requestPermission(ctx, 'remove_tool', input),
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool name',
        },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const { name } = args as { name: string };

      const templates = readPersistedTemplates(toolsFilePath);
      const index = templates.findIndex((t) => t.name === name);
      if (index !== -1) {
        templates.splice(index, 1);
        writePersistedTemplates(toolsFilePath, templates);
        return '已删除，重启后不再加载';
      }

      // 不在持久化列表：区分内置/插件工具（拒绝）与不存在
      if (pluginHost.getTool(name)) {
        return '无法删除内置工具';
      }
      return '工具不存在';
    },
  };

  return [addToolTool, removeToolTool];
}

/**
 * 元工具插件
 */
export const metaToolsPlugin: Plugin = {
  name: 'meta-tools',
  version: '0.1.0',
  description: 'Meta-tools for tool template management (add/remove custom tools)',
  install(host: PluginHost) {
    // 加载持久化工具模板到 PluginHost（工具真相源），本插件不持有本地副本
    for (const tpl of readPersistedTemplates(DEFAULT_TOOLS_FILE)) {
      try {
        host.registerTool(buildToolFromTemplate(tpl));
      } catch (error) {
        console.error(`Failed to load persisted tool "${tpl.name}":`, error);
      }
    }

    for (const tool of createMetaTools(host, DEFAULT_TOOLS_FILE)) {
      host.registerTool(tool);
    }
  },
};

export default metaToolsPlugin;
