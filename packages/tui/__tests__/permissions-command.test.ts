import { describe, expect, it } from 'bun:test';
import {
  configuredAutoApprove,
  runPermissionsCommand,
} from '../src/commands/permissions-command.js';
import type { PermissionsControl } from '../src/repl-context.js';
import { makeCtx } from './helpers.js';

function withConfig(autoApprove: string[]) {
  return makeCtx({
    config: { permission: { autoApprove } } as unknown as ReturnType<typeof makeCtx>['config'],
  });
}

describe('/permissions', () => {
  it('未注入写回接口时只读展示 config，并说明改动需手改 YAML', async () => {
    const ctx = withConfig(['bash', 'ask_user', 'bash']);
    expect(configuredAutoApprove(ctx)).toEqual(['ask_user', 'bash']);

    const result = await runPermissionsCommand([], ctx);
    expect(result.output).toContain('- bash');
    expect(result.output).toContain('Read-only');
    expect(result.output).not.toContain('User config:');
  });

  it('同时兼容 YAML snake_case（permission.auto_approve），否则只读回退会显示空列表', () => {
    const ctx = makeCtx({
      config: { permission: { auto_approve: ['edit'] } } as unknown as ReturnType<
        typeof makeCtx
      >['config'],
    });
    expect(configuredAutoApprove(ctx)).toEqual(['edit']);
  });

  it('add/remove 调写回接口，并回读最新列表（失败会静默丢配置）', async () => {
    const entries = ['ask_user'];
    const calls: string[] = [];
    const control: PermissionsControl = {
      list: async () => [...entries],
      add: async (tool) => {
        calls.push(`add:${tool}`);
        entries.push(tool);
      },
      remove: async (tool) => {
        calls.push(`remove:${tool}`);
        const index = entries.indexOf(tool);
        if (index >= 0) entries.splice(index, 1);
      },
      path: () => '/tmp/vessel.yaml',
    };
    const ctx = makeCtx({ permissions: control });

    const added = await runPermissionsCommand(['add', 'bash'], ctx);
    expect(calls).toEqual(['add:bash']);
    expect(added.output).toContain('Current entries: ask_user, bash');
    expect(added.output).toContain('/tmp/vessel.yaml');

    const removed = await runPermissionsCommand(['remove', 'ask_user'], ctx);
    expect(calls).toEqual(['add:bash', 'remove:ask_user']);
    expect(removed.output).toContain('Current entries: bash');
  });

  it('没有写回接口时 add 明确拒绝，不假装成功', async () => {
    const ctx = withConfig([]);
    const result = await runPermissionsCommand(['add', 'bash'], ctx);
    expect(result.output).toContain('write-back is not available');
  });

  it('缺少工具名时给 usage', async () => {
    const ctx = withConfig([]);
    const result = await runPermissionsCommand(['add'], ctx);
    expect(result.output).toContain('Usage: /permissions');
  });
});
