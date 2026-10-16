/**
 * `@path` 文件引用展开测试（C10）
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFileReferences, MAX_FILE_BYTES } from '../src/utils/file-reference.js';

let dir: string;
let alpha: string;
let beta: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vessel-fileref-'));
  alpha = join(dir, 'alpha.md');
  beta = join(dir, 'beta.md');
  writeFileSync(alpha, 'hello\nworld');
  writeFileSync(beta, 'B');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('collectFileReferences', () => {
  it('单个 @path -> 一条 user 消息，内容包在 <file> 里', () => {
    const { messages, warnings } = collectFileReferences(`看一下 @${alpha} 再回答`);
    expect(warnings).toEqual([]);
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe(`<file path="${alpha}">\nhello\nworld\n</file>`);
  });

  it('多个 @path 按出现顺序注入', () => {
    const { messages } = collectFileReferences(`@${beta} 和 @${alpha}`);
    expect(messages.length).toBe(2);
    expect(messages[0]?.content).toContain(`path="${beta}"`);
    expect(messages[0]?.content).toContain('B');
    expect(messages[1]?.content).toContain(`path="${alpha}"`);
  });

  it('行首（换行后）的 @ 也匹配', () => {
    const { messages } = collectFileReferences(`第一行\n@${beta}\n第三行`);
    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toContain(`path="${beta}"`);
  });

  it('文件不存在 -> 记 warning 并跳过，不影响其它 token', () => {
    const missing = join(dir, 'nope.md');
    const { messages, warnings } = collectFileReferences(`@${missing} @${beta}`);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(missing);
    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toContain(`path="${beta}"`);
  });

  it('不匹配 email 里的 @', () => {
    const { messages, warnings } = collectFileReferences('mail me at a@b.com or c@d.org');
    expect(messages).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('同一路径重复出现 -> 各生成一条（不去重）', () => {
    const { messages } = collectFileReferences(`@${beta} again @${beta}`);
    expect(messages.length).toBe(2);
    expect(messages[0]?.content).toBe(messages[1]?.content);
  });

  it('无 @ 引用 -> 空结果', () => {
    const { messages, warnings } = collectFileReferences('just a normal message');
    expect(messages).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('超过 100KB 的文件被截断并标注', () => {
    const big = join(dir, 'big.md');
    const size = MAX_FILE_BYTES + 5000;
    writeFileSync(big, 'x'.repeat(size));
    const { messages } = collectFileReferences(`@${big}`);
    expect(messages.length).toBe(1);
    const content = messages[0]?.content ?? '';
    expect(content).toContain('[truncated:');
    expect(content).toContain(String(size));
    expect(content.endsWith('</file>')).toBe(true);
    // 正文恰好截到上限（标注行另计）
    const prefix = `<file path="${big}">\n`;
    expect(content.startsWith(prefix)).toBe(true);
    const body = content.slice(prefix.length, content.lastIndexOf('\n[truncated:'));
    expect(body).toBe('x'.repeat(MAX_FILE_BYTES));
  });

  it('读取失败（目录）-> warning 而非抛错', () => {
    const sub = join(dir, 'subdir');
    mkdirSync(sub, { recursive: true });
    const { messages, warnings } = collectFileReferences(`@${sub}`);
    expect(messages).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(sub);
  });
});
