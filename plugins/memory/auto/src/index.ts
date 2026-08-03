/**
 * @vessel/memory-auto - 跨会话自动记忆插件
 * @module @vessel/memory-auto
 *
 * 自动从对话中提取关键决策/用户偏好，持久化到项目记忆目录。
 * 下次会话由 memory-project 插件加载注入。
 * Tier 1。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Hook, HookContext, Plugin, PluginHost } from '@vessel/core';
import { HookType } from '@vessel/core';

// ── 类型 ──────────────────────────────────────────

/** 自动记忆条目 */
interface AutoMemory {
  /** 记忆名称（kebab-case slug） */
  name: string;
  /** 记忆描述（一行摘要） */
  description: string;
  /** 记忆分类 */
  type: 'user' | 'feedback' | 'project' | 'reference';
  /** 记忆内容 */
  content: string;
  /** 创建时间戳 */
  createdAt: string;
  /** 来源 run_id */
  runId: string;
}

/** 插件配置 */
export interface MemoryAutoConfig {
  /** 记忆输出目录（默认 .vessel/memory/） */
  memoryDir?: string;
  /** 是否启用自动提取 */
  autoExtract?: boolean;
  /** 单次会话最大自动记忆数 */
  maxPerSession?: number;
}

// ── 默认配置 ──────────────────────────────────────

const DEFAULT_CONFIG: Required<MemoryAutoConfig> = {
  memoryDir: '.vessel/memory',
  autoExtract: true,
  maxPerSession: 5,
};

// ── 提取启发式 ───────────────────────────────────

/**
 * 从对话文本中提取显式记忆标记。
 *
 * 识别模式（大小写不敏感）：
 * - "remember <key>: <value>"
 * - "记住 <key>: <value>"
 * - "别忘了 <key>: <value>"
 * - "/remember <key> <value>"
 */
function extractExplicitMemories(text: string, runId: string): AutoMemory[] {
  const results: AutoMemory[] = [];

  // 模式 1: "remember X: Y" / "记住 X: Y" / "别忘了 X: Y"
  const explicitPattern = /(?:remember|记住|别忘了)\s+(.+?)\s*[:：]\s*(.+?)(?:\n|$)/gi;

  let match: RegExpExecArray | null = explicitPattern.exec(text);
  while (match !== null) {
    const key = match[1]?.trim() ?? '';
    const value = match[2]?.trim() ?? '';
    if (key && value) {
      results.push({
        name: slugify(key),
        description: key,
        type: 'user',
        content: value,
        createdAt: new Date().toISOString(),
        runId,
      });
    }
    match = explicitPattern.exec(text);
  }

  // 模式 2: "/remember <key> <value>"（slash 命令风格）
  const slashPattern = /\/remember\s+(.+?)\s+(.+?)(?:\n|$)/gi;
  match = slashPattern.exec(text);
  while (match !== null) {
    const key = match[1]?.trim() ?? '';
    const value = match[2]?.trim() ?? '';
    if (key && value) {
      results.push({
        name: slugify(key),
        description: key,
        type: 'user',
        content: value,
        createdAt: new Date().toISOString(),
        runId,
      });
    }
    match = slashPattern.exec(text);
  }

  return results;
}

/**
 * 从对话中提取用户偏好模式。
 *
 * 识别模式：
 * - "I prefer X" / "我更喜欢 X" / "我喜欢用 X"
 * - "always use X" / "始终用 X"
 * - "never use X" / "不要用 X"
 */
function extractPreferences(text: string, runId: string): AutoMemory[] {
  const results: AutoMemory[] = [];
  const prefPatterns = [
    {
      regex: /(?:我(?:更)?喜欢|I prefer|我更习惯)\s+(.+?)(?:[，。,.\n]|$)/gi,
      negate: false,
    },
    {
      regex: /(?:始终用|always use|一直用)\s+(.+?)(?:[，。,.\n]|$)/gi,
      negate: false,
    },
    {
      regex: /(?:不要用|never use|别用)\s+(.+?)(?:[，。,.\n]|$)/gi,
      negate: true,
    },
  ];

  for (const { regex, negate } of prefPatterns) {
    let match: RegExpExecArray | null = regex.exec(text);
    while (match !== null) {
      const pref = match[1]?.trim() ?? '';
      if (pref.length >= 3 && pref.length <= 200) {
        const prefix = negate ? '避免使用: ' : '偏好: ';
        results.push({
          name: slugify(`pref-${pref}`),
          description: `用户偏好${negate ? '（避免）' : ''}: ${pref}`,
          type: 'user',
          content: `${prefix}${pref}`,
          createdAt: new Date().toISOString(),
          runId,
        });
      }
      match = regex.exec(text);
    }
  }

  return results;
}

/** 转为 kebab-case slug */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

// ── 持久化 ───────────────────────────────────────

/**
 * 将记忆写入 .vessel/memory/ 目录
 */
