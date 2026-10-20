import { describe, expect, it } from 'bun:test';
import { summarizeToolInput } from '../src/utils/tool-input-summary.js';

describe('summarizeToolInput', () => {
  it('bash -> 显示命令与 cwd', () => {
    expect(summarizeToolInput('bash', { command: 'rm -rf build', cwd: '/tmp' })).toEqual([
      '$ rm -rf build',
      'cwd: /tmp',
    ]);
  });

  it('bash 长命令被截断', () => {
    const [line] = summarizeToolInput('bash', { command: 'x'.repeat(300) });
    expect(line?.endsWith('…')).toBe(true);
    expect(line?.length).toBeLessThan(210);
  });

  it('read -> path 与 offset/limit', () => {
    expect(summarizeToolInput('read', { path: 'a.ts', offset: 10, limit: 20 })).toEqual([
      'path: a.ts (offset 10, limit 20)',
    ]);
  });

  it('edit -> path + 被替换片段', () => {
    expect(
      summarizeToolInput('edit', { path: 'a.ts', old_string: 'foo()', new_string: 'bar()' }),
    ).toEqual(['path: a.ts', '- foo()']);
  });

  it('delegate_task -> task', () => {
    expect(summarizeToolInput('delegate_task', { task: '查资料' })).toEqual(['task: 查资料']);
  });

  it('未知工具 -> JSON 摘要', () => {
    expect(summarizeToolInput('other', { a: 1 })).toEqual(['{"a":1}']);
  });
});
