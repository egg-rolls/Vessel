import { describe, expect, it } from 'bun:test';
import {
  type CommandItem,
  decideCommandEnter,
  filterCommands,
  getVisibleCommandWindow,
  MAX_VISIBLE_COMMANDS,
} from '../src/components/InlineAutocomplete.js';

/** 构造测试用命令列表 */
function sampleCommands(): CommandItem[] {
  return [
    {
      name: '/resume',
      description: '恢复会话',
      usage: '/resume [number|id]',
    },
    { name: '/reload', description: '重载配置', usage: '/reload' },
    { name: '/help', description: '显示帮助 resume', usage: '/help' },
    { name: '/exit', description: '退出', usage: '/exit' },
  ];
}

describe('filterCommands', () => {
  it('空 filter 返回全部', () => {
    const all = sampleCommands();
    expect(filterCommands(all, '')).toHaveLength(all.length);
  });

  it('子串匹配（大小写不敏感）', () => {
    const filtered = filterCommands(sampleCommands(), 'RES');
    expect(filtered.map((c) => c.name)).toContain('/resume');
  });

  it('命令名匹配排在描述匹配之前', () => {
    // "resume" 命中 /resume 的名字，也命中 /help 的描述（"显示帮助 resume"）
    const filtered = filterCommands(sampleCommands(), 'resume');
    expect(filtered[0]?.name).toBe('/resume');
    expect(filtered.map((c) => c.name)).toContain('/help');
  });
});

/** 窗口不变量：选中项可见、长度不超上限、边界落在 [0,total]。 */
function expectValidWindow(total: number, selected: number, maxVisible: number): void {
  const { start, end } = getVisibleCommandWindow(total, selected, maxVisible);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeLessThanOrEqual(total);
  expect(end).toBeGreaterThan(start);
  expect(end - start).toBeLessThanOrEqual(Math.min(maxVisible, total));
  expect(selected).toBeGreaterThanOrEqual(start);
  expect(selected).toBeLessThan(end);
}

describe('getVisibleCommandWindow', () => {
  it('条目不超过上限时覆盖全部', () => {
    for (const [total, selected] of [
      [3, 0],
      [8, 7],
    ] as const) {
      expect(getVisibleCommandWindow(total, selected)).toEqual({ start: 0, end: total });
    }
  });

  it('选中项始终落在可见窗口内且窗口不超上限', () => {
    for (const selected of [0, 2, 10, 19]) {
      expectValidWindow(20, selected, MAX_VISIBLE_COMMANDS);
    }
  });

  it('选中最后一项时窗口贴住末尾', () => {
    expect(getVisibleCommandWindow(20, 19).end).toBe(20);
  });

  it('空列表 / 非法上限返回空窗口', () => {
    expect(getVisibleCommandWindow(0, 0)).toEqual({ start: 0, end: 0 });
    expect(getVisibleCommandWindow(5, 0, 0)).toEqual({ start: 0, end: 0 });
  });

  it('自定义窗口大小同样满足窗口不变量', () => {
    expectValidWindow(10, 8, 4);
  });
});

describe('decideCommandEnter', () => {
  const all = sampleCommands();

  it('精确匹配命令名 -> 执行（不补全）', () => {
    // 回归：旧的 isCompleted 双斜杠 bug 会让 /resume 永远走"补全不执行"
    const filtered = filterCommands(all, 'resume');
    const d = decideCommandEnter('/resume', all, filtered, 0);
    expect(d.action).toBe('execute');
  });

  it('未完成命令名 -> 补全到选中命令，不执行', () => {
    const filtered = filterCommands(all, 'res');
    const d = decideCommandEnter('/res', all, filtered, 0);
    expect(d).toEqual({ action: 'complete', commandName: '/resume' });
  });

  it('未完成命令名 + 多匹配 -> 补全到当前选中项', () => {
    const filtered = filterCommands(all, 're'); // /resume, /reload
    expect(filtered.length).toBeGreaterThanOrEqual(2);
    const d = decideCommandEnter('/re', all, filtered, 1);
    const selected = filtered[1];
    if (!selected) throw new Error('expected filtered[1] to exist');
    expect(d).toEqual({ action: 'complete', commandName: selected.name });
  });

  it('带参数的输入（含空格）-> 执行，绝不覆盖参数', () => {
    // 回归：旧代码补全框在输入参数时仍可见，Tab/Enter 会把参数清成命令名
    const filtered = filterCommands(all, 'resume');
    const d = decideCommandEnter('/resume some-session-id', all, filtered, 0);
    expect(d.action).toBe('execute');
  });

  it('精确命令名 + 尾随空格 -> 执行', () => {
    const d = decideCommandEnter('/resume ', all, filterCommands(all, 'resume'), 0);
    expect(d.action).toBe('execute');
  });

  it('无匹配的命令名 -> 执行（将提示未知命令）', () => {
    const d = decideCommandEnter('/xyz', all, filterCommands(all, 'xyz'), 0);
    expect(d.action).toBe('execute');
  });

  it('普通消息（非 / 开头）-> 执行', () => {
    const d = decideCommandEnter('hello world', all, [], 0);
    expect(d.action).toBe('execute');
  });

  it('仅 / -> 补全到第一项', () => {
    const d = decideCommandEnter('/', all, all, 0);
    const first = all[0];
    if (!first) throw new Error('expected all[0] to exist');
    expect(d).toEqual({ action: 'complete', commandName: first.name });
  });
});
