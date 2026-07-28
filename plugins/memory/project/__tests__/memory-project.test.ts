import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookType, MemoryPluginHost } from '@vessel/core';
import type { ToolContext } from '@vessel/core';
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

  it('BeforeLlm hook 把 CLAUDE.md 内容注入 ctx.system_prompt', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-mem-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project Rules\nUse Bun. Do not use npm.');
      const host = new MemoryPluginHost();
      memoryProjectPlugin.install(host, { projectRoot: tmpDir });
      const hook = host.getHooks().find((h) => h.type === HookType.BeforeLlm);
      expect(hook).toBeDefined();

      const ctx = { run_id: 'r1', session_id: 's1' };
      await hook!.run(ctx);
      const sp = (ctx as { system_prompt?: string }).system_prompt ?? '';
      expect(sp).toContain('Use Bun');
      expect(sp).toContain('项目说明 (CLAUDE.md)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('无 CLAUDE.md / 无记忆时 hook 不注入（system_prompt 不变）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-mem-'));
    try {
      const host = new MemoryPluginHost();
      memoryProjectPlugin.install(host, { projectRoot: tmpDir });
      const hook = host.getHooks().find((h) => h.type === HookType.BeforeLlm)!;
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
      expect(tool).toBeDefined();
      const result = await tool!.handler({}, { run_id: 'r1', messages: [] } as ToolContext);
      expect(result).toContain('test');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
