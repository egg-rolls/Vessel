/**
 * @vessel/skills-loader - Skills 加载器插件
 * @module @vessel/skills-loader
 *
 * 加载 Skill 内容（Markdown 文件），通过 BeforeLlm Hook 注入到上下文。
 * Skill 是行为 know-how 的可复用剧本，不是代码。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Hook, HookContext, Plugin, PluginHost } from '@vessel/core';
import { HookType as HookTypeEnum } from '@vessel/core';

/** 调试输出门控（VESSEL_DEBUG 开启才打印，避免每次启动刷屏 stderr） */
const debug = (...args: unknown[]): void => {
  if (process.env.VESSEL_DEBUG) console.error(...args);
};

/**
 * 校验 skill 名是安全文件名，防止路径穿越：
 * - 非空字符串、非 `.`/`..`
 * - 不含路径分隔符 `/`、`\`
 * - `path.basename(name) === name`（name 不能解析出父级目录）
 */
function isSafeSkillName(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return path.basename(name) === name;
}

/**
 * 解析 SKILL.md 开头的 YAML frontmatter（`---\n...\n---` 包裹）。
 * 用简单字符串解析，不引入 yaml 依赖。非法行/非法 frontmatter 跳过，不中断加载。
 */
function parseFrontmatter(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = content.split('\n');

  const firstLine = lines[0];
  // 首行必须是 `---`，否则视为无 frontmatter
  if (firstLine === undefined || firstLine.trim() !== '---') return fields;

  // 找闭合的 `---`
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) return fields;

  for (let i = 1; i < endIndex; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (key === undefined) continue;
    const value = (rawValue ?? '').trim().replace(/^['"]|['"]$/g, '');
    fields[key] = value;
  }

  return fields;
}

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

    // 回退描述：第一个 `# ` 标题
    const lines = content.split('\n');
    const titleLine = lines.find((l) => l.startsWith('# '));
    const titleDescription = titleLine ? titleLine.substring(2).trim() : `Skill: ${name}`;

    // frontmatter 优先；无 frontmatter 或字段缺失时回退到标题
    const fields = parseFrontmatter(content);
    const description =
      fields.description && fields.description.trim() !== ''
        ? fields.description
        : titleDescription;

    const metadata: Record<string, unknown> = {};
    if (fields.when_to_use && fields.when_to_use.trim() !== '') {
      metadata.when_to_use = fields.when_to_use;
    }

    const skill: Skill = {
      name,
      description,
      content,
      source: 'file',
      filePath,
    };
    if (Object.keys(metadata).length > 0) {
      skill.metadata = metadata;
    }

    this.skills.set(name, skill);
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
          if (!filename?.endsWith('.md')) return;

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
   * 添加 Skill：写入文件并加载进内存。
   * 默认写入 skillsDir 下的 `<name>.md`；重名时抛「Skill 已存在」。
   */
  addSkill(name: string, content: string, filePath?: string): Skill | undefined {
    if (!isSafeSkillName(name)) {
      throw new Error('非法 skill 名');
    }

    if (this.skills.has(name)) {
      throw new Error('Skill 已存在');
    }

    const skillsDir = path.resolve(this.config.skillsDir ?? './skills');

    let targetPath: string;
    if (filePath !== undefined && filePath !== '') {
      // 自定义 filePath 必须解析后落在 skillsDir 内，否则拒绝（路径穿越防护）
      const resolvedFile = path.resolve(filePath);
      if (!resolvedFile.startsWith(skillsDir + path.sep)) {
        throw new Error('非法 skill 文件路径');
      }
      targetPath = resolvedFile;
    } else {
      targetPath = path.join(skillsDir, `${name}.md`);
    }

    // 写入前检查磁盘目标是否已存在，避免静默覆盖已有文件
    if (fs.existsSync(targetPath)) {
      throw new Error('Skill 文件已存在');
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');

    this.loadSkillFile(targetPath);

    // 若自定义 filePath 的 basename 与 name 不一致，仍以 name 为键
    const loadedName = path.basename(targetPath, '.md');
    if (loadedName !== name) {
      const loaded = this.skills.get(loadedName);
      this.skills.delete(loadedName);
      if (loaded) {
        this.skills.set(name, { ...loaded, name });
      }
    }

    return this.skills.get(name);
  }

  /**
   * 移除 Skill：删除文件与内存记录。
   * 不存在时抛「Skill 不存在」。
   */
  removeSkill(name: string): void {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error('Skill 不存在');
    }

    if (skill.filePath && fs.existsSync(skill.filePath)) {
      // 防御性校验：文件必须落在 skillsDir 内，防止越界删除
      const skillsDir = path.resolve(this.config.skillsDir ?? './skills');
      const resolvedFile = path.resolve(skill.filePath);
      if (!resolvedFile.startsWith(skillsDir + path.sep)) {
        throw new Error('非法 skill 文件路径');
      }
      fs.unlinkSync(skill.filePath);
    }
    this.skills.delete(name);
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
 * ADR-018 约定：BeforeLlm hook 通过写入 `ctx.system_prompt` 注入内容，
 * loop 在 BeforeLlm 之后把 `ctx.system_prompt` 作为本次 LLM 请求的 system 消息。
 * core 的 `HookContext` 未声明该字段（ADR-017 Core 冻结，不扩展其类型），
 * 插件以本地类型显式约定该注入契约。
 */
interface BeforeLlmCtx extends HookContext {
  system_prompt?: string;
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
        const extended = ctx as BeforeLlmCtx;
        const existingSystem = extended.system_prompt ?? '';
        // 将 Skill 内容注入到 system prompt 前缀
        extended.system_prompt = `<!-- 自动加载的 Skills -->\n${skillContent}\n\n${existingSystem}`;
      }

      return ctx;
    },
  };
}