function persistMemory(memory: AutoMemory, memoryDir: string): void {
  const dir = path.resolve(memoryDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, `${memory.name}.md`);

  // 如果文件已存在，追加而不是覆盖
  let existingContent = '';
  if (fs.existsSync(filePath)) {
    existingContent = fs.readFileSync(filePath, 'utf-8');
    // 简单去重：相同内容不重复
    if (existingContent.includes(memory.content)) {
      return;
    }
  }

  const frontmatter = [
    '---',
    `name: ${memory.name}`,
    `description: ${memory.description}`,
    'metadata:',
    `  type: ${memory.type}`,
    '  auto: true',
    `  createdAt: ${memory.createdAt}`,
    `  runId: ${memory.runId}`,
    '---',
  ].join('\n');

  const content = existingContent
    ? `${existingContent}\n\n---\n\n**更新于 ${new Date().toISOString()}**\n\n${memory.content}`
    : `${frontmatter}\n\n${memory.content}`;

  fs.writeFileSync(filePath, content, 'utf-8');

  // 更新 MEMORY.md 索引
  updateMemoryIndex(memory, memoryDir);
}

/**
 * 更新 MEMORY.md 索引文件
 */
function updateMemoryIndex(memory: AutoMemory, memoryDir: string): void {
  const indexPath = path.join(path.resolve(memoryDir), 'MEMORY.md');
  let indexContent = '';

  if (fs.existsSync(indexPath)) {
    indexContent = fs.readFileSync(indexPath, 'utf-8');
  }

  const entryLine = `- [${memory.description}](${memory.name}.md) — ${memory.type}`;
  if (!indexContent.includes(entryLine)) {
    indexContent = `${indexContent.trimEnd()}\n${entryLine}\n`;
    fs.writeFileSync(indexPath, indexContent, 'utf-8');
  }
}

// ── Hook 工厂 ────────────────────────────────────

function createMemoryExtractionHook(
  config: Required<MemoryAutoConfig>,
  sessionCount: { value: number },
): Hook {
  return {
    name: 'memory-auto-extraction',
    type: HookType.AfterLlm,
    priority: 200, // 靠后执行，不干扰其他 Hook
    run: async (ctx: HookContext): Promise<HookContext | null> => {
      if (!config.autoExtract) return ctx;
      if (sessionCount.value >= config.maxPerSession) return ctx;

      // 从 LLM 响应和对话上下文中提取文本
      const responseText = (ctx as HookContext & { response?: string }).response;
      const fullText = (ctx as HookContext & { messages?: string }).messages;

      const textToAnalyze =
        typeof responseText === 'string'
          ? responseText
          : typeof fullText === 'string'
            ? fullText
            : '';

      if (!textToAnalyze) return ctx;

      // 提取显式记忆和偏好
      const explicitMemories = extractExplicitMemories(textToAnalyze, ctx.run_id);
      const preferences = extractPreferences(textToAnalyze, ctx.run_id);

      const allMemories = [...explicitMemories, ...preferences];

      for (const memory of allMemories) {
        if (sessionCount.value >= config.maxPerSession) break;
        persistMemory(memory, config.memoryDir);
        sessionCount.value++;
      }

      return ctx;
    },
  };
}

// ── 插件导出 ──────────────────────────────────────

/**
 * 创建 Memory Auto 插件
 */
export function createMemoryAutoPlugin(config?: MemoryAutoConfig): Plugin {
  return {
    name: 'memory-auto',
    version: '0.1.0',
    description:
      'Auto memory plugin — extracts decisions/preferences from conversations and persists across sessions',
    install(host: PluginHost) {
      const mergedConfig: Required<MemoryAutoConfig> = {
        ...DEFAULT_CONFIG,
        ...(config ?? {}),
      };

      const sessionCount = { value: 0 };

      // 注册工具：手动记录记忆
      host.registerTool({
        name: 'remember',
        description:
          '记录一条持久化记忆，供后续会话使用。用法: remember(key, value)。' +
          '例如: remember("用户喜欢用 TypeScript", "在后续回答中优先使用 TS")',
        inputSchema: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: '记忆的简短名称/标题',
            },
            value: {
              type: 'string',
              description: '记忆内容',
            },
          },
          required: ['key', 'value'],
        },
        handler: async (args) => {
          const { key, value } = args as {
            key: string;
            value: string;
          };
          const memory: AutoMemory = {
            name: slugify(key),
            description: key,
            type: 'user',
            content: value,
            createdAt: new Date().toISOString(),
            runId: 'manual',
          };
          persistMemory(memory, mergedConfig.memoryDir);
          return `已记录: "${key}"`;
        },
      });

      // 注册 AfterLlm Hook 用于自动提取
      host.registerHook(createMemoryExtractionHook(mergedConfig, sessionCount));
    },
  };
}

/** 默认实例——现有调用方无需改动 */
export const memoryAutoPlugin = createMemoryAutoPlugin();

export default memoryAutoPlugin;
