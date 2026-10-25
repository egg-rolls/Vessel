/**
 * doc-subscription 插件测试：工具 round-trip、通知（无正文）、inspect、双游标、降级、隔离、diff 单元。
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildPathBoundary, canonicalPath } from '@vessel-agent/basic-tools';
import type {
  Hook,
  HookContext,
  PluginHost,
  ToolContext,
  ToolDefinition,
} from '@vessel-agent/core';
import { HookType } from '@vessel-agent/core';
import { parseDocSubscriptionConfig } from '../src/config.js';
import { unifiedDiff } from '../src/diff.js';
import { createBeforeLlmHook } from '../src/hook.js';
import { createDocSubscriptionPlugin } from '../src/index.js';
import type { SessionSubscriptionState, SubscriptionEntry } from '../src/store.js';
import { SubscriptionStore } from '../src/store.js';
import { createSubscribeTool } from '../src/tool.js';

const tempDirs: string[] = [];

/** 新建临时目录并登记清理 */
function makeTemp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vessel-sub-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶发占用：留给系统临时目录清理
    }
  }
});

/** 组装一套 config / boundary / store / tool / hook */
function setup(overrides: Record<string, unknown> = {}) {
  const base = makeTemp();
  const stateDir = path.join(base, 'state');
  const config = parseDocSubscriptionConfig({
    cwd: base,
    state_dir: stateDir,
    allowed_roots: [base],
    max_full_bytes: 100_000,
    ...overrides,
  });
  const boundary = buildPathBoundary({
    allowedRoots: config.allowedRoots,
    denyPaths: config.denyPaths,
    cwd: config.cwd,
  });
  const store = new SubscriptionStore(config.stateDir);
  const tool = createSubscribeTool({ boundary, store, config });
  const hook = createBeforeLlmHook({ boundary, store, config });
  return { base, stateDir, config, boundary, store, tool, hook };
}

/** 最小 ToolContext（工具不使用 events / messages） */
function toolCtx(sessionId = 'session'): ToolContext {
  return {
    session_id: sessionId,
    run_id: 'tool-run',
    messages: [],
    events: {} as ToolContext['events'],
  };
}

/** 直接调用工具 handler */
async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  sessionId = 'session',
): Promise<string> {
  return tool.handler(args, toolCtx(sessionId));
}

/** 最小 HookContext */
function hookCtx(runId: string, sessionId = 'session'): HookContext {
  return { run_id: runId, session_id: sessionId };
}

/** 跑一次 hook；断言它从不写 ctx.messages；返回 additionalContext（无通知时为空串） */
async function hookNotice(hook: Hook, runId: string, sessionId = 'session'): Promise<string> {
  const ctx = hookCtx(runId, sessionId);
  const result = await hook.run(ctx);
  expect(ctx.messages).toBeUndefined();
  if (result === undefined) return '';
  return typeof result.additionalContext === 'string' ? result.additionalContext : '';
}

