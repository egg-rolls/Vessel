/**
 * @vessel/skills-loader - Skills 加载器插件
 * @module @vessel/skills-loader
 *
 * 加载 Skill 内容（Markdown 文件），通过 BeforeLlm Hook 注入到上下文。
 * Skill 是行为 know-how 的可复用剧本，不是代码。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Hook, HookContext, Plugin, PluginHost } from '../../../../packages/core/src/index';
import { HookType as HookTypeEnum } from '../../../../packages/core/src/index';

/** Skill 定义 */
export interface Skill {
  name: string;
  description: string;
  content: string;
  source: 'file' | 'inline' | 'registry';
  filePath?: string;
  metadata?: Record<string, unknown>;
}

/** Skills Loader 配置 */
export interface SkillsLoaderConfig {
  /** Skill 文件目录 */
  skillsDir?: string;
  /** 自动加载的 Skill 列表 */
  autoLoad?: string[];
  /** 是否在 system prompt 中注入 Skill 内容 */
  injectToSystem?: boolean;
  /** 是否递归扫描子目录 */
  recursive?: boolean;
  /** 是否启用文件监听（热加载） */
  watch?: boolean;
}

/**
 * Skills 管理器
 */
export class SkillsManager {
  private skills: Map<string, Skill> = new Map();
  private config: SkillsLoaderConfig;

  constructor(config: SkillsLoaderConfig = {}) {
    this.config = {
      skillsDir: config.skillsDir ?? './skills',
      autoLoad: config.autoLoad ?? [],
      injectToSystem: config.injectToSystem ?? true,
      recursive: config.recursive ?? true,
      watch: config.watch ?? false,
    };
  }

  /** 获取配置 */
  getConfig(): SkillsLoaderConfig {
    return { ...this.config };
  }

  /** 获取 Skill 目录下的所有 .md 文件（支持递归） */
  findSkillFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && this.config.recursive) {
          results.push(...this.findSkillFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    } catch {
      // 读取失败，返回空
    }

    return results;
  }

  /** 加载单个 Skill 文件 */
  loadSkillFile(filePath: string): void {
    const name = path.basename(filePath, '.md');
    const content = fs.readFileSync(filePath, 'utf-8');

    const lines = content.split('\n');
    const titleLine = lines.find((l) => l.startsWith('# '));
    const description = titleLine ? titleLine.substring(2).trim() : `Skill: ${name}`;

    this.skills.set(name, {
      name,
      description,
      content,
      source: 'file',
      filePath,
    });
  }

  /** 移除已删除文件的 Skill */
  private cleanupStaleSkills(knownFiles: Set<string>): void {
    for (const [name, skill] of this.skills) {
      if (skill.source === 'file' && skill.filePath && !knownFiles.has(skill.filePath)) {
        this.skills.delete(name);
      }
    }
  }

  /**
   * 加载所有 Skill（支持递归扫描）
   */
  async loadSkills(): Promise<void> {
    const skillsDir = this.config.skillsDir ?? './skills';

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
      return;
    }

    const files = this.findSkillFiles(skillsDir);
    const knownFiles = new Set(files);

    for (const filePath of files) {
      try {
        this.loadSkillFile(filePath);
      } catch {
        // 单个文件加载失败，跳过
      }
    }

    // 清理已删除的 Skill
    this.cleanupStaleSkills(knownFiles);
  }

  /**
   * 启用文件监听（热加载）
   * 当 skills 目录中的文件变化时自动重新加载
   */
  watchSkills(): void {
    const skillsDir = path.resolve(this.config.skillsDir ?? './skills');

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    try {
      // 使用 fs.watch 监听目录变化
      const watcher = fs.watch(
        skillsDir,
        { recursive: this.config.recursive },
        (_eventType, filename) => {
          if (!filename || !filename.endsWith('.md')) return;

          const filePath = path.join(skillsDir, filename);

          // 短暂延迟，等待文件写入完成
          setTimeout(() => {
            try {
              if (fs.existsSync(filePath)) {
                this.loadSkillFile(filePath);
              } else {
                // 文件被删除
                const name = path.basename(filename, '.md');
                this.skills.delete(name);
              }
            } catch {
              // ignore
            }
          }, 200);
        },
      );

      // 存储 watcher 引用以便后续清理
      (this as Record<string, unknown>)._watcher = watcher;
    } catch {
      // 文件监听不可用，静默跳过
    }
  }

  /** 停止文件监听 */
  unwatchSkills(): void {
    const watcher = (this as Record<string, unknown>)._watcher as fs.FSWatcher | undefined;
    if (watcher) {
      watcher.close();
      (this as Record<string, unknown>)._watcher = undefined;
    }
  }

  /**
   * 注册 Skill
   */
  registerSkill(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  /**
   * 获取 Skill
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * 列出所有 Skill
   */
  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 搜索 Skill
   */
  searchSkills(query: string): Skill[] {
    const lowerQuery = query.toLowerCase();
    return this.listSkills().filter(
      (skill) =>
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery),
    );
  }

  /**
   * 获取自动加载的 Skill 内容
   */
  getAutoLoadedContent(): string {
    const autoLoad = this.config.autoLoad ?? [];
    const contents: string[] = [];

    for (const name of autoLoad) {
      const skill = this.skills.get(name);
      if (skill) {
        contents.push(`## Skill: ${skill.name}\n\n${skill.content}`);
      }
    }

    return contents.join('\n\n---\n\n');
  }

  /**
   * 获取所有 Skill 的摘要
   */
  getSkillsSummary(): string {
    const skills = this.listSkills();
    if (skills.length === 0) {
      return '没有技能';
    }

    return `技能列表：${skills.map((s) => s.name).join(', ')}`;
  }
}

