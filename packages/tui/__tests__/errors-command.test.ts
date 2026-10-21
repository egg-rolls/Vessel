import { afterEach, describe, expect, it } from 'bun:test';
import type { VesselConfig } from '@vessel-agent/config';
import type { RunEvent } from '@vessel-agent/core';
import { createCommands } from '../src/commands/commands.js';
import { formatErrorEntry, resolveErrorLevel } from '../src/commands/errors-command.js';
import { setLocale } from '../src/i18n/index.js';
import { collectRecentErrors, type ErrorLogEntry } from '../src/repl/error-log.js';
import { makeCtx, makeState } from './helpers.js';

function ev(type: string, runId: string, data: Record<string, unknown>, ts = 1000): RunEvent {
  return { type, run_id: runId, data, ts } as RunEvent;
}

function ctxWithUi(ui: Record<string, unknown>) {
  return makeCtx({ config: { ui } as VesselConfig });
}

function seedEvents(ctx: ReturnType<typeof makeCtx>): void {
  ctx.events.publish(
    ev('tool.permission.request', 'run-1', { requestId: 'p1', tool: 'bash' }, 1000),
  );
  ctx.events.publish(
    ev('tool.permission.response', 'run-1', { requestId: 'p1', decision: 'deny' }, 1100),
  );
  ctx.events.publish(ev('tool.call.failed', 'run-1', { tool_name: 'bash', error: 'exit 1' }, 1200));
  ctx.events.publish(
    ev(
      'run.failed',
      'run-2',
      {
        error: 'provider exploded',
        error_code: 'provider_auth',
        category: 'auth',
        phase: 'llm',
        retryable: false,
      },
      1300,
    ),
  );
  ctx.events.publish(ev('process.error', '', { error: 'uncaught' }, 1400));
}

afterEach(() => {
  setLocale('zh-CN');
});

