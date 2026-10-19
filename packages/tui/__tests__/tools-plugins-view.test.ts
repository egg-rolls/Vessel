import { describe, expect, it } from 'bun:test';
import type { ToolDefinition } from '@vessel/core';
import {
  buildPluginsListView,
  buildToolDetailView,
  buildToolsListView,
  createCommands,
  formatToolSchema,
  runToolsViewAction,
  type ToolViewInfo,
} from '../src/commands/commands.js';
import { makeCtx, makeState } from './helpers.js';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: '回显输入',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
  handler: async () => 'ok',
};

const info: ToolViewInfo = {
  name: 'echo',
  description: '回显输入',
  inputSchema: echoTool.inputSchema,
  source: 'plugin',
  requiresApproval: true,
};

describe('/tools view mapping', () => {
  it('列表项包含名称、截断描述与 source/permission 标记', () => {
    const longDescription = 'x'.repeat(300);
    const view = buildToolsListView([
      info,
      {
        ...info,
        name: 'mcp__github__search',
        source: 'mcp',
        requiresApproval: false,
        description: longDescription,
      },
    ]);
    expect(view.kind).toBe('list');
    expect(view.items[0]?.label).toBe('echo');
    expect(view.items[0]?.badge).toBe('plugin · ask');
    expect(view.items[1]?.badge).toBe('mcp');
    expect(view.items[1]?.description?.length).toBeLessThanOrEqual(96);
    expect(view.items[0]).toBeDefined();
    expect(view.actions?.[0]?.key).toBe('enter');
  });

  it('详情包含完整描述、权限与美化 schema', () => {
    const view = buildToolDetailView(info);
    expect(view.key).toBe('echo');
    expect(view.badge?.text).toBe('plugin');
    const fields = view.sections[0]?.fields ?? [];
    expect(fields.find((field) => field.label === 'Description')?.value).toBe('回显输入');
    expect(fields.find((field) => field.label === 'Permission')?.value).toContain('ask');
    expect(view.sections[1]?.lines?.join('\n')).toContain('"type": "object"');
    expect(view.sections[1]?.lines?.join('\n')).toContain('要回显的文本');
  });

  it('schema 超长时按行/字符截断', () => {
    const big = { items: Array.from({ length: 100 }, (_, index) => ({ index })) };
    const lines = formatToolSchema(big, 5, 80);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toContain('more lines');
    expect(formatToolSchema(undefined)).toEqual(['(none)']);
  });

  it('命令返回列表视图（本地 pluginHost）', async () => {
    const ctx = makeCtx();
    ctx.pluginHost.registerTool(echoTool);
    const result = await createCommands().execute('tools', ctx, makeState(ctx.currentSessionId));
    expect(result.output).toContain('echo: 回显输入');
    expect(result.view?.source).toBe('tools');
    expect(result.view?.view.kind).toBe('list');
  });

  it('viewAction Enter 打开详情（本地数据源）', async () => {
    const ctx = makeCtx();
    ctx.pluginHost.registerTool(echoTool);
    const result = await runToolsViewAction({ actionId: 'inspect', selectionKey: 'echo' }, ctx);
    expect(result.view?.view.kind).toBe('detail');
    const view = result.view?.view;
    if (view?.kind !== 'detail') throw new Error('expected detail view');
    expect(view.key).toBe('echo');
  });

  it('未知工具给出明确提示', async () => {
    const ctx = makeCtx();
    ctx.pluginHost.registerTool(echoTool);
    const result = await runToolsViewAction({ actionId: 'inspect', selectionKey: 'nope' }, ctx);
    expect(result.output).toContain('Tool "nope" not found');
  });
});

describe('/plugins view mapping', () => {
  it('列表项带 plugin 标记', () => {
    const view = buildPluginsListView(['workflow', 'feishu']);
    expect(view.kind).toBe('list');
    expect(view.items.map((item) => item.label)).toEqual(['workflow', 'feishu']);
    expect(view.items[0]?.badge).toBe('plugin');
    expect(buildPluginsListView([]).emptyText).toBe('No plugins loaded.');
  });

  it('命令仍输出原文并返回视图', async () => {
    const ctx = makeCtx({ plugins: ['workflow', 'feishu'] });
    const result = await createCommands().execute('plugins', ctx, makeState(ctx.currentSessionId));
    expect(result.output).toContain('Loaded plugins (2)');
    expect(result.view?.source).toBe('plugins');
    expect(result.view?.view.kind).toBe('list');
  });
});
