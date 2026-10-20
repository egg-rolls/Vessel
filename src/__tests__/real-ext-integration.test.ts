/**
 * 真实 ext 包集成测试：workflow / evals / feishu。
 *
 * 这些测试直接 import 三个包的公开导出，验证 asm 的结构类型与真实接口一致；
 * 全部离线，不访问网络。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import {
  MemoryContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  MemorySessionBackend,
  type RunnableAgent,
  resolveTenantPaths,
} from '../../packages/core/src/index';
import * as evalsModule from '../../plugins/evals/harness/src/index';
import * as feishuModule from '../../plugins/im/feishu/src/index';
import { maskAppId as extMaskAppId } from '../../plugins/im/feishu/src/index';
import * as workflowModule from '../../plugins/workflow/engine/src/index';
import { executeEvalSuite } from '../eval-wiring';
import { createFeishuFromConfig, maskAppId } from '../feishu-wiring';
import { installTrace } from '../trace-wiring';
import { createWorkflowFromConfig } from '../workflow-wiring';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('real @vessel-agent/workflow', () => {
  it('constructs the engine and runs an agent step with workflow:<run_id> session', async () => {
    const base = tmpDir('vessel-04-real-wf-');
    const defs = path.join(base, 'defs');
    const store = path.join(base, 'runs');
    const definition = path.join(defs, 'demo.yaml');
    write(
      definition,
      [
        'name: demo',
        'version: 1',
        'steps:',
        '  - id: only',
        '    type: agent',
        '    agent: owner',
        '    prompt: hello',
      ].join('\n'),
    );

    const events = new MemoryEventStream();
    const pluginHost = new MemoryPluginHost();
    const sessionIds: Array<string | undefined> = [];
    const runtime = {
      events,
      pluginHost,
      run: async (_input: unknown, sessionId?: string) => {
        sessionIds.push(sessionId);
        return 'ok';
      },
      dispose: () => {},
    } as unknown as RunnableAgent;

    const config: VesselConfig = {
      workflow: { enabled: true, dir: defs, path: store, maxParallel: 1 },
    };

    const engine = await createWorkflowFromConfig({
      config,
      events,
      pluginHost,
      runtime,
      loadModule: async () => workflowModule,
    });
    expect(engine).toBeDefined();

    const started = await engine?.start(definition);
    const runId = started?.workflowRunId;
    expect(runId).toBeDefined();

    const outcome = await started?.done;
    expect(outcome?.status).toBe('completed');
    expect(sessionIds[0]).toBe(`workflow:${runId}`);

    const runs = await engine?.listRuns();
    expect(runs?.map((run) => run.workflow_run_id)).toEqual([runId as string]);

    await engine?.close();
  });
});

describe('real @vessel-agent/evals', () => {
  it('runs a suite offline and writes the report via ext report.ts', async () => {
    const base = tmpDir('vessel-04-real-eval-');
    const suiteDir = path.join(base, 'evals');
    const outDir = path.join(base, 'reports');
    write(
      path.join(suiteDir, 'smoke.yaml'),
      [
        'name: smoke',
        'cases:',
        '  - id: basic',
        '    input: hello',
        '    mock:',
        '      responses:',
        '        - content: hello',
        '    expect:',
        '      - type: output_contains',
        '        value: hello',
        '      - type: no_error',
      ].join('\n'),
    );

    const config: VesselConfig = {
      evals: { enabled: true, dir: suiteDir, outDir },
    };

    const result = await executeEvalSuite({
      config,
      target: 'smoke',
      filters: [],
      allowNetwork: false,
      loadModule: async () => evalsModule,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.total).toBe(1);
    expect(result.report.passed).toBe(1);
    expect(result.report.network).toBe(false);

    const reports = fs.readdirSync(outDir).filter((name) => name.endsWith('.json'));
    expect(reports).toHaveLength(1);
  });

  it('writes eval.run.* events into the tenant trace with tenant_id', async () => {
    const base = tmpDir('vessel-eval-trace-');
    const suiteDir = path.join(base, 'evals');
    write(
      path.join(suiteDir, 'smoke.yaml'),
      [
        'name: smoke',
        'cases:',
        '  - id: basic',
        '    input: hello',
        '    mock:',
        '      responses:',
        '        - content: hello',
        '    expect:',
        '      - type: output_contains',
        '        value: hello',
      ].join('\n'),
    );

    const events = new MemoryEventStream();
    const tenantPaths = resolveTenantPaths(base, 'acme');
    const config: VesselConfig = {
      evals: { enabled: true, dir: suiteDir },
      trace: { enabled: true, level: 'full' },
    };
    const trace = installTrace({ events, config, tenantPaths, tenantId: 'acme' });
    expect(trace).toBeDefined();

    try {
      await executeEvalSuite({
        config,
        target: 'smoke',
        filters: [],
        allowNetwork: false,
        tenantId: 'acme',
        tenantDir: tenantPaths.root,
        events,
        loadModule: async () => evalsModule,
      });
    } finally {
      await trace?.flush();
      await trace?.close();
    }

    const traceText = fs
      .readdirSync(tenantPaths.events_dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => fs.readFileSync(path.join(tenantPaths.events_dir, name), 'utf8'))
      .join('\n');

    expect(traceText).toContain('eval.run.started');
    expect(traceText).toContain('eval.run.completed');
    expect(traceText).toContain('"tenant_id":"acme"');
    // eval 报告默认落到 tenant 目录。
    expect(fs.existsSync(path.join(tenantPaths.root, 'evals'))).toBe(true);
  });
});

describe('real @vessel-agent/feishu', () => {
  it('constructs the plugin with a mock transport and starts/stops', async () => {
    const transport = {
      start: async (handlers: { onConnected?: () => void }) => {
        handlers.onConnected?.();
      },
      stop: async () => {},
      reply: async () => {},
    };

    const config: VesselConfig = {
      feishu: {
        enabled: true,
        appId: 'cli_test_id',
        appSecret: 'test_secret',
        allowedChatIds: [],
        sessionPrefix: 'feishu',
        maxMembers: 2,
      },
    };

    const channel = await createFeishuFromConfig({
      config,
      provider: new MemoryLLMProvider(),
      model: 'mock-model',
      pluginHost: new MemoryPluginHost(),
      session: new MemorySessionBackend(),
      events: new MemoryEventStream(),
      contextFactory: () => new MemoryContextManager(),
      transport,
      loadModule: async () => feishuModule,
    });

    expect(channel).toBeDefined();
    expect(channel?.status().appIdMasked).toBe('cli_***');

    await channel?.start();
    expect(channel?.status().connected).toBe(true);
    await channel?.stop();
    expect(channel?.status().connected).toBe(false);
  });

  it('maskAppId matches the ext rule for all lengths', () => {
    for (const appId of ['', 'a', 'ab', 'abcd', 'abcde', 'cli_abcdefg']) {
      expect(maskAppId(appId)).toBe(extMaskAppId(appId));
    }
  });
});
