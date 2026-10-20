import { describe, expect, it } from 'bun:test';
import { type BottomBarData, formatBottomBar } from '../src/repl/status-format.js';
import { displayWidth } from '../src/utils/text-layout.js';

const base: BottomBarData = {
  autoApproveCount: 2,
  bashCount: 1,
  subagentCount: 2,
  currentSessionId: 'a1b2c3d4-e5f6-7890',
  tenantId: 'acme',
  queuedCount: 3,
  queuePreviewVisible: false,
};

function line(data: BottomBarData, columns: number): string {
  return formatBottomBar(data, columns)
    .map((segment) => segment.text)
    .join('');
}

describe('formatBottomBar 宽度分级', () => {
  it('<40 列整栏不渲染', () => {
    expect(formatBottomBar(base, 39)).toEqual([]);
    expect(formatBottomBar(base, 20)).toEqual([]);
  });

  it('40–59：perm + bash + sub，无 session/tenant/queue', () => {
    const text = line(base, 50);
    expect(text).toContain('perm ask · 2 auto');
    expect(text).toContain('bash 1');
    expect(text).toContain('sub 2');
    expect(text).not.toContain('sess');
    expect(text).not.toContain('tenant');
    expect(text).not.toContain('queue');
  });

  it('60–79 / 80–99：有 session 入口，无 tenant/queue', () => {
    for (const columns of [60, 79, 80, 99]) {
      const text = line({ ...base, autoApproveCount: 0, bashCount: 0, subagentCount: 0 }, columns);
      expect(text).toContain('sess a1b2… · Ctrl+R');
      expect(text).not.toContain('tenant');
      expect(text).not.toContain('queue');
    }
  });

  it('>=100：tenant 与 queue 出现', () => {
    const text = line(base, 120);
    expect(text).toContain('tenant acme');
    expect(text).toContain('queue 3');
  });

  it('default tenant 不显示；队列预览显示时不重复 queue', () => {
    expect(line({ ...base, tenantId: 'default' }, 120)).not.toContain('tenant');
    expect(line({ ...base, queuePreviewVisible: true }, 120)).not.toContain('queue');
  });

  it('所有宽度都不超过内容预算（CJK 也不溢出）', () => {
    for (const columns of [40, 60, 80, 100, 120, 200]) {
      const text = line({ ...base, tenantId: '租户-中文名称' }, columns);
      expect(displayWidth(text)).toBeLessThanOrEqual(columns - 6);
    }
  });
});

describe('formatBottomBar 权限与计数文案', () => {
  it('无 auto 时只显示 perm ask', () => {
    expect(line({ ...base, autoApproveCount: 0 }, 120)).toContain('perm ask');
    expect(line({ ...base, autoApproveCount: 0 }, 120)).not.toContain('auto');
  });

  it('等待确认时显示 waiting <tool>，不显示 auto', () => {
    const text = line({ ...base, waitingTool: 'bash' }, 120);
    expect(text).toContain('perm ask · waiting bash');
    expect(text).not.toContain('auto');
    expect(formatBottomBar({ ...base, waitingTool: 'bash' }, 120)[0]?.tone).toBe('statusWarn');
  });

  it('bash / sub 只在实际运行时出现', () => {
    expect(line({ ...base, bashCount: 0 }, 120)).not.toContain('bash');
    expect(line({ ...base, subagentCount: 0 }, 120)).not.toContain('sub ');
  });
});

describe('formatBottomBar 固定丢弃顺序', () => {
  it('tenant → queue → session 依次丢弃，sub 保留', () => {
    const text = line(
      { ...base, waitingTool: 'mcp__server__a_very_long_tool_name_for_tests' },
      100,
    );
    expect(text).toContain('perm ask · waiting');
    expect(text).not.toContain('tenant');
    expect(text).not.toContain('queue');
    expect(text).not.toContain('sess');
    expect(text).toContain('sub 2');
  });

  it('继续超宽时丢弃 sub；perm 仍在', () => {
    const text = line(
      {
        ...base,
        waitingTool:
          'mcp__very_long_server_name__another_extremely_long_tool_name_that_keeps_growing',
      },
      100,
    );
    expect(text.startsWith('perm ask · waiting')).toBe(true);
    expect(text).not.toContain('sess');
    expect(text).not.toContain('sub ');
    expect(displayWidth(text)).toBeLessThanOrEqual(94);
  });
});

describe('formatBottomBar 分隔符', () => {
  it('字段之间使用 ` │ ` 分隔', () => {
    const segments = formatBottomBar(base, 120);
    const separators = segments.filter((segment) => segment.text === ' │ ');
    expect(separators.length).toBeGreaterThan(0);
    expect(separators.every((segment) => segment.tone === 'faint')).toBe(true);
  });
});