/** 取数组中指定元素；缺失即测试失败（避免 `!` 断言） */
function at<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}`);
  return item;
}

/** 取唯一订阅条目 */
function onlyEntry(state: SessionSubscriptionState): SubscriptionEntry {
  return at(Object.values(state.subscriptions), 0);
}

describe('subscribe tool', () => {
  test('add / list / remove round-trip', async () => {
    const { base, tool } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'hello\n', 'utf-8');

    const added = await runTool(tool, { action: 'add', path: file });
    expect(added).toContain('added 1');
    expect(added).toContain('inspect');

    const listed = await runTool(tool, { action: 'list' });
    expect(listed).toContain(canonicalPath(file));
    expect(listed).toContain('pending');
    expect(listed).toContain('unread');

    const removed = await runTool(tool, { action: 'remove', path: file });
    expect(removed).toContain('removed:');
    expect(await runTool(tool, { action: 'list' })).toBe('no subscriptions');
  });

  test('remove by id and unknown id', async () => {
    const { base, tool, store } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'hello\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });
    const id = onlyEntry(await store.load('session')).id;

    expect(await runTool(tool, { action: 'remove', id })).toContain('removed:');
    expect(await runTool(tool, { action: 'remove', id: 'missing' })).toContain('not_found');
  });

  test('invalid action', async () => {
    const { tool } = setup();
    expect(await runTool(tool, { action: 'bogus' })).toContain('add / remove / list / inspect');
  });

  test('rejects wildcard, directory, missing, denied, outside roots, sensitive name', async () => {
    const outside = makeTemp();
    const outsideFile = path.join(outside, 'outside.txt');
    writeFileSync(outsideFile, 'outside\n', 'utf-8');
    const { base, tool } = setup();
    const directory = path.join(base, 'dir');
    mkdirSync(directory);
    const sensitive = path.join(base, '.env');
    writeFileSync(sensitive, 'SECRET=1\n', 'utf-8');

    const output = await runTool(tool, {
      action: 'add',
      paths: [
        path.join(base, '*.ts'),
        directory,
        path.join(base, 'missing.txt'),
        path.join(homedir(), '.ssh', 'id_rsa'),
        outsideFile,
        sensitive,
      ],
    });

    expect(output).toContain('wildcard:');
    expect(output).toContain('not_found:');
    expect(output).toContain('not_a_file:');
    expect(output).toContain('path_denied:');
    expect(output).toContain('path_outside_allowed_roots:');
    expect(output).toContain('sensitive:');
    expect(output).not.toContain('added ');
  });
});

describe('BeforeLlm notice', () => {
  test('notice contains metadata only, never content or diff, and never writes ctx.messages', async () => {
    const { base, tool, hook } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'SECRET-CONTENT\nline two\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    const notice = await hookNotice(hook, 'run-1');
    expect(notice).toContain('<subscription-notice>');
    expect(notice).toContain(canonicalPath(file));
    expect(notice).toContain('id=');
    expect(notice).toContain('rev="sha256:');
    expect(notice).toContain('bytes=');
    expect(notice).toContain('inspect');
    expect(notice).not.toContain('SECRET-CONTENT');
    expect(notice).not.toContain('@@');
  });

  test('same rev is not notified twice; a new change notifies again', async () => {
    const { base, tool, hook } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'one\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    const first = await hookNotice(hook, 'run-1');
    expect(first).toContain('Subscribed files changed: 1');
    expect(await hookNotice(hook, 'run-2')).toBe('');

    writeFileSync(file, 'two\n', 'utf-8');
    const third = await hookNotice(hook, 'run-3');
    expect(third).toContain('Subscribed files changed: 1');
    expect(third).not.toContain('two');
  });

  test('per-run guard: same run_id only checks once', async () => {
    const { base, tool, hook } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'one\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    expect(await hookNotice(hook, 'run-1')).not.toBe('');
    writeFileSync(file, 'two\n', 'utf-8');
    expect(await hookNotice(hook, 'run-1')).toBe('');
    expect(await hookNotice(hook, 'run-2')).not.toBe('');
  });

  test('session isolation', async () => {
    const { base, tool, hook } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'one\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file }, 'session-a');

    expect(await hookNotice(hook, 'run-1', 'session-b')).toBe('');
    expect(await hookNotice(hook, 'run-2', 'session-a')).not.toBe('');
  });

  test('no subscriptions means no notice', async () => {
    const { hook } = setup();
    expect(await hookNotice(hook, 'run-1')).toBe('');
  });

  test('notice caps the file list and summarizes the rest', async () => {
    const { base, tool, hook } = setup();
    const paths: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const file = path.join(base, `doc-${index}.md`);
      writeFileSync(file, `content ${index}\n`, 'utf-8');
      paths.push(file);
    }
    await runTool(tool, { action: 'add', paths });

    const notice = await hookNotice(hook, 'run-1');
    expect(notice).toContain('Subscribed files changed: 25');
    expect(notice).toContain('... and 5 more');
  });
});

describe('subscribe inspect', () => {
  test('first inspect returns full content and advances seen_rev; second returns none', async () => {
    const { base, tool, hook, store } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'line one\nline two\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });
    await hookNotice(hook, 'run-1');

    const full = await runTool(tool, { action: 'inspect', path: file });
    expect(full).toContain('change="full"');
    expect(full).toContain('line one');
    const before = onlyEntry(await store.load('session'));
    expect(before.seen_rev).not.toBe('');
    expect(before.seen_rev).toBe(before.rev);
    expect(await runTool(tool, { action: 'list' })).toContain('read');

    const none = await runTool(tool, { action: 'inspect', path: file });
    expect(none).toContain('change="none"');
    expect(none).not.toContain('line one');
  });

  test('inspect after a change returns a diff and advances seen_rev', async () => {
    const { base, tool, hook, store } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'line one\nline two\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });
    await hookNotice(hook, 'run-1');
    await runTool(tool, { action: 'inspect', path: file });

    writeFileSync(file, 'line one changed\nline two\nline three\n', 'utf-8');
    const notice = await hookNotice(hook, 'run-2');
    expect(notice).toContain('rev="sha256:');

    const diff = await runTool(tool, { action: 'inspect', path: file });
    expect(diff).toContain('change="diff"');
    expect(diff).toContain('-line one');
    expect(diff).toContain('+line one changed');
    const after = onlyEntry(await store.load('session'));
    expect(after.seen_rev).toBe(after.rev);
  });

  test('inspect by id; unknown id is not_found', async () => {
    const { base, tool, store } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'hello\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });
    const id = onlyEntry(await store.load('session')).id;

    expect(await runTool(tool, { action: 'inspect', id })).toContain('change="full"');
    expect(await runTool(tool, { action: 'inspect', id: 'missing' })).toContain('not_found');
  });

  test('inspect over maxFullBytes does not advance seen_rev', async () => {
    const { base, tool, hook, store } = setup({ max_full_bytes: 10 });
    const file = path.join(base, 'big.txt');
    writeFileSync(file, '01234567890123456789', 'utf-8');
    await runTool(tool, { action: 'add', path: file });
    await hookNotice(hook, 'run-1');

    const output = await runTool(tool, { action: 'inspect', path: file });
    expect(output).toContain('status="too_large"');
    expect(output).toContain('use read');
    expect(onlyEntry(await store.load('session')).seen_rev).toBe('');
    expect(await runTool(tool, { action: 'list' })).toContain('unread');
  });

  test('inspect diff overflow degrades and does not advance seen_rev', async () => {
    const { base, tool, hook, store } = setup({ max_diff_lines: 2 });
    const file = path.join(base, 'doc.txt');
    writeFileSync(file, 'a\nb\nc\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });
    await hookNotice(hook, 'run-1');
    await runTool(tool, { action: 'inspect', path: file });
    const seen = onlyEntry(await store.load('session')).seen_rev;

    writeFileSync(
      file,
      `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')}\n`,
      'utf-8',
    );
    await hookNotice(hook, 'run-2');
    const output = await runTool(tool, { action: 'inspect', path: file });
    expect(output).toContain('change="diff_omitted"');
    expect(output).toContain('use read');
    expect(onlyEntry(await store.load('session')).seen_rev).toBe(seen);
    expect(await runTool(tool, { action: 'list' })).toContain('unread');
  });

  test('binary inspect degrades without advancing seen_rev', async () => {
    const { base, tool, hook, store } = setup();
    const file = path.join(base, 'bin.dat');
    writeFileSync(file, Buffer.from([0x41, 0x00, 0x42]));
    await runTool(tool, { action: 'add', path: file });

    const notice = await hookNotice(hook, 'run-1');
    expect(notice).toContain('status="binary"');
    const output = await runTool(tool, { action: 'inspect', path: file });
    expect(output).toContain('status="binary"');
    expect(onlyEntry(await store.load('session')).seen_rev).toBe('');
  });

  test('deleted file notifies once and inspect advances seen_rev', async () => {
    const { base, tool, hook, store } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'hello\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });
    await hookNotice(hook, 'run-1');

    unlinkSync(file);
    const notice = await hookNotice(hook, 'run-2');
    expect(notice).toContain('status="deleted"');
    expect(await hookNotice(hook, 'run-3')).toBe('');

    const output = await runTool(tool, { action: 'inspect', path: file });
    expect(output).toContain('status="deleted"');
    expect(onlyEntry(await store.load('session')).seen_rev).toBe('deleted');
    expect(await runTool(tool, { action: 'list' })).toContain('read');
  });
});

