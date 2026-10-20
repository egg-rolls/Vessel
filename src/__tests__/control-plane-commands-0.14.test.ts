import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { resolveTenantPaths } from '../../packages/core/src/index';
import { agentsCommand } from '../agents-command';
import type { ControlPlaneTarget } from '../control-plane-target';
import { errorsCommand } from '../errors-command';
import { RpcClientError } from '../rpc';
import { statusCommand } from '../status-command';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-control-plane-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function targetWith(
  request: (method: string, params?: unknown) => Promise<unknown>,
): ControlPlaneTarget & { calls: Array<{ method: string; params?: unknown }> } {
  const calls: Array<{ method: string; params?: unknown }> = [];
  return {
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8642',
    token: 'super-secret-token',
    instance: 'default',
    calls,
    request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      return (await request(method, params)) as T;
    },
    close: async () => undefined,
  };
}

describe('vessel status (0.14)', () => {
  it('--json reports local state without ANSI or secrets', async () => {
    const dir = tmpDir();
    const config: VesselConfig = {
      dataDir: dir,
      apiKey: 'sk-should-not-leak',
      serve: { token: 'serve-token-should-not-leak' },
      provider: { name: 'openai', model: 'gpt-4' },
    };
    const result = await statusCommand({
      config,
      dataDir: dir,
      tenantId: 'default',
      json: true,
      now: () => Date.parse('2026-10-20T12:00:00.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('\x1b');
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.as_of).toBe('2026-10-20T12:00:00.000Z');
    expect(payload.tenant_id).toBe('default');
    expect(payload.provider).toEqual({ name: 'openai', model: 'gpt-4' });
    expect(payload.instances).toEqual([]);
    expect(payload.attach).toBeNull();
    expect(payload.queue).toBeNull();
    expect(result.stdout).not.toContain('sk-should-not-leak');
    expect(result.stdout).not.toContain('serve-token-should-not-leak');
  });

  it('attaches through health.get and exposes queue', async () => {
    const dir = tmpDir();
    const target = targetWith(async () => ({
      status: 'ok',
      clients: 1,
      latest_seq: 7,
      tenant_id: 'default',
      node: {
        node_id: 'node-1',
        status: 'busy',
        current_run_id: 'run-1',
        current_session_id: 'sess-1',
      },
      runtime: { queue: { queued: 2, active: 1 } },
    }));

    const result = await statusCommand({
      config: { dataDir: dir },
      dataDir: dir,
      tenantId: 'default',
      json: true,
      target,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      attach: Record<string, unknown>;
      queue: unknown;
    };
    expect(target.calls[0]?.method).toBe('health.get');
    expect(payload.attach.node_id).toBe('node-1');
    expect(payload.attach.current_run_id).toBe('run-1');
    expect(payload.queue).toEqual({ queued: 2, active: 1 });
    expect(result.stdout).not.toContain('super-secret-token');
  });

  it('human output uses ui-style but stays colorless without a TTY', async () => {
    const dir = tmpDir();
    const result = await statusCommand({
      config: { dataDir: dir },
      dataDir: dir,
      tenantId: 'default',
      json: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('\x1b');
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

describe('vessel agents (0.14)', () => {
  it('calls agents.list and renders JSON', async () => {
    const dir = tmpDir();
    const target = targetWith(async () => ({
      agents: [
        {
          id: 'owner',
          role: 'owner',
          depth: 0,
          state: 'idle',
          current_tool: 'bash',
          session_id: 's1',
        },
      ],
    }));
    const result = await agentsCommand({
      config: { dataDir: dir },
      dataDir: dir,
      tenantId: 'default',
      json: true,
      target,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('\x1b');
    expect(target.calls[0]).toEqual({
      method: 'agents.list',
      params: { tenant_id: 'default' },
    });
    const payload = JSON.parse(result.stdout) as {
      source: Record<string, unknown>;
      agents: Array<Record<string, unknown>>;
    };
    expect(payload.source.kind).toBe('local');
    expect(payload.agents[0]?.id).toBe('owner');
    expect(result.stdout).not.toContain('super-secret-token');
  });

  it('reports not_supported without faking a registry', async () => {
    const dir = tmpDir();
    const target = targetWith(async () => {
      throw new RpcClientError('not_supported', 'unknown method');
    });
    const result = await agentsCommand({
      config: { dataDir: dir },
      dataDir: dir,
      json: true,
      target,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('agents.list');
  });
});

describe('vessel errors (0.14)', () => {
  function writeTrace(dataDir: string): void {
    const eventsDir = resolveTenantPaths(dataDir, 'default').events_dir;
    fs.mkdirSync(eventsDir, { recursive: true });
    const lines = [
      {
        type: 'run.failed',
        run_id: 'r1',
        ts: 1000,
        data: {
          error: 'provider timed out',
          session_id: 's1',
          error_code: 'provider_timeout',
          category: 'timeout',
          phase: 'llm',
          retryable: true,
        },
      },
      {
        type: 'tool.call.failed',
        run_id: 'r2',
        ts: 2000,
        data: { error: 'tool failed', tool_name: 'bash' },
      },
      {
        type: 'process.error',
        run_id: 'r3',
        ts: 3000,
        data: { error: 'process crash' },
      },
    ];
    for (const line of lines) {
      fs.writeFileSync(
        path.join(eventsDir, `${String(line.run_id)}.jsonl`),
        `${JSON.stringify(line)}\n`,
      );
    }
  }

  it('defaults to user-level errors, newest first, and no ANSI', async () => {
    const dir = tmpDir();
    writeTrace(dir);
    const result = await errorsCommand({
      config: { dataDir: dir },
      dataDir: dir,
      tenantId: 'default',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('\x1b');
    const payload = JSON.parse(result.stdout) as {
      error_level: string;
      events: Array<Record<string, unknown>>;
    };
    expect(payload.error_level).toBe('user');
    expect(payload.events.map((event) => event.run_id)).toEqual(['r2', 'r1']);
    expect(payload.events[1]?.error_code).toBe('provider_timeout');
    expect(result.stdout).not.toContain('process crash');
  });

  it('includes diagnostics when ui.errorLevel is all and honors --limit', async () => {
    const dir = tmpDir();
    writeTrace(dir);
    const all = await errorsCommand({
      config: { dataDir: dir, ui: { errorLevel: 'all' } },
      dataDir: dir,
      tenantId: 'default',
      json: true,
    });
    const allPayload = JSON.parse(all.stdout) as {
      error_level: string;
      events: Array<Record<string, unknown>>;
    };
    expect(allPayload.error_level).toBe('all');
    expect(allPayload.events.map((event) => event.run_id)).toEqual(['r3', 'r2', 'r1']);

    const limited = await errorsCommand({
      config: { dataDir: dir },
      dataDir: dir,
      tenantId: 'default',
      json: true,
      limit: 1,
    });
    const limitedPayload = JSON.parse(limited.stdout) as {
      events: Array<Record<string, unknown>>;
    };
    expect(limitedPayload.events).toHaveLength(1);
    expect(limitedPayload.events[0]?.run_id).toBe('r2');
  });

  it('showProcessErrors also enables diagnostics', async () => {
    const dir = tmpDir();
    writeTrace(dir);
    const result = await errorsCommand({
      config: { dataDir: dir, observability: { showProcessErrors: true } },
      dataDir: dir,
      tenantId: 'default',
      json: true,
    });
    const payload = JSON.parse(result.stdout) as { events: Array<Record<string, unknown>> };
    expect(payload.events.map((event) => event.run_id)).toContain('r3');
  });
});
