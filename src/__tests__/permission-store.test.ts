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
