import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryEventStream, MemoryPluginHost } from '../../packages/core/src/index';
import { DirScanner } from '../dir-scanner';

describe('DirScanner 用户目录扫描（#95）', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-dirscan-'));
    // 自描述工具对象（default export = ToolDefinition）
    fs.writeFileSync(
      path.join(tmpDir, 'hello.ts'),
      `export default {
        name: 'hello',
        description: 'Say hello',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        handler: async (args) => 'hello ' + ((args && args.name) || 'world'),
      };
      `,
    );
    // 完整 Plugin 形态
    fs.writeFileSync(
      path.join(tmpDir, 'greeter.ts'),
      `export default {
        name: 'greeter',
        install(host) {
          host.registerTool({
            name: 'greet',
            description: 'Greet',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => 'greetings',
          });
        },
      };
      `,
    );
    // 多工具数组形态
    fs.writeFileSync(
      path.join(tmpDir, 'multi.ts'),
      `export default [
        { name: 'one', description: 'One', inputSchema: {}, handler: async () => '1' },
        { name: 'two', description: 'Two', inputSchema: {}, handler: async () => '2' },
      ];
      `,
    );
    // 无识别导出
    fs.writeFileSync(path.join(tmpDir, 'bad.ts'), `export default 42;\n`);
    // 非支持扩展名 / _ 前缀忽略
    fs.writeFileSync(path.join(tmpDir, 'notes.md'), `# not a tool\n`);
    fs.writeFileSync(path.join(tmpDir, '_helper.ts'), `export default { name: 'x' };\n`);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('扫描目录返回工具文件名（忽略非支持扩展名与 _ 前缀）', () => {
    const scanner = new DirScanner([tmpDir]);
    expect(scanner.getAvailablePlugins().sort()).toEqual(['bad', 'greeter', 'hello', 'multi']);
  });

  it('loadPlugin 加载自描述工具文件并注册', async () => {
    const scanner = new DirScanner([tmpDir]);
    const plugin = await scanner.loadPlugin('hello');
    expect(plugin).not.toBeNull();
    const host = new MemoryPluginHost();
    await plugin?.install(host);
    const tool = host.getTool('hello');
    expect(tool?.description).toBe('Say hello');
    expect(
      await tool?.handler(
        { name: 'world' },
        { run_id: 'r1', messages: [], events: new MemoryEventStream() },
      ),
    ).toBe('hello world');
  });

  it('loadPlugin 加载完整 Plugin 形态导出', async () => {
    const scanner = new DirScanner([tmpDir]);
    const plugin = await scanner.loadPlugin('greeter');
    expect(plugin).not.toBeNull();
    expect(plugin?.name).toBe('greeter');
    const host = new MemoryPluginHost();
    await plugin?.install(host);
    expect(host.getTool('greet')).toBeDefined();
  });

  it('loadPlugin 加载多工具数组形态导出', async () => {
    const scanner = new DirScanner([tmpDir]);
    const plugin = await scanner.loadPlugin('multi');
    expect(plugin).not.toBeNull();
    const host = new MemoryPluginHost();
    await plugin?.install(host);
    expect(host.getTool('one')).toBeDefined();
    expect(host.getTool('two')).toBeDefined();
  });

  it('loadPlugin 无识别导出或未知插件返回 null', async () => {
    const scanner = new DirScanner([tmpDir]);
    expect(await scanner.loadPlugin('bad')).toBeNull();
    expect(await scanner.loadPlugin('does-not-exist')).toBeNull();
  });

  it('目录不存在时静默返回空', () => {
    const scanner = new DirScanner([path.join(tmpDir, 'nope')]);
    expect(scanner.getAvailablePlugins()).toEqual([]);
  });

  it('getProviders 返回空', () => {
    const scanner = new DirScanner([tmpDir]);
    expect(scanner.getProviders()).toEqual([]);
  });
});
