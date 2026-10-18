/**
 * 0.5 A-6 Commit C：`--serve` 两 tenant 集成探针。
 *
 * VESSEL_MOCK=1 + per-tenant token 启动真实 CLI；断言：
 * - 两个 tenant 各自 runs.start 成功；
 * - session / runs / events(trace) / metrics / config / plugins 互不可见；
 * - 事件带 tenant_id；disabled tenant → forbidden；
 * - 每个 active tenant 持自己的 writer lock。
 */

import { expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-tenant-serve-'));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

async function waitForOutput(
  proc: { stdout: ReadableStream<Uint8Array> },
  pattern: RegExp,
  timeoutMs = 15000,
): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopped = false;

  const pump = (async () => {
    try {
      while (!stopped) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
      }
    } catch {
      // 进程退出导致流关闭
    }
  })();

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(buffer)) return buffer;
      await Bun.sleep(50);
    }
    return buffer;
  } finally {
    stopped = true;
    await reader.cancel().catch(() => {});
    void pump;
  }
}

interface RpcResponse {
  result?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

async function rpc(
  baseUrl: string,
  token: string,
  method: string,
  params?: unknown,
): Promise<RpcResponse> {
  const response = await fetch(`${baseUrl}/v1/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, id: crypto.randomUUID(), method, params }),
  });
  return (await response.json()) as RpcResponse;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error('condition not met before timeout');
}

function traceText(dir: string, tenantId: string): string {
  const eventsDir = path.join(dir, '.vessel', 'data', 'tenants', tenantId, 'events');
  if (!fs.existsSync(eventsDir)) return '';
  return fs
    .readdirSync(eventsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => fs.readFileSync(path.join(eventsDir, name), 'utf8'))
    .join('\n');
}

it('enforces config max_concurrent_runs through the tenant registry', async () => {
  const dir = tmpDir();
  writeFile(
    path.join(dir, 'vessel.yaml'),
    [
      'provider:',
      '  name: openai',
      '  model: gpt-4',
      'tenant:',
      '  default: acme',
      '  tenants:',
      '    acme:',
      '      status: active',
      '      config: {}',
      '    zero:',
      '      status: active',
      '      quota:',
      '        max_concurrent_runs: 0',
      '      config: {}',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(dir, '.vessel', 'config.yaml'),
    [
      'serve:',
      '  tokens:',
      '    tok-acme:',
      '      tenant_id: acme',
      '      role: admin',
      '    tok-zero:',
      '      tenant_id: zero',
      '      role: admin',
      '',
    ].join('\n'),
  );

  const proc = Bun.spawn([process.execPath, cliPath, '--serve', '0'], {
    cwd: dir,
    env: { ...process.env, VESSEL_MOCK: '1', USERPROFILE: dir, HOME: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    const output = await waitForOutput(proc, /Gateway\s+http/);
    const url = /Gateway\s+(http[^\s]+)/.exec(output)?.[1] as string;
    expect(url).toBeDefined();

    const info = await rpc(url, 'tok-zero', 'tenants.get', { tenant_id: 'zero' });
    expect(
      (info.result as { tenant: { quota?: { max_concurrent_runs?: number } } }).tenant.quota,
    ).toMatchObject({ max_concurrent_runs: 0 });

    const started = await rpc(url, 'tok-zero', 'runs.start', { input: 'blocked' });
    expect(started.error?.code).toBe('quota_exceeded');
    expect(started.error?.details).toMatchObject({ tenant_id: 'zero', limit: 0 });

    // acme 无 quota，仍可启动。
    const acme = await rpc(url, 'tok-acme', 'runs.start', { input: 'ok' });
    expect(acme.error).toBeUndefined();
  } finally {
    proc.kill();
    await proc.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

it('serves two isolated tenants with per-tenant tokens', async () => {
  const dir = tmpDir();
  writeFile(
    path.join(dir, 'vessel.yaml'),
    [
      'provider:',
      '  name: openai',
      '  model: gpt-4',
      'observability:',
      '  metrics: true',
      '  event_history: 500',
      'tenant:',
      '  default: acme',
      '  tenants:',
      '    acme:',
      '      status: active',
      '      config:',
      '        agent:',
      '          system_prompt: acme-prompt',
      '        plugins:',
      '          - name: redact-secrets',
      '            enabled: true',
      '    work:',
      '      status: active',
      '      config:',
      '        agent:',
      '          system_prompt: work-prompt',
      '        plugins:',
      '          - name: hook-logging',
      '            enabled: true',
      '    off:',
      '      status: disabled',
      '      config: {}',
      '',
    ].join('\n'),
  );
  writeFile(
    path.join(dir, '.vessel', 'config.yaml'),
    [
      'serve:',
      '  tokens:',
      '    tok-acme:',
      '      tenant_id: acme',
      '      role: admin',
      '    tok-work:',
      '      tenant_id: work',
      '      role: admin',
      '    tok-admin:',
      '      tenant_id: "*"',
      '      role: admin',
      '',
    ].join('\n'),
  );

  const proc = Bun.spawn([process.execPath, cliPath, '--serve', '0'], {
    cwd: dir,
    env: { ...process.env, VESSEL_MOCK: '1', USERPROFILE: dir, HOME: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    const output = await waitForOutput(proc, /Gateway\s+http/);
    const baseUrl = /Gateway\s+(http[^\s]+)/.exec(output)?.[1];
    expect(baseUrl).toBeDefined();
    const url = baseUrl as string;

    // 每个 active tenant 在自己的目录持锁。
    const acmeLock = path.join(dir, '.vessel', 'data', 'tenants', 'acme', '.lock');
    const workLock = path.join(dir, '.vessel', 'data', 'tenants', 'work', '.lock');
    expect(fs.existsSync(acmeLock)).toBe(true);
    expect(fs.existsSync(workLock)).toBe(true);

    // A6-13：gateway 注入 tenants registry。
    const tenantList = (await rpc(url, 'tok-admin', 'tenants.list', {})).result as {
      tenants: Array<{ tenant_id: string; status: string }>;
    };
    // 配置里的 tenant（含 disabled）都应出现在 registry 中。
    expect(tenantList.tenants.map((tenant) => tenant.tenant_id).sort()).toEqual([
      'acme',
      'off',
      'work',
    ]);
    expect(tenantList.tenants.find((tenant) => tenant.tenant_id === 'off')?.status).toBe(
      'disabled',
    );

    const tenantGet = await rpc(url, 'tok-admin', 'tenants.get', { tenant_id: 'acme' });
    expect((tenantGet.result as { tenant: { tenant_id: string } }).tenant.tenant_id).toBe('acme');

    // acme run
    const acmeStart = await rpc(url, 'tok-acme', 'runs.start', {
      input: 'hello-acme',
      session_id: 'acme-session',
    });
    expect(acmeStart.error).toBeUndefined();
    const acmeRunId = (acmeStart.result as { run_id: string }).run_id;

    let acmeCoreRunId = '';
    await waitFor(async () => {
      const got = await rpc(url, 'tok-acme', 'runs.get', { run_id: acmeRunId });
      const run = (got.result as { run?: { status?: string; core_run_id?: string } })?.run;
      if (run?.status === 'completed' && run.core_run_id) acmeCoreRunId = run.core_run_id;
      return run?.status === 'completed';
    });
    expect(acmeCoreRunId).not.toBe('');

    // metrics 隔离：acme 已有 run，work 仍为 0。
    const acmeMetrics = await rpc(url, 'tok-acme', 'metrics.get', {});
    expect(
      (acmeMetrics.result as { metrics: { runs: { started: number } } }).metrics.runs.started,
    ).toBeGreaterThanOrEqual(1);
    const workMetricsBefore = await rpc(url, 'tok-work', 'metrics.get', {});
    expect(
      (workMetricsBefore.result as { metrics: { runs: { started: number } } }).metrics.runs.started,
    ).toBe(0);

    // work run
    const workStart = await rpc(url, 'tok-work', 'runs.start', {
      input: 'hello-work',
      session_id: 'work-session',
    });
    expect(workStart.error).toBeUndefined();
    const workRunId = (workStart.result as { run_id: string }).run_id;

    let workCoreRunId = '';
    await waitFor(async () => {
      const got = await rpc(url, 'tok-work', 'runs.get', { run_id: workRunId });
      const run = (got.result as { run?: { status?: string; core_run_id?: string } })?.run;
      if (run?.status === 'completed' && run.core_run_id) workCoreRunId = run.core_run_id;
      return run?.status === 'completed';
    });
    expect(workCoreRunId).not.toBe('');

    // session / run 列表互不可见。
    const acmeSessions = (await rpc(url, 'tok-acme', 'sessions.list', {})).result as {
      sessions: Array<{ session_id: string }>;
    };
    const workSessions = (await rpc(url, 'tok-work', 'sessions.list', {})).result as {
      sessions: Array<{ session_id: string }>;
    };
    expect(acmeSessions.sessions.map((session) => session.session_id)).toEqual(['acme-session']);
    expect(workSessions.sessions.map((session) => session.session_id)).toEqual(['work-session']);

    const acmeRuns = (await rpc(url, 'tok-acme', 'runs.list', {})).result as {
      runs: Array<{ run_id: string; tenant_id?: string }>;
    };
    const workRuns = (await rpc(url, 'tok-work', 'runs.list', {})).result as {
      runs: Array<{ run_id: string; tenant_id?: string }>;
    };
    expect(acmeRuns.runs.map((run) => run.run_id)).toEqual([acmeRunId]);
    expect(workRuns.runs.map((run) => run.run_id)).toEqual([workRunId]);

    // events(trace) 互不可见，且带正确 tenant_id。
    // 注意：trace 里的 run_id 是 core run id，不是 gateway run record id。
    await waitFor(() => traceText(dir, 'acme').includes(acmeCoreRunId));
    await waitFor(() => traceText(dir, 'work').includes(workCoreRunId));

    const acmeEvents = (await rpc(url, 'tok-acme', 'events.list', {})).result as {
      events: Array<{ tenant_id?: string; run_id: string; type: string }>;
    };
    expect(acmeEvents.events.length).toBeGreaterThan(0);
    expect(acmeEvents.events.every((event) => event.tenant_id === 'acme')).toBe(true);
    expect(acmeEvents.events.some((event) => event.run_id === 'plugins')).toBe(true);
    expect(acmeEvents.events.some((event) => event.run_id === workCoreRunId)).toBe(false);

    const workEvents = (await rpc(url, 'tok-work', 'events.list', {})).result as {
      events: Array<{ tenant_id?: string; run_id: string }>;
    };
    expect(workEvents.events.every((event) => event.tenant_id === 'work')).toBe(true);
    expect(workEvents.events.some((event) => event.run_id === acmeCoreRunId)).toBe(false);

    const acmeTrace = traceText(dir, 'acme');
    const workTrace = traceText(dir, 'work');
    expect(acmeTrace).not.toContain(workCoreRunId);
    expect(workTrace).not.toContain(acmeCoreRunId);
    expect(acmeTrace).toContain('"tenant_id":"acme"');
    expect(workTrace).toContain('"tenant_id":"work"');

    // config / plugins 按 tenant 返回。
    const acmeConfig = (await rpc(url, 'tok-acme', 'config.get', {})).result as {
      tenant_id: string;
      config: { agent?: { systemPrompt?: string } };
    };
    const workConfig = (await rpc(url, 'tok-work', 'config.get', {})).result as {
      tenant_id: string;
      config: { agent?: { systemPrompt?: string } };
    };
    expect(acmeConfig.tenant_id).toBe('acme');
    expect(acmeConfig.config.agent?.systemPrompt).toBe('acme-prompt');
    expect(workConfig.tenant_id).toBe('work');
    expect(workConfig.config.agent?.systemPrompt).toBe('work-prompt');

    const acmePlugins = (await rpc(url, 'tok-acme', 'plugins.list', {})).result as {
      plugins: Array<{ name: string; enabled: boolean }>;
    };
    const workPlugins = (await rpc(url, 'tok-work', 'plugins.list', {})).result as {
      plugins: Array<{ name: string; enabled: boolean }>;
    };
    expect(acmePlugins.plugins).toContainEqual({ name: 'redact-secrets', enabled: true });
    expect(acmePlugins.plugins.map((plugin) => plugin.name)).not.toContain('hook-logging');
    expect(workPlugins.plugins).toContainEqual({ name: 'hook-logging', enabled: true });
    expect(workPlugins.plugins.map((plugin) => plugin.name)).not.toContain('redact-secrets');

    // 每个 tenant 的 metrics 独立（work 只看到自己的 run）。
    const workMetrics = (await rpc(url, 'tok-work', 'metrics.get', {})).result as {
      metrics: { runs: { started: number; completed: number } };
    };
    expect(workMetrics.metrics.runs.started).toBeGreaterThanOrEqual(1);

    // disabled tenant → forbidden（admin token 显式指定 tenant）。
    const offStart = await rpc(url, 'tok-admin', 'runs.start', {
      input: 'nope',
      tenant_id: 'off',
    });
    expect(offStart.error?.code).toBe('forbidden');
  } finally {
    proc.kill();
    await proc.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