/**
 * 创建 BeforeLlm Hook，将自动加载的 Skill 内容注入到 system prompt
 */
function createSkillInjectionHook(skillsManager: SkillsManager): Hook {
  return {
    name: 'skill-injection',
    type: HookTypeEnum.BeforeLlm,
    priority: 100,
    run: async (ctx: HookContext): Promise<HookContext | null> => {
      const skillContent = skillsManager.getAutoLoadedContent();

      if (skillContent) {
        const extended = ctx as HookContext & { system_prompt?: string };
        const existingSystem = extended.system_prompt ?? '';
        // 将 Skill 内容注入到 system prompt 前缀
        extended.system_prompt = `<!-- 自动加载的 Skills -->\n${skillContent}\n\n${existingSystem}`;
      }

      return ctx;
    },
  };
}

/**
 * Skills Loader 插件
 */
export const skillsLoaderPlugin: Plugin = {
  name: 'skills-loader',
  version: '0.1.0',
  description: 'Load and inject skills (Markdown documents) into agent context',
  install(host: PluginHost, config?: unknown) {
    const loaderConfig = (config as SkillsLoaderConfig) ?? {};
    const skillsManager = new SkillsManager(loaderConfig);

    // 注册 Skill 管理工具
    host.registerTool({
      name: 'list_skills',
      description:
        '列出所有可用技能。当用户询问"你有什么技能"、"你有哪些技能"、"你的技能列表"时调用此工具。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const summary = skillsManager.getSkillsSummary();
        console.error('[Skills Loader] list_skills called, returning:', summary);
        return summary;
      },
    });

    host.registerTool({
      name: 'search_skills',
      description: 'Search for skills by name or description',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
        },
        required: ['query'],
      },
      handler: async (args) => {
        const { query } = args as { query: string };
        const results = skillsManager.searchSkills(query);

        if (results.length === 0) {
          return `No skills found matching "${query}"`;
        }

        return results.map((s) => `**${s.name}**: ${s.description}`).join('\n');
      },
    });

    host.registerTool({
      name: 'get_skill',
      description: 'Get the content of a specific skill',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name',
          },
        },
        required: ['name'],
      },
      handler: async (args) => {
        const { name } = args as { name: string };
        const skill = skillsManager.getSkill(name);

        if (!skill) {
          return `Skill "${name}" not found`;
        }

        return skill.content;
      },
    });

    // 注册 BeforeLlm Hook（实际注入 Skill 内容到 system prompt）
    host.registerHook(createSkillInjectionHook(skillsManager));

    // 将 skillsManager 存储在 host 上，供其他组件使用
    (host as unknown as Record<string, unknown>).__skillsManager = skillsManager;

    // 递归加载 Skill 文件
    const skillsDir = path.resolve(loaderConfig.skillsDir ?? './skills');
    console.error(`[Skills Loader] Looking for skills in: ${skillsDir}`);

    if (fs.existsSync(skillsDir)) {
      const files = skillsManager.findSkillFiles(skillsDir);
      console.error(`[Skills Loader] Found ${files.length} skill files (recursive)`);

      for (const filePath of files) {
        try {
          skillsManager.loadSkillFile(filePath);
        } catch {
          // skip
        }
      }

      const loadedSkills = skillsManager.listSkills();
      console.error(`[Skills Loader] Total skills loaded: ${loadedSkills.length}`);
      console.error(`[Skills Loader] Skills: ${loadedSkills.map((s) => s.name).join(', ')}`);
    } else {
      console.error(`[Skills Loader] Skills directory not found: ${skillsDir}`);
    }

    // 启用文件监听（热加载）
    if (loaderConfig.watch) {
      skillsManager.watchSkills();
      console.error('[Skills Loader] File watching enabled');
    }
  },
};

export default skillsLoaderPlugin;
