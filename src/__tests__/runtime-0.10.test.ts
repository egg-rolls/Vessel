/**
 * 0.10 R2：logger 接线 / 未捕获兜底 / 关闭 drain / trace includeStreamChunks。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TRACE_OPTIONS } from '../../packages/config/src/index';
import { MemoryEventStream, type RunEvent, type TenantPaths } from '../../packages/core/src/index';
import { createCliLogger, parseLogLevel } from '../logging';
import { createProcessErrorHandler } from '../process-handlers';
import { reportShutdownFailure } from '../shutdown-report';
import { drainActiveRuns } from '../tenant-runtime-factory';
import { resolveTraceOptions } from '../trace-wiring';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-runtime-'));
  try {
    const proc = Bun.spawn([process.execPath, cliPath, ...args], {
      cwd: tmpDir,
      env: { ...process.env, ...env, USERPROFILE: tmpDir, HOME: tmpDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('logger 接线（R2-14）', () => {
  it('debug 日志只写 stderr（VESSEL_LOG_LEVEL=debug）', async () => {
    // 注：VESSEL_DEBUG 仍会让 ext 的 hook-logging 插件写 stdout（ext R2-14 待迁）；
    // asm 的 logger 接线用 VESSEL_LOG_LEVEL 验证，避免把插件行为算进来。
    const { stdout, stderr, exitCode } = await runCli(['--run', 'hello'], {
      VESSEL_MOCK: '1',
      VESSEL_DEBUG: '',
      VESSEL_LOG_LEVEL: 'debug',
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('Echo: hello');
    expect(stdout).not.toContain('"level"');
    expect(stderr).toContain('"level":"debug"');
    expect(stderr).toContain('"message":"llm request"');
  });

  it('VESSEL_LOG_LEVEL=error 抑制 info/debug', async () => {
    const { stdout, stderr } = await runCli(['--run', 'hello'], {
      VESSEL_MOCK: '1',
      VESSEL_DEBUG: '',
      VESSEL_LOG_LEVEL: 'error',
    });
    expect(stdout.trim()).toBe('Echo: hello');
    expect(stderr).not.toContain('"level":"debug"');
    expect(stderr).not.toContain('"level":"info"');
  });

  it('VESSEL_DEBUG 优先于 VESSEL_LOG_LEVEL；非法级别回退 info', () => {
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('WARN')).toBe('warn');
    expect(parseLogLevel('nope')).toBeUndefined();

    const captured: string[] = [];
    const originalError = process.stderr.write;
    const originalOut = process.stdout.write;
    let stdoutWrites = 0;
    try {
      process.stderr.write = ((chunk: string | Uint8Array) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      process.stdout.write = (() => {
        stdoutWrites += 1;
        return true;
      }) as typeof process.stdout.write;

      createCliLogger({ VESSEL_LOG_LEVEL: 'error' }).info('suppressed', { run_id: 'r1' });
      createCliLogger({ VESSEL_LOG_LEVEL: 'nope' }).info('visible', { run_id: 'r1' });
      createCliLogger({ VESSEL_DEBUG: '1', VESSEL_LOG_LEVEL: 'error' }).debug('debug-on', {
        run_id: 'r1',
      });
      createCliLogger({}).info('with secret', { api_key: 'sk-super-secret-value' });
    } finally {
      process.stderr.write = originalError;
      process.stdout.write = originalOut;
    }

    const output = captured.join('');
    expect(stdoutWrites).toBe(0);
    expect(output).not.toContain('suppressed');
    expect(output).toContain('"message":"visible"');
    expect(output).toContain('"message":"debug-on"');
    expect(output).toContain('***');
    expect(output).not.toContain('sk-super-secret-value');
  });
});

describe('未捕获兜底（R2-15）', () => {
  it('设置退出码、发 process.error、shutdown 只执行一次', async () => {
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const events = new MemoryEventStream();
    const exits: number[] = [];
    const codes: number[] = [];
    let shutdownCalls = 0;

    const handler = createProcessErrorHandler({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message, fields) => logs.push({ message, fields }),
      },
      events: () => events,
      shutdown: async () => {
        shutdownCalls += 1;
      },
      exit: (code) => exits.push(code),
      setExitCode: (code) => codes.push(code),
    });

    handler('unhandledRejection', new Error('boom-1'));
    handler('uncaughtException', new Error('boom-2'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(codes[0]).toBe(1);
    expect(exits).toEqual([1]);
    expect(shutdownCalls).toBe(1);
    expect(logs[0]?.message).toBe('process error');
    const errors = events.getHistory('process').filter((event) => event.type === 'process.error');
    expect(errors).toHaveLength(2);
    const first = errors[0]?.data as Record<string, unknown> | undefined;
    const second = errors[1]?.data as Record<string, unknown> | undefined;
    expect(first?.kind).toBe('unhandledRejection');
    expect(second?.kind).toBe('uncaughtException');
  });

  it('shutdown 卡住时按超时退出', async () => {
    const exits: number[] = [];
    const handler = createProcessErrorHandler({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      shutdown: () => new Promise<void>(() => {}),
      exit: (code) => exits.push(code),
      setExitCode: () => {},
      shutdownTimeoutMs: 10,
    });

    handler('unhandledRejection', 'plain-string-rejection');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(exits).toEqual([1]);
  });
});

describe('shutdown.failed（R2-16）', () => {
  it('发事件 + logger.error，并返回可读错误（调用方继续清理）', () => {
    const events = new MemoryEventStream();
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const message = reportShutdownFailure({
      events,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg, fields) => logs.push({ message: msg, fields }),
      },
      step: 'trace.close',
      error: new Error('disk gone'),
      tenantId: 'default',
    });

    expect(message).toBe('disk gone');
    expect(logs[0]?.message).toBe('shutdown.failed');
    expect(logs[0]?.fields).toMatchObject({
      step: 'trace.close',
      error: 'disk gone',
      tenant_id: 'default',
    });

    const [event] = events.getHistory('shutdown');
    expect(event?.type).toBe('shutdown.failed');
    expect(event?.data).toMatchObject({
      step: 'trace.close',
      error: 'disk gone',
      tenant_id: 'default',
    });
  });
});

describe('关闭 drain（R2-18）', () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  it('无 active run：idle 且不 interrupt', async () => {
    let interrupted = 0;
    const outcome = await drainActiveRuns({
      activeRuns: new Set(),
      interrupt: () => {
        interrupted += 1;
      },
      logger,
      tenantId: 'default',
    });
    expect(outcome).toBe('idle');
    expect(interrupted).toBe(0);
  });

  it('interrupt(shutdown) 后等待 run 终态', async () => {
    const activeRuns = new Set(['run-1']);
    let interrupted = 0;
    const outcome = await drainActiveRuns({
      activeRuns,
      interrupt: (reason) => {
        expect(reason).toBe('shutdown');
        interrupted += 1;
        setTimeout(() => activeRuns.delete('run-1'), 5);
      },
      logger,
      tenantId: 'default',
      timeoutMs: 200,
    });
    expect(outcome).toBe('interrupted');
    expect(interrupted).toBe(1);
    expect(activeRuns.size).toBe(0);
  });

  it('超时：记录 warning 并继续', async () => {
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const outcome = await drainActiveRuns({
      activeRuns: new Set(['run-stuck']),
      interrupt: () => {},
      logger: {
        debug: () => {},
        info: () => {},
        warn: (_message, fields) => warnings.push(fields),
        error: () => {},
      },
      tenantId: 'default',
      timeoutMs: 5,
    });
    expect(outcome).toBe('timeout');
    expect(warnings[0]?.tenant_id).toBe('default');
    expect(warnings[0]?.runs).toEqual(['run-stuck']);
  });

  it('host 模式（无 interrupt）：unsupported，不等待', async () => {
    const warnings: string[] = [];
    const outcome = await drainActiveRuns({
      activeRuns: new Set(['run-host']),
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
      tenantId: 'default',
      timeoutMs: 10_000,
    });
    expect(outcome).toBe('unsupported');
    expect(warnings[0]).toContain('no interrupt hook');
  });
});

describe('trace.includeStreamChunks（R2-14）', () => {
  it('默认 false，配置值透传到 resolveTraceOptions', () => {
    expect(DEFAULT_TRACE_OPTIONS.includeStreamChunks).toBe(false);
    expect(resolveTraceOptions({}).includeStreamChunks).toBe(false);
    expect(resolveTraceOptions({ trace: { includeStreamChunks: true } }).includeStreamChunks).toBe(
      true,
    );
  });

  it('自定义 recorder 收到配置，且默认过滤 llm.stream.chunk', async () => {
    const events = new MemoryEventStream();
    const seen: RunEvent[] = [];
    const captured: Array<boolean | undefined> = [];
    const { installTrace } = await import('../trace-wiring');

    const trace = installTrace({
      events,
      config: { trace: { enabled: true, level: 'full' } },
      tenantPaths: { events_dir: os.tmpdir() } as TenantPaths,
      tenantId: 'default',
      factory: (opts) => {
        captured.push(opts.includeStreamChunks);
        return {
          append: (event) => seen.push(event),
          flush: async () => {},
          close: async () => {},
        };
      },
    });

    const chunk: RunEvent = { type: 'llm.stream.chunk', run_id: 'r1', data: {}, ts: 1 };
    const start: RunEvent = { type: 'run.started', run_id: 'r1', data: {}, ts: 2 };
    events.publish(chunk);
    events.publish(start);
    await trace?.flush();
    await trace?.close();

    expect(captured).toEqual([false]);
    expect(seen.map((event) => event.type)).toEqual(['run.started']);
  });

  it('includeStreamChunks=true 时 chunk 落盘', async () => {
    const events = new MemoryEventStream();
    const seen: RunEvent[] = [];
    const { installTrace } = await import('../trace-wiring');

    const trace = installTrace({
      events,
      config: { trace: { enabled: true, level: 'full', includeStreamChunks: true } },
      tenantPaths: { events_dir: os.tmpdir() } as TenantPaths,
      tenantId: 'default',
      factory: (opts) => {
        expect(opts.includeStreamChunks).toBe(true);
        return {
          append: (event) => seen.push(event),
          flush: async () => {},
          close: async () => {},
        };
      },
    });

    events.publish({ type: 'llm.stream.chunk', run_id: 'r1', data: {}, ts: 1 });
    events.publish({ type: 'run.started', run_id: 'r1', data: {}, ts: 2 });
    await trace?.flush();
    await trace?.close();

    expect(seen.map((event) => event.type)).toEqual(['llm.stream.chunk', 'run.started']);
  });
});

// 保持 afterEach 可用（当前测试不涉及全局状态清理）
afterEach(() => {});
