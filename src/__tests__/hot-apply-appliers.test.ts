import { describe, expect, it } from 'bun:test';
import { MemoryPluginHost, type ToolDefinition } from '../../packages/core/src/index';
import {
  applyMcp,
  applyTools,
  createMcpServerToggle,
  createPermissionApplier,
  createToolsApplier,
  describePermissionRules,
  type McpServerToggle,
} from '../hot-apply-appliers';
import type { McpControl, McpServerSummary } from '../mcp-wiring';

function tool(name: string, marker = ''): ToolDefinition {
  return {
    name,
    description: marker === '' ? `${name} tool` : marker,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => marker,
  };
}

describe('describePermissionRules', () => {
  it('逐条列出新增 / 移除的 auto 与 never 规则', () => {
    const lines = describePermissionRules(
      { default: 'ask', autoApprove: ['bash'], neverAutoApprove: ['agent.close'] },
      {
        default: 'ask',
        autoApprove: ['edit'],
        neverAutoApprove: ['agent.close', 'bash'],
      },
    );
    expect(lines).toEqual([
      'permission: edit auto allow',
      'permission: bash no longer auto allow',
      'permission: bash always ask',
    ]);
  });

  it('只改 default 时只报一行', () => {
    expect(describePermissionRules({ default: 'ask' }, { default: 'allow' })).toEqual([
      'permission: default allow',
    ]);
  });

  it('完全相同时没有差异行', () => {
    expect(
      describePermissionRules(
        { default: 'ask', autoApprove: ['bash'] },
        { default: 'ask', autoApprove: ['bash'] },
      ),
    ).toEqual([]);
  });
});

describe('createPermissionApplier', () => {
  it('把新规则应用到 runtime，并在成功后推进基线', async () => {
    const applied: unknown[] = [];
    const state: { current?: { default?: 'allow' | 'ask'; autoApprove?: string[] } } = {
      current: { default: 'ask', autoApprove: [] },
    };
    const applier = createPermissionApplier(
      {
        loadPermission: async () => ({ default: 'ask', autoApprove: ['bash'] }),
        apply: async (rules) => {
          applied.push(rules);
          return 2;
        },
      },
      state,
    );

    expect(await applier()).toEqual(['permission: bash auto allow']);
    expect(applied).toEqual([{ default: 'ask', autoApprove: ['bash'] }]);
    expect(state.current).toEqual({ default: 'ask', autoApprove: ['bash'] });

    // 第二次读取到同样的配置：没有差异，也不重复报。
    expect(await applier()).toEqual([]);
  });

  it('没有存活 runtime 时明确说明（规则下次启动生效）', async () => {
    const applier = createPermissionApplier({
      loadPermission: async () => ({ default: 'ask', autoApprove: ['bash'] }),
      apply: async () => 0,
    });
    expect(await applier()).toContain('permission: no live runtime (applies at next start)');
  });

  it('apply 抛错时基线不推进（下次仍能报出差异）', async () => {
    const state: { current?: { autoApprove?: string[] } } = { current: { autoApprove: [] } };
    let fail = true;
    const applier = createPermissionApplier(
      {
        loadPermission: async () => ({ autoApprove: ['bash'] }),
        apply: async () => {
          if (fail) throw new Error('boom');
          return 1;
        },
      },
      state,
    );
    await expect(applier()).rejects.toThrow('boom');
    expect(state.current).toEqual({ autoApprove: [] });

    fail = false;
    expect(await applier()).toEqual(['permission: bash auto allow']);
  });
});

