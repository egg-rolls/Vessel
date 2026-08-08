import { describe, expect, it } from 'bun:test';
import type { ToolContext } from '@vessel/core';
import { MemoryEventStream } from '@vessel/core';
import { ToolPermissionChecker } from '../src/renderer/tool-confirm.js';

/** 构造最小 ToolContext（checkPermission 的 ctx 参数，事件流等用户由 runtime 处理） */
function ctx(): ToolContext {
  return { run_id: 'r1', messages: [], events: new MemoryEventStream() };
}

describe('ToolPermissionChecker（ADR-029：checkPermission 策略判定）', () => {
  it('默认全部工具需要确认 -> forTool 返回 ask', async () => {
    const checker = new ToolPermissionChecker({ enabled: true });
    const cp = checker.forTool('write_file');
    expect(await cp({ path: '/tmp/x' }, ctx())).toBe('ask');
  });

  it('autoApprove 列表中的工具 -> allow', async () => {
    const checker = new ToolPermissionChecker({ enabled: true, autoApprove: ['read_file'] });
    expect(await checker.forTool('read_file')({}, ctx())).toBe('allow');
  });

  it('tools 列表限定：仅列表内工具确认', async () => {
    const checker = new ToolPermissionChecker({ enabled: true, tools: ['write_file'] });
    expect(await checker.forTool('write_file')({}, ctx())).toBe('ask');
    expect(await checker.forTool('read_file')({}, ctx())).toBe('allow');
  });

  it('enabled: false -> 全部 allow', async () => {
    const checker = new ToolPermissionChecker({ enabled: false });
    expect(await checker.forTool('write_file')({}, ctx())).toBe('allow');
  });

  it('needsConfirmation 策略判定正确', () => {
    const checker = new ToolPermissionChecker({ enabled: true, autoApprove: ['ask_user'] });
    expect(checker.needsConfirmation('write_file')).toBe(true);
    expect(checker.needsConfirmation('ask_user')).toBe(false);
  });
});