/**
 * 创建 Skills Loader 插件
 */
export function createSkillsLoaderPlugin(config?: SkillsLoaderConfig): Plugin {
  return {
    name: 'skills-loader',
    version: '0.1.0',
    description: 'Load and inject skills (Markdown documents) into agent context',
    install(host: PluginHost) {
      const loaderConfig = config ?? {};
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
          debug('[Skills Loader] list_skills called, returning:', summary);
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

      host.registerTool({
        name: 'add_skill',
        description: '添加一个新技能。将 Markdown 内容写入技能文件并加载进技能管理器。',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Skill 名称（将作为文件名 `<name>.md`）',
            },
            content: {
              type: 'string',
              description: 'Skill 内容（Markdown，可选 frontmatter）',
            },
            filePath: {
              type: 'string',
              description: '可选，自定义文件路径；缺省写入 skillsDir 下的 `<name>.md`',
            },
          },
          required: ['name', 'content'],
        },
        handler: async (args) => {
          const { name, content, filePath } = args as {
            name: string;
            content: string;
            filePath?: string;
          };
          try {
            skillsManager.addSkill(name, content, filePath);
            return '已添加';
          } catch (err) {
            return (err as Error).message;
          }
        },
      });

      host.registerTool({
        name: 'remove_skill',
        description: '移除一个技能（删除文件与内存记录）。',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '要移除的 Skill 名称',
            },
          },
          required: ['name'],
        },
        handler: async (args) => {
          const { name } = args as { name: string };
          try {
            skillsManager.removeSkill(name);
            return '已移除';
          } catch (err) {
            return (err as Error).message;
          }
        },
      });

      // 注册 BeforeLlm Hook（实际注入 Skill 内容到 system prompt）
      host.registerHook(createSkillInjectionHook(skillsManager));

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
        debug('[Skills Loader] File watching enabled');
      }
    },
  };
}

/** 默认实例——现有调用方无需改动 */
export const skillsLoaderPlugin = createSkillsLoaderPlugin();

export default skillsLoaderPlugin;