describe('/errors', () => {
  it('shows only user-level errors by default', async () => {
    setLocale('en');
    const ctx = makeCtx();
    seedEvents(ctx);

    const result = await createCommands().execute('/errors', ctx, makeState('s1'));
    expect(result.output).toContain('Recent errors (user, 3)');
    expect(result.output).toContain('tool.call.failed');
    expect(result.output).toContain('run.failed');
    expect(result.output).toContain('permission denied by user for bash');
    expect(result.output).not.toContain('process.error');
    expect(result.output).toContain('/errors all');
  });

  it('honors ui.errorLevel: all', async () => {
    setLocale('en');
    const ctx = ctxWithUi({ errorLevel: 'all' });
    seedEvents(ctx);

    const result = await createCommands().execute('/errors', ctx, makeState('s1'));
    expect(result.output).toContain('Recent errors (all, 4)');
    expect(result.output).toContain('process.error');
  });

  it('honors ui.showInternalEvents: true even with errorLevel user', async () => {
    setLocale('en');
    const ctx = ctxWithUi({ errorLevel: 'user', showInternalEvents: true });
    seedEvents(ctx);

    const result = await createCommands().execute('/errors', ctx, makeState('s1'));
    expect(result.output).toContain('Recent errors (all, 4)');
    expect(result.output).toContain('process.error');
  });

  it('/errors all affects this invocation only and /errors user hides internal', async () => {
    setLocale('en');
    const ctx = ctxWithUi({ errorLevel: 'user', showInternalEvents: true });
    seedEvents(ctx);

    const all = await createCommands().execute('/errors all', ctx, makeState('s1'));
    expect(all.output).toContain('process.error');

    const user = await createCommands().execute('/errors user', ctx, makeState('s1'));
    expect(user.output).not.toContain('process.error');
  });

  it('shows the optional error envelope fields', async () => {
    setLocale('en');
    const ctx = makeCtx();
    seedEvents(ctx);

    const result = await createCommands().execute('/errors', ctx, makeState('s1'));
    expect(result.output).toContain('provider_auth');
    expect(result.output).toContain('auth/llm');
    expect(result.output).toContain('not retryable');
  });

  it('finds internal hook/plugin/agent errors only when enabled', async () => {
    const ctx = ctxWithUi({ errorLevel: 'all' });
    ctx.events.publish(ev('hook.failed', 'r', { error: 'hook boom' }, 1000));
    ctx.events.publish(ev('plugin.failed', 'r', { error: 'plugin boom' }, 1001));
    ctx.events.publish(ev('agent.failed', 'r', { error: 'agent boom' }, 1002));

    const entries = collectRecentErrors(ctx.events.getHistory(), { includeInternal: true });
    expect(entries.map((entry) => entry.type)).toEqual([
      'agent.failed',
      'plugin.failed',
      'hook.failed',
    ]);
  });

  it('returns a friendly empty state', async () => {
    setLocale('en');
    const result = await createCommands().execute('/errors', makeCtx(), makeState('s1'));
    expect(result.output).toContain('No recent errors.');
  });

  it('validates the level argument', async () => {
    setLocale('en');
    const result = await createCommands().execute('/errors verbose', makeCtx(), makeState('s1'));
    expect(result.output).toContain('Unknown level "verbose"');
    expect(result.output).toContain('Usage: /errors [user|all]');
  });

  it('resolves effective level from explicit args and config', () => {
    expect(resolveErrorLevel([], ctxWithUi({ errorLevel: 'all' }))).toEqual({
      level: 'all',
      includeInternal: true,
    });
    expect(resolveErrorLevel([], ctxWithUi({ showInternalEvents: true }))).toEqual({
      level: 'all',
      includeInternal: true,
    });
    expect(resolveErrorLevel(['user'], ctxWithUi({ errorLevel: 'all' }))).toEqual({
      level: 'user',
      includeInternal: false,
    });
    expect(resolveErrorLevel([], makeCtx())).toEqual({
      level: 'user',
      includeInternal: false,
    });
  });

  it('formats each entry on one sanitized line', () => {
    const entry: ErrorLogEntry = {
      ts: 1000,
      type: 'tool.call.failed',
      level: 'user',
      kind: 'error',
      runId: 'run-1234567890abcdef',
      tool: 'bash',
      message: 'line one\nline two',
    };
    const formatted = formatErrorEntry(entry);
    expect(formatted).toContain('tool.call.failed');
    expect(formatted).toContain('line one line two');
    expect(formatted).not.toContain('\n');
  });

  it('appends limit metadata to an error entry', async () => {
    setLocale('en');
    const ctx = makeCtx();
    ctx.events.publish(
      ev(
        'run.failed',
        'run-1',
        {
          error: 'Usage limits exceeded',
          details: {
            error_code: 'limit_blocked',
            scope: 'run',
            key: 'toolCallsLimit',
            current: 50,
            max: 50,
            source: 'config.limits',
            hint: 'raise limits.toolCallsLimit',
          },
        },
        1000,
      ),
    );

    const result = await createCommands().execute('/errors', ctx, makeState('s1'));
    expect(result.output).toContain('Usage limits exceeded');
    expect(result.output).toContain(
      '[run/toolCallsLimit 50/50 · config.limits · raise limits.toolCallsLimit]',
    );

    const entry = collectRecentErrors(ctx.events.getHistory(), { includeInternal: false })[0];
    expect(entry?.limit).toMatchObject({ key: 'toolCallsLimit', current: 50, max: 50 });
  });

  it('surfaces a bare limit.blocked event without fabricating a message', async () => {
    setLocale('en');
    const ctx = makeCtx();
    ctx.events.publish(
      ev(
        'limit.blocked',
        'run-2',
        { scope: 'agent', key: 'maxIterations', current: 20, max: 20 },
        1000,
      ),
    );

    const result = await createCommands().execute('/errors', ctx, makeState('s1'));
    expect(result.output).toContain('limit.blocked');
    expect(result.output).toContain('limit blocked');
    expect(result.output).toContain('[agent/maxIterations 20/20]');
  });

  it('leaves entries without a limit envelope byte-identical', () => {
    setLocale('en');
    const ctx = makeCtx();
    ctx.events.publish(ev('tool.call.failed', 'run-3', { tool_name: 'bash', error: 'boom' }, 1000));

    const entry = collectRecentErrors(ctx.events.getHistory(), { includeInternal: false })[0];
    if (!entry) throw new Error('expected entry');
    expect(entry.limit).toBeUndefined();
    expect(formatErrorEntry(entry)).not.toContain('[');
  });
});
