/**
 * doc-subscription 插件测试：工具 round-trip、拒绝项、hook 注入 / 去重 / 隔离、diff 单元。
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildPathBoundary } from '@vessel-agent/basic-tools';
import type {
  Hook,
  HookContext,
  Message,
  PluginHost,
  ToolContext,
  ToolDefinition,
} from '@vessel-agent/core';
import { HookType } from '@vessel-agent/core';
import { parseDocSubscriptionConfig } from '../src/config.js';
import { unifiedDiff } from '../src/diff.js';
import { createBeforeLlmHook } from '../src/hook.js';
import { createDocSubscriptionPlugin } from '../src/index.js';
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

/** 取数组中指定元素；缺失即测试失败（避免 `!` 断言） */
function at<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}`);
  return item;
}

describe('subscribe tool', () => {
  test('add / list / remove round-trip', async () => {
    const { base, tool, store } = setup();
    const file = path.join(base, 'notes.txt');
    writeFileSync(file, 'hello\n', 'utf-8');

    const added = await runTool(tool, { action: 'add', path: file });
    expect(added).toContain('added 1:');
    expect(added).toContain(file);

    const listed = await runTool(tool, { action: 'list' });
    expect(listed).toContain(file);
    expect(listed).toContain('rev=never');
    expect(listed).toContain('bytes=6');

    const state = await store.load('session');
    const entries = Object.values(state.subscriptions);
    expect(entries).toHaveLength(1);
    const id = at(entries, 0).id;

    const removed = await runTool(tool, { action: 'remove', id });
    expect(removed).toContain('removed:');
    expect(await runTool(tool, { action: 'list' })).toBe('no subscriptions');
  });

  test('remove by path and unknown id', async () => {
    const { base, tool } = setup();
    const file = path.join(base, 'a.txt');
    writeFileSync(file, 'a\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    expect(await runTool(tool, { action: 'remove', path: file })).toContain('removed:');
    expect(await runTool(tool, { action: 'remove', id: 'deadbeef0000' })).toContain('not_found');
    expect(await runTool(tool, { action: 'remove' })).toContain('path 或 id');
  });

  test('invalid action', async () => {
    const { tool } = setup();
    expect(await runTool(tool, { action: 'watch' })).toContain('action 必须是');
    expect(await runTool(tool, { action: 'add' })).toContain('path 或 paths');
  });

  test('rejects wildcard, directory, missing, denied, outside roots, sensitive name', async () => {
    const { base, tool } = setup();
    const outsideRoot = makeTemp();
    const outsideFile = path.join(outsideRoot, 'outside.txt');
    writeFileSync(outsideFile, 'x\n', 'utf-8');

    const dir = path.join(base, 'folder');
    mkdirSync(dir);
    const sensitive = path.join(base, '.env');
    writeFileSync(sensitive, 'SECRET=1\n', 'utf-8');

    const output = await runTool(tool, {
      action: 'add',
      paths: [
        '*.ts',
        path.join(base, 'missing.txt'),
        dir,
        path.join(homedir(), '.ssh', 'id_rsa'),
        outsideFile,
        sensitive,
      ],
    });

    expect(output).toContain('wildcard: *.ts');
    expect(output).toContain('not_found:');
    expect(output).toContain('not_a_file:');
    expect(output).toContain('path_denied:');
    expect(output).toContain('path_outside_allowed_roots:');
    expect(output).toContain('sensitive:');
    expect(output).not.toContain('added ');
  });
});

describe('BeforeLlm hook', () => {
  test('first run injects full content, then diff, never overwrites', async () => {
    const { base, tool, hook, store } = setup();
    const file = path.join(base, 'doc.md');
    writeFileSync(file, 'line one\nline two\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    const ctx = hookCtx('run-1');
    ctx.messages = [{ role: 'user', content: 'existing question' }];
    await hook.run(ctx);

    expect(ctx.messages).toHaveLength(2);
    expect(at(ctx.messages, 0).content).toBe('existing question');
    const first = at<Message>(ctx.messages, 1);
    expect(first.role).toBe('user');
    expect(first.name?.startsWith('subscription:')).toBe(true);
    expect(first.content).toContain('change="full"');
    expect(first.content).toContain('line one');

    // 未变化的下一个 run：不注入
    const unchanged = hookCtx('run-2');
    await hook.run(unchanged);
    expect(unchanged.messages ?? []).toHaveLength(0);

    // 修改后：注入 diff，并保留新快照
    writeFileSync(file, 'line one changed\nline two\nline three\n', 'utf-8');
    const changed = hookCtx('run-3');
    await hook.run(changed);
    expect(changed.messages).toHaveLength(1);
    const diffContent = at(changed.messages, 0).content;
    expect(diffContent).toContain('change="diff"');
    expect(diffContent).toContain('-line one');
    expect(diffContent).toContain('+line one changed');
    expect(diffContent).toContain('+line three');

    const state = await store.load('session');
    expect(at(Object.values(state.subscriptions), 0).snapshot).toBe(
      'line one changed\nline two\nline three\n',
    );
  });

  test('diff overflow degrades to diff_omitted', async () => {
    const { base, tool, hook } = setup({ max_diff_lines: 2 });
    const file = path.join(base, 'big.txt');
    const original = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(file, `${original}\n`, 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    await hook.run(hookCtx('run-1'));

    const updated = Array.from({ length: 10 }, (_, i) => `changed ${i}`).join('\n');
    writeFileSync(file, `${updated}\n`, 'utf-8');
    const ctx = hookCtx('run-2');
    await hook.run(ctx);

    expect(ctx.messages).toHaveLength(1);
    const content = at(ctx.messages, 0).content;
    expect(content).toContain('change="diff_omitted"');
    expect(content).toContain('`read ');
  });

  test('large file notice (maxFullBytes)', async () => {
    const { base, tool, hook } = setup({ max_full_bytes: 10 });
    const file = path.join(base, 'large.txt');
    writeFileSync(file, 'x'.repeat(100), 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    const ctx = hookCtx('run-1');
    await hook.run(ctx);
    expect(ctx.messages).toHaveLength(1);
    expect(at(ctx.messages, 0).content).toContain('status="too_large"');
  });

  test('binary file notice', async () => {
    const { base, tool, hook } = setup();
    const file = path.join(base, 'blob.bin');
    writeFileSync(file, Buffer.from([0x41, 0x00, 0x42]));
    await runTool(tool, { action: 'add', path: file });

    const ctx = hookCtx('run-1');
    await hook.run(ctx);
    expect(ctx.messages).toHaveLength(1);
    expect(at(ctx.messages, 0).content).toContain('status="binary"');
    expect(at(ctx.messages, 0).content).not.toContain('ABC');
  });

  test('deleted file injects once', async () => {
    const { base, tool, hook } = setup();
    const file = path.join(base, 'gone.txt');
    writeFileSync(file, 'bye\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    await hook.run(hookCtx('run-1'));
    unlinkSync(file);

    const deleted = hookCtx('run-2');
    await hook.run(deleted);
    expect(deleted.messages).toHaveLength(1);
    expect(at(deleted.messages, 0).content).toContain('status="deleted"');

    const again = hookCtx('run-3');
    await hook.run(again);
    expect(again.messages ?? []).toHaveLength(0);
  });

  test('per-run guard: same run_id only checks once', async () => {
    const { base, tool, hook } = setup();
    const file = path.join(base, 'once.txt');
    writeFileSync(file, 'once\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file });

    const first = hookCtx('run-same');
    await hook.run(first);
    expect(first.messages).toHaveLength(1);

    const second = hookCtx('run-same');
    await hook.run(second);
    expect(second.messages ?? []).toHaveLength(0);
  });

  test('session isolation', async () => {
    const { base, tool, hook } = setup();
    const file = path.join(base, 'isolated.txt');
    writeFileSync(file, 'only A\n', 'utf-8');
    await runTool(tool, { action: 'add', path: file }, 'session-A');

    const sessionB = hookCtx('run-b', 'session-B');
    await hook.run(sessionB);
    expect(sessionB.messages ?? []).toHaveLength(0);

    const sessionA = hookCtx('run-a', 'session-A');
    await hook.run(sessionA);
    expect(sessionA.messages).toHaveLength(1);
  });

  test('no subscriptions means no injection', async () => {
    const { hook } = setup();
    const ctx = hookCtx('run-empty');
    await hook.run(ctx);
    expect(ctx.messages ?? []).toHaveLength(0);
  });
});

describe('unifiedDiff', () => {
  const options = { maxBytes: 100_000, maxLines: 1_000 };

  test('single changed line with context and counts', () => {
    const result = unifiedDiff('a\nb\nc\n', 'a\nX\nc\n', options);
    expect(result.text).toContain('@@ -1,3 +1,3 @@');
    expect(result.text).toContain(' a');
    expect(result.text).toContain('-b');
    expect(result.text).toContain('+X');
    expect(result.text).toContain(' c');
    expect(result.truncated).toBe(false);
  });

  test('insertion into empty file uses 0-based start', () => {
    const result = unifiedDiff('', 'x\n', options);
    expect(result.text).toContain('@@ -0,0 +1,1 @@');
    expect(result.text).toContain('+x');
  });

  test('identical content yields no diff', () => {
    const result = unifiedDiff('a\nb\n', 'a\nb\n', options);
    expect(result).toEqual({ text: '', lines: 0, bytes: 0, truncated: false });
  });

  test('one-line replacement and CRLF display normalization', () => {
    const result = unifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n', options);
    expect(result.text).toContain('@@ -1,2 +1,2 @@');
    expect(result.text).toContain('-b');
    expect(result.text).toContain('+c');
    expect(result.text).not.toContain('\r');
  });

  test('marks truncated when over limits', () => {
    const result = unifiedDiff('a\n', 'b\n', { maxBytes: 1_000, maxLines: 1 });
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

    await createDocSubscriptionPlugin().install(host, {
      config: { enabled: false, state_dir: path.join(base, 'state'), cwd: base },
    });
    expect(tools).toHaveLength(0);
    expect(hooks).toHaveLength(0);
  });
});
