import { describe, expect, it } from 'bun:test';
import { formatResumeHistory } from '../src/commands/commands.js';

/** 取标题行（实现会在标题前插入一个空行）。 */
function title(lines: string[]): string {
  return lines.find((line) => line.startsWith('── history')) ?? '';
}

/** 取出所有消息内容行（跳过标题/空行），并按实现的前缀剥离。 */
function bodies(lines: string[]): string[] {
  return lines
    .filter((line) => line.includes('│'))
    .map((line) => line.slice(line.indexOf('│') + 2));
}

describe('formatResumeHistory（/resume 历史回灌）', () => {
  it('过滤 system 消息，只展示可见消息', () => {
    const lines = formatResumeHistory([
      { role: 'system', content: 'secret instructions' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'tool', content: 'tool output' },
    ]);

    expect(lines.join('\n')).not.toContain('secret instructions');
    expect(title(lines)).toContain('last 3 messages');
    expect(bodies(lines)).toEqual(['hello', 'hi there', 'tool output']);
  });

  it('空数组或只有 system 消息时返回空数组', () => {
    expect(formatResumeHistory([])).toEqual([]);
    expect(
      formatResumeHistory([
        { role: 'system', content: 'a' },
        { role: 'system', content: 'b' },
      ]),
    ).toEqual([]);
  });

  it('超过 20 条时只保留最后 20 条，标题带 of', () => {
    const messages = Array.from({ length: 25 }, (_, index) => ({
      role: 'user',
      content: `msg-${index}`,
    }));

    const lines = formatResumeHistory(messages);

    expect(title(lines)).toContain('last 20 of 25 messages');
    expect(bodies(lines)).toHaveLength(20);
    expect(bodies(lines)[0]).toBe('msg-5');
    expect(bodies(lines)[19]).toBe('msg-24');
    expect(lines.join('\n')).not.toContain('msg-0 ');
    expect(lines.join('\n')).not.toContain('msg-4 ');
  });

  it('超过 600 字符的内容截断到 600 并追加 …', () => {
    const lines = formatResumeHistory([{ role: 'user', content: 'x'.repeat(700) }]);
    const body = bodies(lines)[0] ?? '';

    expect(body).toHaveLength(601);
    expect(body.endsWith('…')).toBe(true);
    expect(body.slice(0, -1)).toBe('x'.repeat(600));
  });

  it('恰好 600 字符不截断', () => {
    const content = 'a'.repeat(600);
    const body = bodies(formatResumeHistory([{ role: 'user', content }]))[0] ?? '';

    expect(body).toBe(content);
    expect(body).not.toContain('…');
  });

  it('三种角色使用 you/ai /tool 前缀并保持消息顺序', () => {
    const lines = formatResumeHistory([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', content: 't' },
    ]);
    const contentLines = lines.filter((line) => line.includes('│'));

    expect(contentLines[0]).toBe('  you  │ u');
    expect(contentLines[1]).toBe('  ai   │ a');
    expect(contentLines[2]).toBe('  tool │ t');
  });

  it('多行内容用 │ 续行', () => {
    const lines = formatResumeHistory([{ role: 'user', content: 'first\nsecond\nthird' }]);

    expect(lines).toContain('  you  │ first');
    expect(lines).toContain('       │ second');
    expect(lines).toContain('       │ third');
  });
});
