/**
 * @vessel/memory-project - 项目记忆插件
 * @module @vessel/memory-project
 *
 * 读取项目级配置文件（CLAUDE.md、.vessel/memory/ 目录），
 * 通过 BeforeLlm Hook 注入到上下文。
 * Tier 1，无重依赖。
 */

import type { Plugin, PluginHost, Hook, HookContext } from '@vessel/core';
import { HookType } from '@vessel/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 类型 ──────────────────────────────────────────

/** 单条记忆的 frontmatter 元数据 */
interface MemoryMeta {
  name: string;
  description: string;
  metadata?: {
    type?: 'user' | 'feedback' | 'project' | 'reference';
  };
}

/** 单条记忆 */
interface MemoryEntry {
  meta: MemoryMeta;
  content: string;
  filePath: string;
}

/** 插件配置 */
export interface MemoryProjectConfig {
  /** 项目根目录（默认 cwd） */
  projectRoot?: string;
  /** CLAUDE.md 文件路径（相对于 projectRoot） */
  claudeMdPath?: string;
  /** 记忆目录路径（相对于 projectRoot） */
  memoryDir?: string;
  /** 是否自动注入到 system prompt 前缀 */
  injectToSystem?: boolean;
}

// ── 默认配置 ──────────────────────────────────────

const DEFAULT_CONFIG: Required<MemoryProjectConfig> = {
  projectRoot: process.cwd(),
  claudeMdPath: 'CLAUDE.md',
  memoryDir: '.vessel/memory',
  injectToSystem: true,
};

// ── 解析器 ────────────────────────────────────────

/**
 * 解析 YAML 风格的 frontmatter
 * 支持 --- 分隔符，返回解析后的元数据和内容体
 */
function parseFrontmatter(raw: string, filePath: string): MemoryEntry | null {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    // 无 frontmatter，整个文件作为内容
    return {
      meta: {
        name: path.basename(filePath, '.md'),
        description: lines.find(l => l.startsWith('# '))?.replace(/^# /, '') ?? '',
      },
      content: raw,
      filePath,
    };
  }

  const endIndex = lines.slice(1).findIndex(l => l.trim() === '---');
  if (endIndex === -1) {
    return null; // 格式错误
  }

  const frontmatterLines = lines.slice(1, endIndex + 1);
  const body = lines.slice(endIndex + 2).join('\n').trim();

  const meta: MemoryMeta = { name: '', description: '' };

  for (const line of frontmatterLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 简单 YAML key: value 解析
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (key === 'name') {
      meta.name = value;
    } else if (key === 'description') {
      meta.description = value;
    }
    // metadata 嵌套对象按需，简单场景跳过多层解析
  }

  return {
    meta: {
      name: meta.name || path.basename(filePath, '.md'),
      description: meta.description || body.slice(0, 80),
    },
    content: body,
    filePath,
  };
}

// ── 记忆管理器 ────────────────────────────────────

class ProjectMemoryManager {
  private config: Required<MemoryProjectConfig>;
  private claudeMdContent = '';
  private memoryIndex: string[] = [];
  private memories: Map<string, MemoryEntry> = new Map();

