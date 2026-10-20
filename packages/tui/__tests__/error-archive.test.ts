/**
 * 失败归档守卫（0.10 R1-11）
 *
 * - 失败只产生一条历史项（fallback 在已归档时返回 null）；
 * - 错误项是纯文本 danger，不再按 Markdown 归档原始 error；
 * - 超过 8 行 / 500 字符时截断，fullText 保留完整内容。
 */

import { describe, expect, it } from 'bun:test';
import {
  buildFailureArchive,
  FAILURE_MAX_CHARS,
  FAILURE_MAX_LINES,
  failureFallbackAction,
  truncateFailureText,
} from '../src/repl/error-archive.js';

describe('buildFailureArchive', () => {
  it('正文 + 分类错误合成一条纯文本错误项', () => {
    const archive = buildFailureArchive('partial output', new Error('boom'));

    expect(archive.tone).toBe('error');
    expect(archive.markdown).toBe(false);
    expect(archive.truncated).toBe(false);
    expect(archive.fullText).toBeUndefined();
    expect(archive.text).toContain('partial output');
    expect(archive.text.match(/boom/g)).toHaveLength(1);
    expect(archive.text.split('\n').length).toBeLessThanOrEqual(FAILURE_MAX_LINES);
  });

  it('没有正文时只保留分类错误', () => {
    const archive = buildFailureArchive('   ', new Error('boom'));
    expect(archive.text).toContain('boom');
    expect(archive.text.trim().length).toBeGreaterThan(0);
  });
});

describe('truncateFailureText', () => {
  it('超过 8 行保留尾部并前置提示', () => {
    const message = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const { text, truncated } = truncateFailureText(message);

    expect(truncated).toBe(true);
    expect(text).toContain('line19');
    expect(text).not.toContain('line0\n');
    // 提示行 + 最多 8 行正文
    expect(text.split('\n').length).toBe(FAILURE_MAX_LINES + 1);
  });

  it('超过 500 字符按尾部截断', () => {
    const message = `head-${'x'.repeat(900)}-tail`;
    const { text, truncated } = truncateFailureText(message);

    expect(truncated).toBe(true);
    expect(text).toContain('-tail');
    const [hint, ...body] = text.split('\n');
    expect(hint).toContain('Ctrl+O');
    expect(body.join('\n').length).toBeLessThanOrEqual(FAILURE_MAX_CHARS);
  });

  it('未超限时原样返回', () => {
    expect(truncateFailureText('one\ntwo')).toEqual({ text: 'one\ntwo', truncated: false });
  });
});

describe('truncated archive keeps full text', () => {
  it('长错误：展示截断、fullText 完整', () => {
    const error = new Error(Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n'));
    const archive = buildFailureArchive('', error);

    expect(archive.truncated).toBe(true);
    expect(archive.fullText).toBeDefined();
    expect(archive.fullText).toContain('line0');
    expect(archive.text).not.toContain('line0\n');
  });
});

describe('failureFallbackAction', () => {
  it('StreamOutput 已归档时不再追加第二条', () => {
    expect(failureFallbackAction(true, new Error('boom'))).toBeNull();
  });

  it('事件缺失时恰好补一条 error tone', () => {
    const action = failureFallbackAction(false, new Error('boom'));
    expect(action?.type).toBe('appendHistory');
    expect(action?.tone).toBe('error');
    expect(action?.line).toContain('boom');
  });
});
