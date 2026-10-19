import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@vessel/core';
import {
  formatSessionJson,
  formatSessionMarkdown,
  runExportCommand,
} from '../src/commands/export-command.js';
import { makeCtx, makeState } from './helpers.js';

const messages: Message[] = [
  { role: 'user', content: 'hello' },
  {
    role: 'assistant',
    content: 'running bash',
    reasoning_content: 'I should list files',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
    ],
  },
  { role: 'tool', content: 'a.txt', tool_call_id: 'c1', name: 'bash' },
];

describe('formatSessionMarkdown', () => {
  it('导出 tool_calls 与可选 reasoning；默认不泄露 reasoning', () => {
    const plain = formatSessionMarkdown('s1', messages, { exportedAt: 0 });
    expect(plain).toContain('## Assistant');
    expect(plain).toContain('`bash`');
    expect(plain).toContain('## Tool (bash)');
    expect(plain).not.toContain('I should list files');

    const withReasoning = formatSessionMarkdown('s1', messages, {
      exportedAt: 0,
      reasoning: true,
    });
    expect(withReasoning).toContain('I should list files');
  });

  it('JSON 导出保留结构化字段', () => {
    const parsed = JSON.parse(formatSessionJson('s1', messages, { exportedAt: 0 })) as {
      session_id: string;
      messages: Message[];
    };
    expect(parsed.session_id).toBe('s1');
    expect(parsed.messages[1]?.tool_calls?.[0]?.function.name).toBe('bash');
  });
});

describe('runExportCommand', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('写入指定路径并可被 JSON 解析（路径错误会静默丢导出）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vessel-export-'));
    const ctx = makeCtx();
    const sessionId = '20260101_120000_abc123';
    await ctx.session.save({
      run_id: 'run-1',
      session_id: sessionId,
      messages,
      started_at: 1,
      status: 'completed',
    });
    const state = makeState(sessionId);
    const target = join(dir, 'out.json');

    const result = await runExportCommand([target, '--json'], ctx, state);

    expect(result.output).toContain('Exported 3 message(s)');
    const parsed = JSON.parse(await readFile(target, 'utf-8')) as { session_id: string };
    expect(parsed.session_id).toBe(sessionId);
  });
});
