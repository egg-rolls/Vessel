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

describe('formatStatusLine', () => {
  it('窄终端不溢出，并始终保留 session', () => {
    for (const columns of [40, 60, 80]) {
      const line = formatStatusLine(props, columns);
      expect(line.length).toBeLessThanOrEqual(columns - 4);
      expect(line).toContain('session:');
    }
  });

  it('宽终端显示完整信息', () => {
    const line = formatStatusLine(props, 140);
    expect(line).toContain('deepseek/deepseek-flash');
    expect(line).toContain('tenant: default');
    expect(line).toContain('plugins: 5');
  });
});
