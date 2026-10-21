import { describe, expect, it } from 'bun:test';
import { checkRpcMethods, compareMethodTables, parseDocMethodTable } from '../check-rpc-methods';

const DOC = [
  '<!-- rpc-methods:begin -->',
  '| 方法 | permission |',
  '|---|---|',
  '| `health.get` | read |',
  '| `runs.start` | write |',
  '| `trace.prune` | admin |',
  '<!-- rpc-methods:end -->',
].join('\n');

describe('check-rpc-methods', () => {
  it('parses the marked method table', () => {
    expect(parseDocMethodTable(DOC)).toEqual({
      'health.get': 'read',
      'runs.start': 'write',
      'trace.prune': 'admin',
    });
  });

  it('returns null without markers', () => {
    expect(parseDocMethodTable('| `health.get` | read |')).toBeNull();
  });

  it('reports missing and extra methods', () => {
    const issues = compareMethodTables(
      { 'health.get': 'read' },
      { 'health.get': 'read', 'runs.start': 'write', 'foo.bar': 'read' },
      { 'health.get': 'read', 'runs.start': 'write' },
    );
    expect(issues.some((issue) => issue.message.includes('manifest 缺少'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('ARCHITECTURE 出现未冻结'))).toBe(true);
  });

  it('reports permission mismatch and legacy leakage', () => {
    const issues = compareMethodTables(
      { 'health.get': 'write', 'team.list': 'read' },
      { 'health.get': 'write', 'team.list': 'read' },
      { 'health.get': 'read' },
    );
    expect(issues.some((issue) => issue.message.includes('permission 不一致'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('legacy-only'))).toBe(true);
  });

  it('matches the repository manifest and architecture table', async () => {
    expect(await checkRpcMethods(process.cwd())).toEqual([]);
  });
});
