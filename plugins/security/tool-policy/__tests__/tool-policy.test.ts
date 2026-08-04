import { beforeEach, describe, expect, it } from 'bun:test';
import { GuardrailStage, MemoryPluginHost } from '@vessel/core';
import { createToolPolicyPlugin, toolPolicyPlugin } from '../src/index';

describe('tool-policy 插件（P2）', () => {
  let host: MemoryPluginHost;

  beforeEach(() => {
    host = new MemoryPluginHost();
    toolPolicyPlugin.install(host);
  });

  it('install 注册 1 个 ToolCall guardrail', () => {
    const guardrails = host.getGuardrails();
    expect(guardrails.length).toBe(1);
    expect(guardrails[0]?.stage).toBe(GuardrailStage.ToolCall);
  });

  it('默认 denylist 为空 → 不拦截任何工具', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check('write_file', {
      run_id: 'r1',
      stage: GuardrailStage.ToolCall,
    });
    expect(r.allowed).toBe(true);
  });

  it('denylist 模式拦截指定工具', async () => {
    const denyHost = new MemoryPluginHost();
    createToolPolicyPlugin({
      mode: 'denylist',
      tools: ['dangerous_tool', 'delete_file'],
    }).install(denyHost);
    const g = denyHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const r1 = await g.check(
      { name: 'dangerous_tool' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r1.allowed).toBe(false);
    expect(r1.reason).toContain('已被禁止');

    const r2 = await g.check(
      { name: 'safe_tool' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r2.allowed).toBe(true);
  });

  it('allowlist 模式只允许指定工具', async () => {
    const allowHost = new MemoryPluginHost();
    createToolPolicyPlugin({ mode: 'allowlist', tools: ['read_file', 'list_files'] }).install(
      allowHost,
    );
    const g = allowHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const r1 = await g.check(
      { name: 'read_file' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r1.allowed).toBe(true);

    const r2 = await g.check(
      { name: 'write_file' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toContain('不在白名单中');
  });

  it('通配符匹配功能', async () => {
    const wildcardHost = new MemoryPluginHost();
    createToolPolicyPlugin({
      mode: 'denylist',
      tools: ['mcp__*'],
      enableWildcards: true,
    }).install(wildcardHost);
    const g = wildcardHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const r1 = await g.check(
      { name: 'mcp__server__tool' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r1.allowed).toBe(false);

    const r2 = await g.check(
      { name: 'safe_tool' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r2.allowed).toBe(true);
  });

  it('enableWildcards 参数不影响匹配行为（当前实现）', async () => {
    const noWildcardHost = new MemoryPluginHost();
    createToolPolicyPlugin({
      mode: 'denylist',
      tools: ['mcp__*'],
      enableWildcards: false,
    }).install(noWildcardHost);
    const g = noWildcardHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    // 注意：当前实现中 enableWildcards 参数未被使用
    // 通配符匹配始终启用
    const r1 = await g.check(
      { name: 'mcp__server__tool' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    // 由于通配符匹配始终启用，mcp__server__tool 会匹配 mcp__*
    expect(r1.allowed).toBe(false);

    // 精确匹配
    const r2 = await g.check(
      { name: 'mcp__*' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r2.allowed).toBe(false);
  });

  it('自定义阻断消息', async () => {
    const customMsgHost = new MemoryPluginHost();
    createToolPolicyPlugin({
      mode: 'denylist',
      tools: ['blocked_tool'],
      blockMessage: '安全策略拦截：',
    }).install(customMsgHost);
    const g = customMsgHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const r = await g.check(
      { name: 'blocked_tool' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('安全策略拦截');
  });

  it('工具名从上下文中获取', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check({}, {
      run_id: 'r1',
      stage: GuardrailStage.ToolCall,
      ...{ tool_name: 'test_tool' },
    } as Parameters<typeof g.check>[1]);
    expect(r.allowed).toBe(true);
  });

  it('空工具名放行', async () => {
    const g = host.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');
    const r = await g.check(
      {},
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r.allowed).toBe(true);
  });

  it('多个工具在黑名单中', async () => {
    const multiDenyHost = new MemoryPluginHost();
    createToolPolicyPlugin({
      mode: 'denylist',
      tools: ['tool_a', 'tool_b', 'tool_c'],
    }).install(multiDenyHost);
    const g = multiDenyHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    for (const toolName of ['tool_a', 'tool_b', 'tool_c']) {
      const r = await g.check(
        { name: toolName },
        {
          run_id: 'r1',
          stage: GuardrailStage.ToolCall,
        },
      );
      expect(r.allowed).toBe(false);
    }

    const rSafe = await g.check(
      { name: 'tool_d' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(rSafe.allowed).toBe(true);
  });
});
