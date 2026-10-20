/**
 * `@path` 文件引用展开测试（C10）
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectFileReferences,
  expandHome,
  MAX_FILE_BYTES,
  resolveReferencePath,
} from '../src/utils/file-reference.js';

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

  it('路径尾部的中文标点被剥掉（`@a.md，请继续`）', () => {
    const { messages, warnings } = collectFileReferences(`@${alpha}，请继续`);
    expect(warnings).toEqual([]);
    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toBe(`<file path="${alpha}">\nhello\nworld\n</file>`);
  });

  it('半角标点与连续标点都被剥掉', () => {
    const half = collectFileReferences(`see @${beta}, okay`);
    expect(half.warnings).toEqual([]);
    expect(half.messages[0]?.content).toContain(`path="${beta}"`);

    const many = collectFileReferences(`见 @${alpha}。）】」』、`);
    expect(many.warnings).toEqual([]);
    expect(many.messages.length).toBe(1);
    expect(many.messages[0]?.content).toContain(`path="${alpha}"`);
  });

  it('token 全是标点 -> 当普通文本跳过', () => {
    // 半角：剥尾后为空
    const half = collectFileReferences('只是 @... 而已');
    expect(half.messages).toEqual([]);
    expect(half.warnings).toEqual([]);

    // 全角：截断后为空
    const full = collectFileReferences('只是 @。 而已');
    expect(full.messages).toEqual([]);
    expect(full.warnings).toEqual([]);
  });

  it('路径中间的半角点/连字符不被截断（只截全角标点）', () => {
    const nestedDir = join(dir, 'nested.d');
    const nested = join(nestedDir, 'code-writing.md');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(nested, 'skill body');

    const { messages, warnings } = collectFileReferences(`@${nested}，请按这个来`);
    expect(warnings).toEqual([]);
    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toContain(`path="${nested}"`);
    expect(messages[0]?.content).toContain('skill body');
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

describe('@path 边界与解析（0.1.0）', () => {
  it('开括号 / 引号后的 @ 也匹配', () => {
    const cases = [
      `(@${alpha})`,
      `[@${beta}]`,
      `（@${alpha}）`,
      `"@${beta}"`,
      `'@${alpha}'`,
      `{@${beta}}`,
      `《@${alpha}》`,
    ];
    for (const input of cases) {
      const { messages, warnings } = collectFileReferences(input);
      expect(warnings).toEqual([]);
      expect(messages.length).toBe(1);
    }
  });

  it('扩展的全角收尾标点被剥掉', () => {
    for (const punct of ['”', '’', '》', '〉', '］', '｝', '】', '…', '～']) {
      const { messages, warnings } = collectFileReferences(` @${alpha}${punct}`);
      expect(warnings).toEqual([]);
      expect(messages.length).toBe(1);
      expect(messages[0]?.content).toContain(`path="${alpha}"`);
    }
  });

  it(':行[:列] 后缀被解析为文件', () => {
    const { messages, warnings } = collectFileReferences(` @${alpha}:12`);
    expect(warnings).toEqual([]);
    expect(messages[0]?.content).toContain(`path="${alpha}"`);
    const withCol = collectFileReferences(` @${alpha}:12:3`);
    expect(withCol.messages[0]?.content).toContain(`path="${alpha}"`);
  });

  it('#anchor 后缀被解析为文件；文件本身含 # 时优先原样', () => {
    const anchored = collectFileReferences(` @${alpha}#section`);
    expect(anchored.warnings).toEqual([]);
    expect(anchored.messages[0]?.content).toContain(`path="${alpha}"`);

    const hashFile = join(dir, 'hash#1.md');
    writeFileSync(hashFile, 'hash name');
    const realHash = collectFileReferences(` @${hashFile}`);
    expect(realHash.warnings).toEqual([]);
    expect(realHash.messages[0]?.content).toContain(`path="${hashFile}"`);
  });

  it('resolveReferencePath 同时去掉 :line 与 #anchor', () => {
    expect(resolveReferencePath(`${alpha}:12`)).toBe(alpha);
    expect(resolveReferencePath(`${alpha}#x`)).toBe(alpha);
    expect(resolveReferencePath(`${alpha}:12#x`)).toBe(alpha);
    expect(resolveReferencePath(alpha)).toBe(alpha);
  });

  it('~ 展开为 home 目录', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/notes.md')).toBe(join(homedir(), 'notes.md'));
    expect(expandHome('~\\notes.md')).toBe(join(homedir(), 'notes.md'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });

  it('二进制文件被跳过并 warning', () => {
    const bin = join(dir, 'binary.dat');
    writeFileSync(bin, Buffer.from([1, 0, 2, 3]));
    const { messages, warnings } = collectFileReferences(` @${bin}`);
    expect(messages).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('binary');
  });

  it('references 返回成功注入的文件信息', () => {
    const { references } = collectFileReferences(` @${alpha}`);
    expect(references).toEqual([{ path: alpha, bytes: 11, truncated: false }]);
  });
});
