import { describe, expect, it } from 'bun:test';
import {
  buildAutocompleteRows,
  type CommandItem,
  DISCOVERY_PRIORITY,
  filterCommands,
  scoreCommand,
  sortCommandsForDiscovery,
} from '../src/components/InlineAutocomplete.js';

const COMMANDS: CommandItem[] = [
  { name: '/tools', description: 'list tools', category: 'inspect' },
  {
    name: '/resume',
    description: 'Resume a session',
    category: 'session',
    keywords: ['session', 'switch', 'load'],
  },
  { name: '/runs', description: 'Durable runs', category: 'run', keywords: ['durable'] },
  { name: '/new', description: 'new session', category: 'session' },
  { name: '/help', description: 'show help', category: 'system' },
  { name: '/history', description: 'conversation history', category: 'session' },
  { name: '/clear', description: 'clear screen', category: 'system' },
  { name: '/sessions', description: 'deprecated alias', category: 'session', hidden: true },
];

const byName = (commands: CommandItem[]): string[] => commands.map((command) => command.name);

describe('scoreCommand', () => {
  const resume = COMMANDS[1];
  if (!resume) throw new Error('expected resume');

  it('name 前缀 100 / name 子串 80', () => {
    expect(scoreCommand('res', resume)).toBe(100);
    expect(scoreCommand('sume', resume)).toBe(80);
  });

  it('keywords 前缀 60 / keywords 子串 50', () => {
    expect(scoreCommand('swi', resume)).toBe(60);
    expect(scoreCommand('itch', resume)).toBe(50);
  });

  it('description 子串 30', () => {
    expect(scoreCommand('Resume a', resume)).toBe(30);
  });

  it('子序列 20', () => {
    // r...s...m 匹配 resume
    expect(scoreCommand('rsm', resume)).toBe(20);
  });

  it('不匹配 0', () => {
    expect(scoreCommand('zzz', resume)).toBe(0);
  });

  it('大小写不敏感', () => {
    expect(scoreCommand('RES', resume)).toBe(100);
  });
});

describe('filterCommands', () => {
  it('hidden 命令永不出现', () => {
    expect(byName(filterCommands(COMMANDS, ''))).not.toContain('/sessions');
    expect(byName(filterCommands(COMMANDS, 'sessions'))).not.toContain('/sessions');
  });

  it('空 query：最近使用 > DISCOVERY_PRIORITY > 注册顺序', () => {
    const sorted = filterCommands(COMMANDS, '');
    expect(sorted.slice(0, DISCOVERY_PRIORITY.length).map((command) => command.name)).toEqual([
      ...DISCOVERY_PRIORITY,
    ]);

    const withRecent = filterCommands(COMMANDS, '', { recent: ['runs'] });
    expect(withRecent[0]?.name).toBe('/runs');
  });

  it('非空 query：按 score 排序，name 命中优先于 description', () => {
    const result = filterCommands(COMMANDS, 'res');
    expect(result[0]?.name).toBe('/resume');
    // "show help" 不含 res；"conversation history" 也不含；结果应只有 resume
    expect(byName(result)).toEqual(['/resume']);
  });

  it('keywords 让 /runs 能被 durable 找到', () => {
    expect(byName(filterCommands(COMMANDS, 'durable'))).toEqual(['/runs']);
  });

  it('同分时 discovery 优先', () => {
    // "new" 同时命中 /new（name 前缀 100）和 /resume 的 keywords（? 无）
    expect(filterCommands(COMMANDS, 'new')[0]?.name).toBe('/new');
  });

  it('available=false 不隐藏，只由渲染层加标签', () => {
    const commands: CommandItem[] = [{ name: '/mcp', description: 'MCP', available: false }];
    expect(filterCommands(commands, 'mcp')).toHaveLength(1);
  });
});

describe('sortCommandsForDiscovery', () => {
  it('recent 顺序优先于 DISCOVERY_PRIORITY', () => {
    const sorted = sortCommandsForDiscovery(COMMANDS, ['clear', 'resume']);
    expect(sorted.slice(0, 2).map((command) => command.name)).toEqual(['/clear', '/resume']);
  });
});

describe('buildAutocompleteRows', () => {
  it('在 category 变化处插入组头；命令 index 指向扁平列表位置', () => {
    const list: CommandItem[] = [
      { name: '/resume', description: 'resume', category: 'session' },
      { name: '/new', description: 'new', category: 'session' },
      { name: '/runs', description: 'runs', category: 'run' },
      { name: '/help', description: 'help', category: 'system' },
    ];
    const rows = buildAutocompleteRows(list);
    expect(rows.map((row) => (row.kind === 'header' ? `#${row.label}` : row.command.name))).toEqual(
      ['#SESSION', '/resume', '/new', '#RUN', '/runs', '#SYSTEM', '/help'],
    );
    expect(rows.filter((row) => row.kind === 'command').map((row) => row.index)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('headings=false 时不插入组头（输入过滤词后的扁平排名）', () => {
    const rows = buildAutocompleteRows(COMMANDS, false);
    expect(rows.every((row) => row.kind === 'command')).toBe(true);
    expect(rows.map((row) => (row.kind === 'command' ? row.index : -1))).toEqual(
      rows.map((_, index) => index),
    );
  });

  it('hidden 命令不进入行列表', () => {
    const rows = buildAutocompleteRows(COMMANDS);
    expect(rows.some((row) => row.kind === 'command' && row.command.name === '/sessions')).toBe(
      false,
    );
  });
});
