import { describe, expect, it } from 'bun:test';
import { formatResumeHistory } from '../src/commands/commands.js';

/** 取标题行（实现会在标题前插入一个空行）。 */
function title(lines: string[]): string {
  return lines.find((line) => line.startsWith('── history')) ?? '';
}

/** 取出所有消息内容行（跳过标题/空行），剥离角色前缀。 */
function bodies(lines: string[]): string[] {
  return lines
    .filter((line) => line.includes('│'))
    .map((line) => line.slice(line.indexOf('│') + 1).trimStart());
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

  it('订阅注入消息不出现在 resume 历史里', () => {
    const lines = formatResumeHistory([
      { role: 'user', content: 'hello' },
      {
        role: 'user',
        name: 'subscription:abc123',
        content: '<subscription path="a.md" change="diff">+x</subscription>',
      },
      { role: 'assistant', content: 'hi there' },
    ]);

    expect(lines.join('\n')).not.toContain('<subscription');
    expect(title(lines)).toContain('last 2 messages');
    expect(bodies(lines)).toEqual(['hello', 'hi there']);
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

  it('三种角色使用 you/ai/tool 前缀并保持消息顺序', () => {
    const lines = formatResumeHistory([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', content: 't' },
    ]);
    const contentLines = lines.filter((line) => line.includes('│'));

    expect(contentLines).toHaveLength(3);
    contentLines.forEach((line, index) => {
      const role = ['you', 'ai', 'tool'][index] ?? '';
      expect(line).toContain(role);
      expect(bodies([line])[0]).toBe(['u', 'a', 't'][index] ?? '');
    });
  });

  it('assistant tool_calls 显示工具名与参数摘要（否则恢复后看不出调用过什么）', () => {
    const lines = formatResumeHistory([
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          {
            id: 'c1',
            function: { name: 'bash', arguments: '{"command":"ls -la"}' },
          },
        ],
      },
    ]);
    const joined = lines.join('\n');
    expect(joined).toContain('tool_calls: bash({"command":"ls -la"})');
  });

  it('reasoning 默认隐藏，显式开启才展示', () => {
    const message = {
      role: 'assistant' as const,
      content: 'answer',
      reasoning_content: 'private chain of thought',
    };
    expect(formatResumeHistory([message]).join('\n')).not.toContain('private chain of thought');
    expect(formatResumeHistory([message], { showReasoning: true }).join('\n')).toContain(
      '[reasoning] private chain of thought',
    );
  });

  it('多行内容用 │ 续行', () => {
    const lines = formatResumeHistory([{ role: 'user', content: 'first\nsecond\nthird' }]);
    const contentLines = lines.filter((line) => line.includes('│'));

    expect(contentLines).toHaveLength(3);
    const first = contentLines[0] ?? '';
    expect(first).toContain('you');
    expect(bodies([first])[0]).toBe('first');

    for (const [index, text] of ['second', 'third'].entries()) {
      const line = contentLines[index + 1] ?? '';
      expect(line.trimStart().startsWith('│')).toBe(true);
      expect(line).toContain(text);
    }
  });
});