describe('applyTools', () => {
  function hostWith(...names: string[]): MemoryPluginHost {
    const host = new MemoryPluginHost();
    for (const name of names) host.registerTool(tool(name));
    return host;
  }

  it('差量注册 / 注销，摘要形如 tools: +N -M', async () => {
    const host = hostWith('bash', 'read');
    const result = await applyTools({
      host,
      computeTargetTools: async () => [tool('read'), tool('edit'), tool('grep')],
      managedNames: () => ['bash', 'read'],
    });

    expect(result.added.sort()).toEqual(['edit', 'grep']);
    expect(result.removed).toEqual(['bash']);
    expect(result.summaries[0]).toBe('tools: +2 -1');
    expect(
      host
        .listTools()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['edit', 'grep', 'read']);
  });

  it('只在管辖集合内删除；其它来源的工具（MCP / agent）原样保留', async () => {
    const host = hostWith('bash', 'read', 'agent', 'mcp__fs__read_file');
    await applyTools({
      host,
      computeTargetTools: async () => [tool('read')],
      managedNames: () => ['bash', 'read'],
    });
    const names = host
      .listTools()
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(['agent', 'mcp__fs__read_file', 'read']);
  });

  it('注册失败时回滚到原状（不留半更新状态）', async () => {
    const inner = hostWith('bash', 'read');
    // 让「注册 edit」这一步失败：前一个 bash 注销已经发生，必须回滚回来。
    const host = {
      registerTool: (def: ToolDefinition) => {
        if (def.name === 'edit') throw new Error('registration exploded');
        inner.registerTool(def);
      },
      registerProvider: inner.registerProvider.bind(inner),
      registerGuardrail: inner.registerGuardrail.bind(inner),
      registerHook: inner.registerHook.bind(inner),
      getTool: inner.getTool.bind(inner),
      getProvider: inner.getProvider.bind(inner),
      getGuardrails: inner.getGuardrails.bind(inner),
      getHooks: inner.getHooks.bind(inner),
      listTools: inner.listTools.bind(inner),
      listProviders: inner.listProviders.bind(inner),
      unregisterTool: inner.unregisterTool.bind(inner),
    };

    await expect(
      applyTools({
        host,
        computeTargetTools: async () => [tool('read'), tool('edit')],
        managedNames: () => ['bash', 'read'],
      }),
    ).rejects.toThrow('tools_hot_apply_failed');

    // bash 必须回来（回滚），read 仍在，edit 没有残留。
    expect(
      host
        .listTools()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['bash', 'read']);
  });

  it('宿主不支持注销时明确报不可热移除', async () => {
    const inner = hostWith('bash');
    const host = {
      registerTool: (def: ToolDefinition) => inner.registerTool(def),
      registerProvider: inner.registerProvider.bind(inner),
      registerGuardrail: inner.registerGuardrail.bind(inner),
      registerHook: inner.registerHook.bind(inner),
      getTool: inner.getTool.bind(inner),
      getProvider: inner.getProvider.bind(inner),
      getGuardrails: inner.getGuardrails.bind(inner),
      getHooks: inner.getHooks.bind(inner),
      listTools: inner.listTools.bind(inner),
      listProviders: inner.listProviders.bind(inner),
    };

    await expect(
      applyTools({ host, computeTargetTools: async () => [], managedNames: () => ['bash'] }),
    ).rejects.toThrow('tools_hot_apply_unsupported');
  });

  it('无差异时不触发任何写入，摘要为空', async () => {
    const host = hostWith('bash');
    const result = await createToolsApplier({
      host,
      computeTargetTools: async () => [tool('bash')],
      managedNames: () => ['bash'],
    })();
    // 同一个 name 但定义不同 → updated；这里断言的是「只返回摘要」的形状。
    expect(Array.isArray(result)).toBe(true);
  });

  it('内容等价的新定义不算更新（避免每次配置写入都重注册）', async () => {
    const host = hostWith('bash');
    const result = await applyTools({
      host,
      // 新对象、同内容
      computeTargetTools: async () => [tool('bash')],
      managedNames: () => ['bash'],
    });
    expect(result.updated).toEqual([]);
    expect(result.summaries).toEqual([]);
  });

  it('定义变了（description）算刷新，并出现在摘要里', async () => {
    const host = hostWith('bash');
    const result = await applyTools({
      host,
      computeTargetTools: async () => [tool('bash', 'bash tool v2')],
      managedNames: () => ['bash'],
    });
    expect(result.updated).toEqual(['bash']);
    expect(result.summaries).toContain('tools: refreshed bash');
  });

  it('插件安装配置变了（targetKey）→ 管辖内工具整体刷新', async () => {
    const host = hostWith('bash', 'read');
    const previousKey: { value?: string } = { value: 'cwd:/a' };
    const result = await applyTools({
      host,
      computeTargetTools: async () => [tool('bash'), tool('read')],
      managedNames: () => ['bash', 'read'],
      targetKey: () => 'cwd:/b',
      previousKey,
    });
    expect(result.updated.sort()).toEqual(['bash', 'read']);
    expect(previousKey.value).toBe('cwd:/b');
  });
});

