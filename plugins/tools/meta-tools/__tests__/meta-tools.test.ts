import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryEventStream, MemoryPluginHost, type ToolContext } from '@vessel/core';
import { createMetaTools } from '../src/index';

function toolCtx(): ToolContext {
  return { run_id: 'r1', messages: [], events: new MemoryEventStream() };
}

describe('meta-tools 插件（asset-decentralization 线A 瘦身）', () => {
  let host: MemoryPluginHost;
  let tmpDir: string;
  let toolsFilePath: string;

  beforeEach(() => {
    host = new MemoryPluginHost();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-meta-'));
    // 用临时路径持久化，避免写仓库内 ./tools/custom-tools.json
    toolsFilePath = path.join(tmpDir, 'custom-tools.json');
    for (const tool of createMetaTools(host, toolsFilePath)) {
      host.registerTool(tool);
    }
  });

  it('install 只注册 add_tool / remove_tool（跨模块元工具已删除）', () => {
    const toolNames = host.listTools().map((t) => t.name);
    expect(toolNames).toContain('add_tool');
    expect(toolNames).toContain('remove_tool');
    // 跨模块查询/假连接/技能管理元工具全部删除
    for (const removed of [
      'search_assets',
      'inspect_asset',
      'list_assets',
      'patch_asset',
      'connect_mcp',
      'add_skill',
      'remove_asset',
    ]) {
      expect(toolNames, `tool ${removed} should be removed`).not.toContain(removed);
    }
  });

  it('危险工具声明 checkPermission + interactive', () => {
    for (const name of ['add_tool', 'remove_tool']) {
      const tool = host.getTool(name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool?.interactive, `${name} interactive`).toBe(true);
      expect(typeof tool?.checkPermission, `${name} checkPermission`).toBe('function');
    }
  });

  it('add_tool checkPermission 通过事件流等待授权（allow）', async () => {
    const tool = host.getTool('add_tool');
    expect(tool).toBeDefined();
    const stream = new MemoryEventStream();
    // 模拟前端订阅授权请求并异步回复
    stream.subscribe((event) => {
      if (event.type === 'tool.permission.request') {
        setTimeout(() => {
          stream.publish({
            type: 'tool.permission.response',
            run_id: event.run_id,
            data: {
              requestId: (event.data as { requestId: string }).requestId,
              decision: 'allow',
            },
            ts: Date.now(),
          });
        }, 0);
      }
    });
    const decision = await tool?.checkPermission?.(
      { name: 'x', type: 'shell', command: 'echo hi' },
      { run_id: 'r1', messages: [], events: stream },
    );
    expect(decision).toBe('allow');
  });

  it('add_tool checkPermission 收到 deny 时返回 deny', async () => {
    const tool = host.getTool('add_tool');
    expect(tool).toBeDefined();
    const stream = new MemoryEventStream();
    stream.subscribe((event) => {
      if (event.type === 'tool.permission.request') {
        setTimeout(() => {
          stream.publish({
            type: 'tool.permission.response',
            run_id: event.run_id,
            data: {
              requestId: (event.data as { requestId: string }).requestId,
              decision: 'deny',
            },
            ts: Date.now(),
          });
        }, 0);
      }
    });
    const decision = await tool?.checkPermission?.(
      { name: 'x', type: 'shell', command: 'echo hi' },
      { run_id: 'r1', messages: [], events: stream },
    );
    expect(decision).toBe('deny');
  });

  it('add_tool 正常注册并持久化', async () => {
    const tool = host.getTool('add_tool');
    expect(tool).toBeDefined();

    const result = await tool?.handler(
      { name: 'hello', description: 'say hello', type: 'shell', command: 'echo hi' },
      toolCtx(),
    );
    expect(result).toContain('已注册');
    // PluginHost（工具真相源）已注册
    expect(host.getTool('hello')).toBeDefined();
    // 持久化文件包含该模板
    const persisted = JSON.parse(fs.readFileSync(toolsFilePath, 'utf-8')) as Array<{
      name: string;
    }>;
    expect(persisted.some((t) => t.name === 'hello')).toBe(true);
  });

  it('add_tool 缺参返回「参数缺失」', async () => {
    const tool = host.getTool('add_tool');
    expect(tool).toBeDefined();
    const result = await tool?.handler({ name: 'x', description: 'd', type: 'shell' }, toolCtx());
    expect(result).toContain('参数缺失');
    // 未注册、未持久化
    expect(host.getTool('x')).toBeUndefined();
  });

  it('add_tool 重名返回「工具名已存在」', async () => {
    const tool = host.getTool('add_tool');
    expect(tool).toBeDefined();
    await tool?.handler(
      { name: 'dup', description: 'd', type: 'shell', command: 'echo hi' },
      toolCtx(),
    );
    const result = await tool?.handler(
      { name: 'dup', description: 'd', type: 'shell', command: 'echo hi' },
      toolCtx(),
    );
    expect(result).toContain('工具名已存在');
  });

  it('remove_tool 删除已持久化工具', async () => {
    const addTool = host.getTool('add_tool');
    await addTool?.handler(
      { name: 'hello', description: 'd', type: 'shell', command: 'echo hi' },
      toolCtx(),
    );

    const removeTool = host.getTool('remove_tool');
    const result = await removeTool?.handler({ name: 'hello' }, toolCtx());
    expect(result).toContain('已删除');
    // 持久化文件不再包含该模板
    const persisted = JSON.parse(fs.readFileSync(toolsFilePath, 'utf-8')) as Array<{
      name: string;
    }>;
    expect(persisted.some((t) => t.name === 'hello')).toBe(false);
  });

  it('remove_tool 不存在返回「工具不存在」', async () => {
    const removeTool = host.getTool('remove_tool');
    const result = await removeTool?.handler({ name: 'nonexistent' }, toolCtx());
    expect(result).toContain('工具不存在');
  });

  it('remove_tool 内置工具拒绝', async () => {
    const removeTool = host.getTool('remove_tool');
    const result = await removeTool?.handler({ name: 'add_tool' }, toolCtx());
    expect(result).toContain('无法删除内置工具');
  });
});
