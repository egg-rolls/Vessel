import { beforeEach, describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  GuardrailStage,
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type Plugin,
  type ToolDefinition,
} from '@vessel/core';
import { createToolPolicyPlugin, type PluginInstallOptions, toolPolicyPlugin } from '../src/index';

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

  it('enableWildcards: false 时按字面量匹配', async () => {
    const noWildcardHost = new MemoryPluginHost();
    createToolPolicyPlugin({
      mode: 'denylist',
      tools: ['mcp__*'],
      enableWildcards: false,
    }).install(noWildcardHost);
    const g = noWildcardHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const r1 = await g.check(
      { name: 'mcp__server__tool' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r1.allowed).toBe(true);

    // 字面量精确匹配仍然生效
    const r2 = await g.check(
      { name: 'mcp__*' },
      {
        run_id: 'r1',
        stage: GuardrailStage.ToolCall,
      },
    );
    expect(r2.allowed).toBe(false);
  });

  it('通配符中的正则元字符按字面量处理', async () => {
    const hostWithMeta = new MemoryPluginHost();
    createToolPolicyPlugin({
      mode: 'denylist',
      tools: ['tool.(v2)*'],
    }).install(hostWithMeta);
    const g = hostWithMeta.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    // `.` 不应当作任意字符：toolXv2abc 不应被拦截
    const r1 = await g.check(
      { name: 'toolXv2abc' },
      { run_id: 'r1', stage: GuardrailStage.ToolCall },
    );
    expect(r1.allowed).toBe(true);

    // 字面量 `tool.(v2)` 前缀命中
    const r2 = await g.check(
      { name: 'tool.(v2)beta' },
      { run_id: 'r1', stage: GuardrailStage.ToolCall },
    );
    expect(r2.allowed).toBe(false);
  });

  it('runtime 传入的是 ToolCall（function.name），不是 { name }', async () => {
    const denyHost = new MemoryPluginHost();
    createToolPolicyPlugin({
      mode: 'denylist',
      tools: ['danger_tool'],
    }).install(denyHost);
    const g = denyHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const r = await g.check(
      {
        id: 'tc1',
        type: 'function',
        function: { name: 'danger_tool', arguments: '{}' },
      },
      { run_id: 'r1', stage: GuardrailStage.ToolCall },
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('danger_tool');
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

  it('install 传入 plugins[].config 时生效（E1）', async () => {
    const configHost = new MemoryPluginHost();
    (toolPolicyPlugin.install as (h: MemoryPluginHost, o?: PluginInstallOptions) => void)(
      configHost,
      { config: { mode: 'allowlist', tools: ['read'], block_message: 'YAML 策略：' } },
    );
    const g = configHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    const allowed = await g.check(
      { name: 'read' },
      { run_id: 'r1', stage: GuardrailStage.ToolCall },
    );
    expect(allowed.allowed).toBe(true);

    const blocked = await g.check(
      { name: 'bash' },
      { run_id: 'r1', stage: GuardrailStage.ToolCall },
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('YAML 策略');
  });

  it('install 配置覆盖工厂配置（工厂默认 denylist，运行时改 allowlist）', async () => {
    const configHost = new MemoryPluginHost();
    const plugin = createToolPolicyPlugin({ mode: 'denylist', tools: ['read'] });
    (plugin.install as (h: MemoryPluginHost, o?: PluginInstallOptions) => void)(configHost, {
      config: { mode: 'allowlist', tools: ['read'] },
    });
    const g = configHost.getGuardrails()[0];
    if (!g) throw new Error('guardrail not registered');

    expect(
      (await g.check({ name: 'read' }, { run_id: 'r1', stage: GuardrailStage.ToolCall })).allowed,
    ).toBe(true);
    expect(
      (await g.check({ name: 'bash' }, { run_id: 'r1', stage: GuardrailStage.ToolCall })).allowed,
    ).toBe(false);
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

/** 构造一个只注册指定工具的插件 */
function toolPlugin(tool: ToolDefinition): Plugin {
  return {
    name: 'test-tools',
    install(host) {
      host.registerTool(tool);
    },
  };
}

/** 让 provider 对指定输入返回一次 tool_call */
function callTool(provider: MemoryLLMProvider, input: string, toolName: string): void {
  provider.setResponse(input, {
    content: '',
    finish_reason: 'tool_calls',
    tool_calls: [
      {
        id: 'tc-1',
        type: 'function',
        function: { name: toolName, arguments: '{}' },
      },
    ],
  });
}

describe('tool-policy 与 runtime 集成', () => {
  it('经 AgentRuntime 的真实 tool_call 被拦截后折回工具错误，run 继续', async () => {
    const provider = new MemoryLLMProvider();
    callTool(provider, 'CALL_DANGER', 'danger_tool');

    let handlerCalled = false;
    const dangerTool: ToolDefinition = {
      name: 'danger_tool',
      description: 'danger',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        handlerCalled = true;
        return 'should not run';
      },
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: {},
      termination: { maxIterations: 5 },
      plugins: [
        toolPlugin(dangerTool),
        createToolPolicyPlugin({ mode: 'denylist', tools: ['danger_tool'] }),
      ],
    });

    const result = await runtime.run('CALL_DANGER');
    expect(handlerCalled).toBe(false);
    expect(result).toContain('blocked by guardrail');
    expect(result).toContain('danger_tool');
    expect(result).not.toContain('should not run');
  });

  it('未命中策略的工具照常执行', async () => {
    const provider = new MemoryLLMProvider();
    callTool(provider, 'CALL_SAFE', 'safe_tool');
    // 工具执行后，模型看到 tool 消息会回显其内容并结束
    const safeTool: ToolDefinition = {
      name: 'safe_tool',
      description: 'safe',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'safe-result',
    };

    const runtime = await AgentRuntime.create({
      provider,
      model: 'test-model',
      context: new MemoryContextManager(),
      events: new MemoryEventStream(),
      limits: {},
      termination: { maxIterations: 5 },
      plugins: [
        toolPlugin(safeTool),
        createToolPolicyPlugin({ mode: 'denylist', tools: ['danger_tool'] }),
      ],
    });

    const result = await runtime.run('CALL_SAFE');
    expect(result).toBe('safe-result');
  });
});