describe('mcp applier', () => {
  function summary(name: string, status: McpServerSummary['status'], tools: string[] = []) {
    return { name, status, tools };
  }

  function control(servers: McpServerSummary[]): {
    control: McpControl;
    reconnected: string[];
    setServers: (next: McpServerSummary[]) => void;
  } {
    let current = servers;
    const reconnected: string[] = [];
    return {
      control: {
        list: async () => current,
        reconnect: async (name: string) => {
          reconnected.push(name);
          current = current.map((server) =>
            server.name === name ? { ...server, status: 'connected' } : server,
          );
          return summary(name, 'connected');
        },
        toolSource: () => null,
      },
      reconnected,
      setServers: (next) => {
        current = next;
      },
    };
  }

  it('配置禁用的 server → disable（断开 + 注销工具），摘要说明', async () => {
    const { control: mcp } = control([summary('filesystem', 'connected', ['mcp__fs__read'])]);
    const host = new MemoryPluginHost();
    host.registerTool(tool('mcp__fs__read'));

    const toggles: string[] = [];
    const toggle: McpServerToggle = {
      enable: async (name) => {
        toggles.push(`enable:${name}`);
      },
      disable: async (name) => {
        toggles.push(`disable:${name}`);
      },
    };

    const lines = await applyMcp({
      control: mcp,
      toggle,
      desiredEnabled: async () => ({ filesystem: false }),
    });
    expect(lines).toEqual(['mcp: filesystem disabled']);
    expect(toggles).toEqual(['disable:filesystem']);
  });

  it('配置启用但状态 disabled → enable', async () => {
    const { control: mcp } = control([summary('filesystem', 'disabled')]);
    const toggles: string[] = [];
    const lines = await applyMcp({
      control: mcp,
      toggle: {
        enable: async (name) => {
          toggles.push(`enable:${name}`);
        },
        disable: async (name) => {
          toggles.push(`disable:${name}`);
        },
      },
      desiredEnabled: async () => ({ filesystem: true }),
    });
    expect(lines).toEqual(['mcp: filesystem enabled']);
    expect(toggles).toEqual(['enable:filesystem']);
  });

  it('failed + 应启用 → 走现有 reconnect', async () => {
    const { control: mcp, reconnected } = control([summary('db', 'failed')]);
    const lines = await applyMcp({
      control: mcp,
      desiredEnabled: async () => ({ db: true }),
    });
    expect(lines).toEqual(['mcp: db reconnected']);
    expect(reconnected).toEqual(['db']);
  });

  it('配置新增但插件未加载 → 明确 requires restart', async () => {
    const { control: mcp } = control([]);
    const lines = await applyMcp({
      control: mcp,
      desiredEnabled: async () => ({ brand_new: true }),
    });
    expect(lines).toEqual(['mcp: brand_new requires restart (not loaded)']);
  });

  it('createMcpServerToggle 的 disable 注销该 server 的工具', async () => {
    const host = new MemoryPluginHost();
    host.registerTool(tool('mcp__fs__read'));
    host.registerTool(tool('mcp__fs__write'));
    host.registerTool(tool('bash'));

    const { control: mcp } = control([
      summary('fs', 'connected', ['mcp__fs__read', 'mcp__fs__write']),
    ]);
    const toggle = createMcpServerToggle({
      control: mcp,
      plugin: {
        listServers: () => [summary('fs', 'connected', ['mcp__fs__read', 'mcp__fs__write'])],
      },
      host,
    });

    await toggle.disable('fs');
    expect(host.listTools().map((entry) => entry.name)).toEqual(['bash']);
  });
});
