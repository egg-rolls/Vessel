import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryEventStream, MemoryPluginHost } from '@vessel/core';
import { AssetManager, createMetaTools } from '../src/index';

describe('meta-tools 插件（#93 自描述字段）', () => {
  let host: MemoryPluginHost;
  let tmpDir: string;

  beforeEach(() => {
    host = new MemoryPluginHost();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-meta-'));
    // 用临时路径持久化，避免写仓库内 ./tools/custom-tools.json
    const assetManager = new AssetManager(host, path.join(tmpDir, 'custom-tools.json'));
    for (const tool of createMetaTools(assetManager)) {
      host.registerTool(tool);
    }
  });

  it('install 注册全部元工具', () => {
    const toolNames = host.listTools().map((t) => t.name);
    expect(toolNames).toContain('search_assets');
    expect(toolNames).toContain('add_tool');
    expect(toolNames).toContain('patch_asset');
    expect(toolNames).toContain('remove_asset');
  });

  it('危险工具声明 checkPermission + interactive', () => {
    for (const name of ['add_tool', 'patch_asset', 'remove_asset']) {
      const tool = host.getTool(name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool?.interactive, `${name} interactive`).toBe(true);
      expect(typeof tool?.checkPermission, `${name} checkPermission`).toBe('function');
    }
  });

  it('只读工具不声明 checkPermission', () => {
    const tool = host.getTool('search_assets');
    expect(tool).toBeDefined();
    expect(tool?.checkPermission).toBeUndefined();
    expect(tool?.interactive).toBeUndefined();
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
});
