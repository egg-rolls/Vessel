import { describe, expect, it } from 'bun:test';
import { ToolPermissionChecker } from '../src/renderer/tool-confirm.js';
import { captureConsole } from './helpers.js';

describe('ToolPermissionChecker.promptFn（避免 confirm 抢 stdin）', () => {
  it('注入 promptFn 时 confirm 用之，不自建 readline', async () => {
    let calledQuestion = '';
    const checker = new ToolPermissionChecker({ enabled: true });
    checker.promptFn = async (q) => {
      calledQuestion = q;
      return 'y';
    };
    const cap = captureConsole();
    const result = await checker.confirm('write_file', { path: '/tmp/x' });
    cap.restore();
    expect(result.approved).toBe(true);
    expect(calledQuestion).toContain('Allow execution');
  });

  it('promptFn 返回 n -> 拒绝', async () => {
    const checker = new ToolPermissionChecker({ enabled: true });
    checker.promptFn = async () => 'n';
    const cap = captureConsole();
    const result = await checker.confirm('write_file', {});
    cap.restore();
    expect(result.approved).toBe(false);
  });

  it('promptFn 返回 always -> 批准且记忆，后续同工具不再问', async () => {
    let askCount = 0;
    const checker = new ToolPermissionChecker({ enabled: true });
    checker.promptFn = async () => {
      askCount++;
      return 'always';
    };
    const cap = captureConsole();
    const r1 = await checker.confirm('write_file', {});
    const r2 = await checker.confirm('write_file', {});
    cap.restore();
    expect(r1.approved).toBe(true);
    expect(r1.remember).toBe(true);
    expect(r2.approved).toBe(true);
    expect(askCount).toBe(1); // 第二次跳过确认（已记忆）
  });
});
