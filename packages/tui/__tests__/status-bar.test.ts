import { describe, expect, it } from 'bun:test';
import { formatStatusLine, type StatusBarProps } from '../src/components/StatusBar';

const props: StatusBarProps = {
  provider: {
    name: 'custom',
    model: 'deepseek/deepseek-flash',
    baseUrl: '',
  },
  session: '20261018_230506_830174',
  plugins: ['a', 'b', 'c', 'd', 'e'],
  tenant: 'default',
};

/** 测试用显示宽度：CJK 按 2 列计，其它按 1 列。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return width;
}

describe('formatStatusLine', () => {
  it('窄终端不溢出，并始终保留 session', () => {
    for (const columns of [40, 60, 80]) {
      const line = formatStatusLine(props, columns);
      expect(displayWidth(line)).toBeLessThanOrEqual(columns - 4);
      expect(line).toContain('session:');
    }
  });

  it('宽终端下 CJK 内容完整显示且不超列数', () => {
    const line = formatStatusLine(
      {
        provider: { name: 'custom', model: '深度求索-模型', baseUrl: '' },
        session: '会话_20261018_230506_830174',
        plugins: ['a', 'b', 'c', 'd', 'e'],
        tenant: '默认租户',
      },
      140,
    );

    expect(displayWidth(line)).toBeLessThanOrEqual(140);
    expect(line).not.toContain('…');
    expect(line).toContain('深度求索-模型');
    expect(line).toContain('默认租户');
    expect(line).toContain('会话_20261018_230506_830174');
    expect(line).toContain('plugins: 5');
  });
});
