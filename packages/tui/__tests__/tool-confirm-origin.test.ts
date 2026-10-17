import { describe, expect, it } from 'bun:test';
import { formatPermissionQuestion } from '../src/renderer/tool-confirm.js';

describe('formatPermissionQuestion', () => {
  it('MCP 工具显示来源 server 与原始工具名', () => {
    expect(
      formatPermissionQuestion('mcp__github__search', { server: 'github', tool: 'search' }),
    ).toBe('Allow tool "search" from MCP server "github" to run?');
  });

  it('非 MCP / 无法判定时保持原文案', () => {
    expect(formatPermissionQuestion('bash', null)).toBe('Allow tool "bash" to run?');
  });
});
