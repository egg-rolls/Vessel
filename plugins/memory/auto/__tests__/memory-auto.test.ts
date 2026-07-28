import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookType, MemoryPluginHost } from '@vessel/core';
import memoryAutoPlugin from '../src/index';

describe('memory-auto 插件（P2）', () => {
  it('install 注册 1 个 tool + 1 个 AfterLlm hook', () => {
    const host = new MemoryPluginHost();
    memoryAutoPlugin.install(host);
    expect(host.listTools().length).toBeGreaterThanOrEqual(1);
    expect(host.getHooks().some((h) => h.type === HookType.AfterLlm)).toBe(true);
  });

  it('AfterLlm hook 不抛错（无 memory dir）', async () => {
    const host = new MemoryPluginHost();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-ma-'));
    try {
      // 用 tmp dir 隔离，避开 repo .vessel/memory
      memoryAutoPlugin.install(host, { memoryDir: path.join(tmpDir, '.vessel', 'memory') });
      const hook = host.getHooks().find((h) => h.type === HookType.AfterLlm);
      if (!hook) throw new Error('AfterLlm hook not registered');
      const result = await hook.run({ run_id: 'r1', session_id: 's1' });
      expect(result).not.toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
