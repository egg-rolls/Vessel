import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  addAutoApproveRule,
  createPermissionStore,
  listAutoApproveRules,
  removeAutoApproveRule,
  setAutoApproveRules,
  setToolPolicy,
} from '../permission-store';

describe('permission-store（0.6.1 E7）', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-perm-'));
    configPath = path.join(dir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readRoot(): Record<string, unknown> {
    return parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }

  it('add 写 permission.auto_approve 并保留其它配置', () => {
    fs.writeFileSync(configPath, 'api_key: sk-test\nprovider:\n  model: gpt-4\n', 'utf-8');

    expect(addAutoApproveRule('bash', { configPath })).toEqual(['bash']);
    expect(addAutoApproveRule('edit', { configPath })).toEqual(['bash', 'edit']);

    const root = readRoot();
    expect(root.api_key).toBe('sk-test');
    expect(root.provider).toEqual({ model: 'gpt-4' });
    expect(root.permission).toEqual({ auto_approve: ['bash', 'edit'] });
    expect(listAutoApproveRules({ configPath })).toEqual(['bash', 'edit']);
  });

  it('add 幂等；文件不存在时创建', () => {
    expect(addAutoApproveRule('bash', { configPath })).toEqual(['bash']);
    expect(addAutoApproveRule('bash', { configPath })).toEqual(['bash']);
  });

  it('remove 删除规则并保留空数组', () => {
    setAutoApproveRules(['bash', 'edit'], { configPath });
    expect(removeAutoApproveRule('bash', { configPath })).toEqual(['edit']);
    expect(removeAutoApproveRule('nope', { configPath })).toEqual(['edit']);
    expect(readRoot().permission).toEqual({ auto_approve: ['edit'] });
  });

  it('set 去重/去空白并保持顺序', () => {
    expect(setAutoApproveRules([' bash ', 'bash', '', 'edit'], { configPath })).toEqual([
      'bash',
      'edit',
    ]);
  });

  it('读取旧 camelCase 键并统一写回 snake_case', () => {
    fs.writeFileSync(
      configPath,
      'permission:\n  autoApprove:\n    - bash\n  other: keep\n',
      'utf-8',
    );
    expect(listAutoApproveRules({ configPath })).toEqual(['bash']);
    addAutoApproveRule('edit', { configPath });
    expect(readRoot().permission).toEqual({ other: 'keep', auto_approve: ['bash', 'edit'] });
  });

  it('非法 tool 名与非法 permission 块显式失败', () => {
    expect(() => addAutoApproveRule('', { configPath })).toThrow('invalid_tool_name');
    fs.writeFileSync(configPath, 'permission: nope\n', 'utf-8');
    expect(() => addAutoApproveRule('bash', { configPath })).toThrow(
      'permission_store_invalid_config',
    );
  });

  it('createPermissionStore 绑定路径', () => {
    const store = createPermissionStore({ configPath });
    expect(store.add('bash')).toEqual(['bash']);
    expect(store.list()).toEqual(['bash']);
    expect(store.remove('bash')).toEqual([]);
    expect(store.set(['edit'])).toEqual(['edit']);
  });
});

describe('permission-store setToolPolicy（CONTRACT-hot-apply §7）', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-policy-'));
    configPath = path.join(dir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readRoot(): Record<string, unknown> {
    return parseYaml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }

  it('三档语义完全由两个数组表达，且只动目标工具', () => {
    fs.writeFileSync(
      configPath,
      'api_key: sk-test\npermission:\n  auto_approve: [bash]\n  never_auto_approve: [edit]\n',
      'utf-8',
    );

    // auto：进 auto_approve，出 never_auto_approve
    expect(setToolPolicy('edit', 'auto', { configPath })).toEqual({
      autoApprove: ['bash', 'edit'],
      neverAutoApprove: [],
    });

    // never：进 never_auto_approve，出 auto_approve
    expect(setToolPolicy('bash', 'never', { configPath })).toEqual({
      autoApprove: ['edit'],
      neverAutoApprove: ['bash'],
    });

    // ask：两个都不进
    expect(setToolPolicy('edit', 'ask', { configPath })).toEqual({
      autoApprove: [],
      neverAutoApprove: ['bash'],
    });

    // 其它键原样保留
    expect(readRoot().api_key).toBe('sk-test');
  });

  it('写 snake_case 并清理 camelCase 旧键', () => {
    fs.writeFileSync(
      configPath,
      'permission:\n  autoApprove: [bash]\n  neverAutoApprove: [edit]\n  other: keep\n',
      'utf-8',
    );
    setToolPolicy('read', 'auto', { configPath });
    expect(readRoot().permission).toEqual({
      other: 'keep',
      auto_approve: ['bash', 'read'],
      never_auto_approve: ['edit'],
    });
  });

  it('文件不存在时创建，权限 0600', () => {
    setToolPolicy('bash', 'auto', { configPath });
    const root = readRoot();
    expect(root.permission).toEqual({ auto_approve: ['bash'], never_auto_approve: [] });
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it('保留其它 permission 子键（不整体替换块）', () => {
    fs.writeFileSync(configPath, 'permission:\n  timeouts: 5\n', 'utf-8');
    setToolPolicy('bash', 'never', { configPath });
    expect(readRoot().permission).toEqual({
      timeouts: 5,
      auto_approve: [],
      never_auto_approve: ['bash'],
    });
  });

  it('非法 tool 名与非法 permission 块显式失败', () => {
    expect(() => setToolPolicy('', 'auto', { configPath })).toThrow('invalid_tool_name');
    fs.writeFileSync(configPath, 'permission: nope\n', 'utf-8');
    expect(() => setToolPolicy('bash', 'auto', { configPath })).toThrow(
      'permission_store_invalid_config',
    );
  });

  it('createPermissionStore.policy / setPolicy 往返一致', () => {
    const store = createPermissionStore({ configPath });
    expect(store.policy()).toEqual({ autoApprove: [], neverAutoApprove: [] });
    expect(store.setPolicy('bash', 'auto')).toEqual({
      autoApprove: ['bash'],
      neverAutoApprove: [],
    });
    expect(store.policy()).toEqual({ autoApprove: ['bash'], neverAutoApprove: [] });
    expect(store.setPolicy('bash', 'never')).toEqual({
      autoApprove: [],
      neverAutoApprove: ['bash'],
    });
  });
});
