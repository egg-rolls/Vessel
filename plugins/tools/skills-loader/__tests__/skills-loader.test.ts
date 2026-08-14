import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookType, MemoryEventStream, MemoryPluginHost } from '@vessel/core';
import { SkillsManager, createSkillsLoaderPlugin } from '../src/index';

/** 调用工具 handler 的便捷封装 */
function callTool(host: MemoryPluginHost, name: string, args: unknown): Promise<string> {
  const tool = host.getTool(name);
  expect(tool, `tool ${name} should exist`).toBeDefined();
  return tool!.handler(args, {
    run_id: 'r1',
    messages: [],
    events: new MemoryEventStream(),
  });
}

describe('skills-loader 插件（#115 去 monkey-patch + CRUD + frontmatter）', () => {
  let host: MemoryPluginHost;
  let tmpDir: string;

  beforeEach(() => {
    host = new MemoryPluginHost();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-skills-'));
    createSkillsLoaderPlugin({ skillsDir: tmpDir, watch: false }).install(host);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('install 注册 skill 工具 + BeforeLlm hook', () => {
    const toolNames = host.listTools().map((t) => t.name);
    for (const name of ['list_skills', 'search_skills', 'get_skill', 'add_skill', 'remove_skill']) {
      expect(toolNames).toContain(name);
    }
    expect(host.getHooks().some((h) => h.type === HookType.BeforeLlm)).toBe(true);
  });

  it('install 不再把 __skillsManager monkey-patch 到 host 上', () => {
    expect((host as unknown as Record<string, unknown>).__skillsManager).toBeUndefined();
  });

  it('list_skills 无 skill 时返回「没有技能」', async () => {
    const result = await callTool(host, 'list_skills', {});
    expect(result).toContain('没有技能');
  });

  it('add_skill 写入文件、加载进内存，list_skills 状态一致', async () => {
    const result = await callTool(host, 'add_skill', {
      name: 'greet',
      content: '# Greet\n\nSay hello nicely.',
    });
    expect(result).toBe('已添加');

    // 文件已落盘
    expect(fs.existsSync(path.join(tmpDir, 'greet.md'))).toBe(true);

    // list_skills 状态一致
    const list = await callTool(host, 'list_skills', {});
    expect(list).toContain('greet');

    // get_skill 返回内容
    const content = await callTool(host, 'get_skill', { name: 'greet' });
    expect(content).toContain('Say hello nicely.');
  });

  it('add_skill 重名返回「Skill 已存在」且不覆盖', async () => {
    await callTool(host, 'add_skill', { name: 'dup', content: '# One\nfirst' });
    const result = await callTool(host, 'add_skill', { name: 'dup', content: '# Two\nsecond' });
    expect(result).toBe('Skill 已存在');

    const content = await callTool(host, 'get_skill', { name: 'dup' });
    expect(content).toContain('first');
  });

  it('remove_skill 移除文件与内存，返回「已移除」', async () => {
    await callTool(host, 'add_skill', { name: 'temp', content: '# Temp\nbody' });
    const result = await callTool(host, 'remove_skill', { name: 'temp' });
    expect(result).toBe('已移除');
    expect(fs.existsSync(path.join(tmpDir, 'temp.md'))).toBe(false);

    const list = await callTool(host, 'list_skills', {});
    expect(list).not.toContain('temp');
  });

  it('remove_skill 不存在返回「Skill 不存在」', async () => {
    const result = await callTool(host, 'remove_skill', { name: 'nope' });
    expect(result).toBe('Skill 不存在');
  });

  it('add_skill name 含 ../ 或 / 返回非法且 skillsDir 外无文件被写', async () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-skills-parent-'));
    const skillsDir = path.join(parentDir, 'skills');
    const localHost = new MemoryPluginHost();
    createSkillsLoaderPlugin({ skillsDir, watch: false }).install(localHost);

    try {
      const traversal = await callTool(localHost, 'add_skill', {
        name: '../evil',
        content: 'pwned',
      });
      expect(traversal).toContain('非法');

      const slash = await callTool(localHost, 'add_skill', { name: 'a/b', content: 'pwned' });
      expect(slash).toContain('非法');

      // skillsDir 外无文件被写（../evil 会逃逸到 parentDir）
      expect(fs.existsSync(path.join(parentDir, 'evil.md'))).toBe(false);
      expect(fs.existsSync(path.join(skillsDir, 'a'))).toBe(false);
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('add_skill filePath 越界返回非法且不写文件', async () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-skills-parent-'));
    const skillsDir = path.join(parentDir, 'skills');
    const localHost = new MemoryPluginHost();
    createSkillsLoaderPlugin({ skillsDir, watch: false }).install(localHost);

    const outside = path.join(parentDir, 'outside.md');
    try {
      const result = await callTool(localHost, 'add_skill', {
        name: 'a',
        content: 'x',
        filePath: outside,
      });
      expect(result).toContain('非法');
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('add_skill filePath 已存在返回「Skill 文件已存在」且不覆盖', async () => {
    const existing = path.join(tmpDir, 'existing.md');
    fs.writeFileSync(existing, '# Original\nkeep me');

    const result = await callTool(host, 'add_skill', {
      name: 'a',
      content: '# New\noverwrite',
      filePath: existing,
    });
    expect(result).toContain('已存在');

    // 磁盘内容不被覆盖
    expect(fs.readFileSync(existing, 'utf-8')).toContain('keep me');
  });

  it('frontmatter 的 description 用于 list/search 展示', async () => {
    await callTool(host, 'add_skill', {
      name: 'git',
      content: [
        '---',
        'description: Git 操作指南',
        'when_to_use: 需要提交、分支或合并时',
        '---',
        '# Git',
        'body',
      ].join('\n'),
    });

    const search = await callTool(host, 'search_skills', { query: '操作指南' });
    expect(search).toContain('git');
    expect(search).toContain('Git 操作指南');
  });

  it('无 frontmatter 时回退到 # 标题作为 description', async () => {
    const manager = new SkillsManager({ skillsDir: tmpDir });
    const file = path.join(tmpDir, 'nofm.md');
    fs.writeFileSync(file, '# Just a title\nbody');
    manager.loadSkillFile(file);

    const skill = manager.getSkill('nofm');
    expect(skill?.description).toBe('Just a title');
    expect(skill?.metadata).toBeUndefined();
  });

  it('frontmatter 提取 when_to_use 存入 metadata，并去掉引号', async () => {
    const manager = new SkillsManager({ skillsDir: tmpDir });
    const file = path.join(tmpDir, 'fm.md');
    fs.writeFileSync(
      file,
      [
        '---',
        'description: "A parsed description"',
        "when_to_use: 'when doing X'",
        '---',
        '# Title',
        'body',
      ].join('\n'),
    );
    manager.loadSkillFile(file);

    const skill = manager.getSkill('fm');
    expect(skill?.description).toBe('A parsed description');
    expect(skill?.metadata).toEqual({ when_to_use: 'when doing X' });
  });

  it('frontmatter 非法（未闭合 / 非 key:value 行）不中断加载', async () => {
    const manager = new SkillsManager({ skillsDir: tmpDir });

    // 未闭合的 frontmatter → 回退标题
    const unclosed = path.join(tmpDir, 'unclosed.md');
    fs.writeFileSync(unclosed, '---\ndescription: no closing\n# Title\nbody');
    manager.loadSkillFile(unclosed);
    expect(manager.getSkill('unclosed')?.description).toBe('Title');

    // frontmatter 内含非法行 → 跳过非法行，正常解析合法字段
    const weird = path.join(tmpDir, 'weird.md');
    fs.writeFileSync(
      weird,
      ['---', 'this is not a yaml line', 'description: real desc', '---', '# Title', 'body'].join(
        '\n',
      ),
    );
    manager.loadSkillFile(weird);
    expect(manager.getSkill('weird')?.description).toBe('real desc');
  });
});
