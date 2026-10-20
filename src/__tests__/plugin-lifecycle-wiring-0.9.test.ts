/**
 * 0.9 Wave 2B2B A：装配层关闭路径必须等待插件 dispose（含配置包装插件）。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../packages/config/src/index';
import { resolveTenantPaths } from '../../packages/core/src/index';
import { PluginLoader } from '../plugin-loader';
import { buildTenantRuntime } from '../tenant-runtime-factory';

const PROBE_KEY = '__vesselLifecycleProbe';
const dirs: string[] = [];

interface ProbeState {
  inited: number;
  started: boolean;
  disposed: number;
  release: () => void;
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-lifecycle-wiring-'));
  dirs.push(dir);
  return dir;
}

/** 临时插件：dispose 先等测试放行，用于证明 close() 真的 await。 */
function writeProbePlugin(root: string): void {
  const pluginDir = path.join(root, 'lifecycle-probe');
  fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: '@vessel/lifecycle-probe', version: '0.0.1' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'src', 'index.ts'),
    [
      `const key = '${PROBE_KEY}';`,
      'const state = ((globalThis as any)[key] ??= {',
      '  inited: 0, started: false, disposed: 0, release: () => {},',
      '});',
      'let releaseGate = () => {};',
      'const gate = new Promise<void>((resolve) => { releaseGate = resolve; });',
      'state.release = () => releaseGate();',
      'export default {',
      "  name: 'lifecycle-probe',",
      '  install() {},',
      '  init() { state.inited += 1; },',
      '  async dispose() {',
      '    state.started = true;',
      '    await gate;',
      '    state.disposed += 1;',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[PROBE_KEY];
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('tenant runtime 关闭路径（0.9 生命周期 v2）', () => {
  it('await 插件 dispose（含 config 包装），重复 close 只 dispose 一次', async () => {
    const base = tmpDir();
    const pluginsRoot = path.join(base, 'plugins');
    writeProbePlugin(pluginsRoot);
    const configPath = path.join(base, 'vessel.yaml');
    fs.writeFileSync(
      configPath,
      [
        'provider:',
        '  name: openai',
        '  model: gpt-4',
        'plugins:',
        '  - name: lifecycle-probe',
        '    config:',
        '      flag: true',
      ].join('\n'),
      'utf8',
    );

    const loaded = await loadConfig({ configPath });
    expect(loaded.validation.errors).toEqual([]);

    const bundle = await buildTenantRuntime({
      tenantId: 'default',
      config: loaded.config,
      tenantPaths: resolveTenantPaths(base, 'default'),
      useMock: true,
      loader: new PluginLoader({
        roots: [{ dir: pluginsRoot, source: 'project', layout: 'flat' }],
      }),
      nodeId: 'node-test',
    });

    const probe = (globalThis as Record<string, unknown>)[PROBE_KEY] as ProbeState;
    expect(probe).toBeDefined();
    // config 包装层必须透传 init。
    expect(probe.inited).toBe(1);

    const closing = bundle.close();
    await Bun.sleep(20);
    // dispose 已开始但被 gate 卡住：close 不能提前完成（说明它 await 了）。
    expect(probe.started).toBe(true);
    expect(probe.disposed).toBe(0);

    probe.release();
    await closing;
    expect(probe.disposed).toBe(1);

    // 重复关闭安全：不再调用插件 dispose。
    await bundle.close();
    expect(probe.disposed).toBe(1);
  });

  it('工厂插件（MCP）由装配层关闭：close 被 await 且先于 runtime dispose', async () => {
    const base = tmpDir();
    const pluginsRoot = path.join(base, 'plugins');
    writeProbePlugin(pluginsRoot);
    const configPath = path.join(base, 'vessel.yaml');
    fs.writeFileSync(
      configPath,
      [
        'provider:',
        '  name: openai',
        '  model: gpt-4',
        'plugins:',
        '  - name: lifecycle-probe',
        'mcp_servers:',
        '  demo:',
        '    transport: stdio',
        '    command: node',
      ].join('\n'),
      'utf8',
    );

    const loaded = await loadConfig({ configPath });
    expect(loaded.validation.errors).toEqual([]);

    let releaseMcp = () => {};
    const mcpGate = new Promise<void>((resolve) => {
      releaseMcp = resolve;
    });
    const mcpState = { installed: 0, started: false, closed: 0 };
    const mcpModule = {
      createMcpPlugin: () => ({
        name: 'mcp-client',
        install() {
          mcpState.installed += 1;
        },
        close: async () => {
          mcpState.started = true;
          await mcpGate;
          mcpState.closed += 1;
        },
        listServers: () => [],
        getServer: () => undefined,
      }),
    };

    const bundle = await buildTenantRuntime({
      tenantId: 'default',
      config: loaded.config,
      tenantPaths: resolveTenantPaths(base, 'default'),
      useMock: true,
      loader: new PluginLoader({
        roots: [{ dir: pluginsRoot, source: 'project', layout: 'flat' }],
      }),
      nodeId: 'node-test',
      loadMcpModule: async () => mcpModule,
    });

    const probe = (globalThis as Record<string, unknown>)[PROBE_KEY] as ProbeState;
    expect(mcpState.installed).toBe(1);

    const closing = bundle.close();
    await Bun.sleep(20);
    // MCP close 被 await：它卡住时 runtime dispose 尚未开始。
    expect(mcpState.started).toBe(true);
    expect(mcpState.closed).toBe(0);
    expect(probe.started).toBe(false);

    releaseMcp();
    await Bun.sleep(20);
    // MCP 关闭完成后才轮到 runtime dispose（同样被 gate 卡住）。
    expect(mcpState.closed).toBe(1);
    expect(probe.started).toBe(true);
    expect(probe.disposed).toBe(0);

    probe.release();
    await closing;
    expect(probe.disposed).toBe(1);
  });
});