describe('unifiedDiff', () => {
  const options = { maxBytes: 100_000, maxLines: 1000 };

  test('single changed line with context and counts', () => {
    const result = unifiedDiff('a\nb\nc\nd\ne\n', 'a\nb\nC\nd\ne\n', options);
    expect(result.text).toBe('@@ -1,5 +1,5 @@\n a\n b\n-c\n+C\n d\n e');
    expect(result.truncated).toBe(false);
  });

  test('insertion into empty file uses 0-based start', () => {
    const result = unifiedDiff('', 'hello\n', options);
    expect(result.text).toBe('@@ -0,0 +1,1 @@\n+hello');
  });

  test('identical content yields no diff', () => {
    expect(unifiedDiff('same\n', 'same\n', options).text).toBe('');
  });

  test('one-line replacement and CRLF display normalization', () => {
    expect(unifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n', options).text).toBe(
      '@@ -1,2 +1,2 @@\n a\n-b\n+c',
    );
  });

  test('marks truncated when over limits', () => {
    const result = unifiedDiff('a\n', 'b\n', { maxBytes: 1, maxLines: 1 });
    expect(result.lines).toBeGreaterThan(1);
    expect(result.truncated).toBe(true);
  });
});

describe('plugin install', () => {
  test('registers subscribe tool and one BeforeLlm hook', async () => {
    const base = makeTemp();
    const tools: ToolDefinition[] = [];
    const hooks: Hook[] = [];
    const host = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      registerHook: (hook: Hook) => hooks.push(hook),
    } as unknown as PluginHost;

    const plugin = createDocSubscriptionPlugin();
    await plugin.install(host, {
      config: { state_dir: path.join(base, 'state'), cwd: base, allowed_roots: [base] },
    });

    expect(tools.map((tool) => tool.name)).toEqual(['subscribe']);
    expect(hooks).toHaveLength(1);
    expect(at(hooks, 0).name).toBe('doc-subscription');
    expect(at(hooks, 0).type).toBe(HookType.BeforeLlm);
    const checkPermission = at(tools, 0).checkPermission;
    if (checkPermission === undefined)
      throw new Error('subscribe tool must define checkPermission');
    expect(await checkPermission({}, toolCtx())).toBe('allow');
  });

  test('enabled: false registers nothing', async () => {
    const base = makeTemp();
    const tools: ToolDefinition[] = [];
    const hooks: Hook[] = [];
    const host = {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      registerHook: (hook: Hook) => hooks.push(hook),
    } as unknown as PluginHost;

    const plugin = createDocSubscriptionPlugin();
    await plugin.install(host, {
      config: { enabled: false, state_dir: path.join(base, 'state'), cwd: base },
    });

    expect(tools).toHaveLength(0);
    expect(hooks).toHaveLength(0);
  });
});