  constructor(config: MemoryProjectConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 加载所有项目记忆
   */
  loadAll(): void {
    this.loadClaudeMd();
    this.loadMemoryDir();
  }

  /**
   * 加载 CLAUDE.md
   */
  private loadClaudeMd(): void {
    const claudePath = path.resolve(
      this.config.projectRoot,
      this.config.claudeMdPath
    );

    try {
      if (fs.existsSync(claudePath)) {
        this.claudeMdContent = fs.readFileSync(claudePath, 'utf-8');
      }
    } catch {
      // CLAUDE.md 不存在，静默跳过
    }
  }

  /**
   * 加载 .vessel/memory/ 目录
   */
  private loadMemoryDir(): void {
    const memoryDir = path.resolve(
      this.config.projectRoot,
      this.config.memoryDir
    );

    if (!fs.existsSync(memoryDir)) {
      return;
    }

    // 1. 读取 MEMORY.md 索引
    const indexPath = path.join(memoryDir, 'MEMORY.md');
    if (fs.existsSync(indexPath)) {
      try {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        this.memoryIndex = indexContent
          .split('\n')
          .filter(l => l.trim().startsWith('- '))
          .map(l => l.replace(/^-\s*/, '').trim());
      } catch {
        // ignore
      }
    }

    // 2. 读取所有 .md 记忆文件（跳过 MEMORY.md）
    try {
      const files = fs
        .readdirSync(memoryDir)
        .filter(
          f => f.endsWith('.md') && f !== 'MEMORY.md'
        );

      for (const file of files) {
        const filePath = path.join(memoryDir, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const entry = parseFrontmatter(raw, filePath);
          if (entry) {
            this.memories.set(entry.meta.name, entry);
          }
        } catch {
          // 单个文件读取失败，跳过
        }
      }
    } catch {
      // 目录读取失败
    }
  }

  /**
   * 获取所有记忆的名称列表
   */
  listNames(): string[] {
    return Array.from(this.memories.keys());
  }

  /**
   * 获取单条记忆
   */
  get(name: string): MemoryEntry | undefined {
    return this.memories.get(name);
  }

  /**
   * 构建注入上下文的记忆文本
   */
  buildContextInjection(): string | null {
    const parts: string[] = [];

    // CLAUDE.md 内容（如果存在）
    if (this.claudeMdContent.trim()) {
      parts.push(
        `<!-- 项目说明 (CLAUDE.md) -->\n${this.claudeMdContent}`
      );
    }

    // 记忆索引
    if (this.memoryIndex.length > 0) {
      parts.push(
        `<!-- 记忆索引 -->\n${this.memoryIndex.join('\n')}`
      );
    }

    // 各条记忆内容
    for (const [name, entry] of this.memories) {
      const typeTag = entry.meta.metadata?.type
        ? ` [${entry.meta.metadata.type}]`
        : '';
      parts.push(
        `<!-- 记忆: ${name}${typeTag} -->\n` +
        `**${entry.meta.description}**\n\n${entry.content}`
      );
    }

    if (parts.length === 0) {
      return null;
    }

    return parts.join('\n\n---\n\n');
  }
}

// ── Hook 工厂 ────────────────────────────────────

function createMemoryInjectionHook(
  manager: ProjectMemoryManager
): Hook {
  return {
    name: 'memory-project-injection',
    type: HookType.BeforeLlm,
    priority: 50, // 比 skills-loader(100) 更早，确保记忆在 Skill 之前
    run: async (ctx: HookContext): Promise<HookContext | null> => {
      const injection = manager.buildContextInjection();
      if (injection) {
        // 注入到系统提示词前缀
        const extended = ctx as HookContext & { system_prompt?: string };
        const existingSystem = extended.system_prompt ?? '';
        extended.system_prompt = `${injection}\n\n${existingSystem}`;
      }
      return ctx;
    },
  };
}

// ── 插件导出 ──────────────────────────────────────

export const memoryProjectPlugin: Plugin = {
  name: 'memory-project',
  version: '0.1.0',
  description:
    'Project memory plugin — reads CLAUDE.md and .vessel/memory/ into agent context',
  install(host: PluginHost, config?: unknown) {
    const memoryConfig = (config as MemoryProjectConfig) ?? {};
    const manager = new ProjectMemoryManager(memoryConfig);
    manager.loadAll();

    // 注册工具：列出记忆
    host.registerTool({
      name: 'list_memories',
      description:
        '列出所有项目记忆。当用户询问"你记得什么"、"有哪些记忆"时调用此工具。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const names = manager.listNames();
        if (names.length === 0) {
          return '没有项目记忆。';
        }
        return `项目记忆 (${names.length} 条):\n${names.map(n => `- ${n}`).join('\n')}`;
      },
    });

    // 注册工具：查看记忆
    host.registerTool({
      name: 'get_memory',
      description: '获取指定项目记忆的完整内容',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '记忆名称',
          },
        },
        required: ['name'],
      },
      handler: async (args) => {
        const { name } = args as { name: string };
        const entry = manager.get(name);
        if (!entry) {
          return `未找到记忆 "${name}"。`;
        }
        return `## ${entry.meta.description}\n\n${entry.content}`;
      },
    });

    // 注册 BeforeLlm Hook
    host.registerHook(createMemoryInjectionHook(manager));
  },
};

export default memoryProjectPlugin;
