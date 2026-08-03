import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@vessel/core';
import { HookType, MemoryPluginHost } from '@vessel/core';
import memoryProjectPlugin from '../src/index';

describe('memory-project 插件（MECH-2）', () => {
  it('install 注册 list_memories/get_memory 工具 + BeforeLlm hook', () => {
    const host = new MemoryPluginHost();
    memoryProjectPlugin.install(host, { projectRoot: os.tmpdir() });
    const tools = host.listTools().map((t) => t.name);
    expect(tools).toContain('list_memories');
    expect(tools).toContain('get_memory');
    expect(host.getHooks().some((h) => h.type === HookType.BeforeLlm)).toBe(true);
  });

  it('BeforeLlm hook 把 CLAUDE.md 和 AGENTS.md 内容注入 ctx.system_prompt', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-mem-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Task Launcher\nSTOP. Build TodoList.');
      fs.writeFileSync(
        path.join(tmpDir, 'AGENTS.md'),
        '# Project Concepts\nUse Bun. Do not use npm.',
      );
      const host = new MemoryPluginHost();
      memoryProjectPlugin.install(host, { projectRoot: tmpDir });
      const hook = host.getHooks().find((h) => h.type === HookType.BeforeLlm);
      if (!hook) throw new Error('BeforeLlm hook not registered');

      const ctx = { run_id: 'r1', session_id: 's1' };
      await hook.run(ctx);
      const sp = (ctx as { system_prompt?: string }).system_prompt ?? '';
      // CLAUDE.md 注入（启动器）
      expect(sp).toContain('Task Launcher');
      expect(sp).toContain('任务启动器 (CLAUDE.md)');
      // AGENTS.md 注入（概念）
      expect(sp).toContain('Use Bun');
      expect(sp).toContain('项目概念 (AGENTS.md)');
      // CLAUDE.md 在 AGENTS.md 之前（启动器优先级）
      const claudeIdx = sp.indexOf('任务启动器 (CLAUDE.md)');
      const agentsIdx = sp.indexOf('项目概念 (AGENTS.md)');
      expect(claudeIdx).toBeLessThan(agentsIdx);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('无 CLAUDE.md / 无记忆时 hook 不注入（system_prompt 不变）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-mem-'));
    try {
      const host = new MemoryPluginHost();
      memoryProjectPlugin.install(host, { projectRoot: tmpDir });
      const hook = host.getHooks().find((h) => h.type === HookType.BeforeLlm);
      if (!hook) throw new Error('BeforeLlm hook not registered');
      const ctx = { run_id: 'r1' };
      await hook.run(ctx);
      expect((ctx as { system_prompt?: string }).system_prompt).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('list_memories 工具列出 .vessel/memory/ 中的记忆', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-mem-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.vessel', 'memory'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.vessel', 'memory', 'MEMORY.md'),
        '- [Test memory](test.md) - a test memory\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, '.vessel', 'memory', 'test.md'),
        '---\nname: test\ndescription: a test memory\n---\nTest content',
      );
      const host = new MemoryPluginHost();
      memoryProjectPlugin.install(host, { projectRoot: tmpDir });
      const tool = host.getTool('list_memories');
      if (!tool) throw new Error('list_memories tool not registered');
      const result = await tool.handler({}, { run_id: 'r1', messages: [] } as ToolContext);
      expect(result).toContain('test');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
