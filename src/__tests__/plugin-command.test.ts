import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveUserPluginsDir, runPluginCommand } from '../plugin-command';

describe('plugin-command（0.6.1 E9）', () => {
  let root: string;
  let userDir: string;
  let sourceDir: string;
  let configPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-plugin-cmd-'));
    userDir = path.join(root, 'user-plugins');
    sourceDir = path.join(root, 'source', 'hello-plugin');
    configPath = path.join(root, 'vessel.yaml');
    fs.writeFileSync(configPath, '# empty config\n', 'utf-8');

    fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'package.json'),
      JSON.stringify({ name: '@test/hello-plugin', version: '0.1.0', main: 'src/index.ts' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(sourceDir, 'src', 'index.ts'),
      'export default { name: "hello-plugin", install() {} };\n',
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function options() {
    return {
      userDir,
      configPath,
      userConfigPath: path.join(root, 'missing-user.yaml'),
      env: {},
    };
  }

  it('VESSEL_PLUGINS_DIR 决定用户插件目录', () => {
    expect(resolveUserPluginsDir({ VESSEL_PLUGINS_DIR: userDir })).toBe(path.resolve(userDir));
    expect(resolveUserPluginsDir({})).toContain(path.join('.vessel', 'plugins'));
  });

  it('install 复制本地插件目录，list 可发现', async () => {
    const installed = await runPluginCommand(
      { kind: 'install', path: sourceDir, force: false },
      options(),
    );
    expect(installed.exitCode).toBe(0);
    expect(fs.existsSync(path.join(userDir, 'hello-plugin', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'hello-plugin', 'src', 'index.ts'))).toBe(true);

    const listed = await runPluginCommand({ kind: 'list', json: true }, options());
    expect(listed.exitCode).toBe(0);
    const parsed = JSON.parse(listed.stdout) as {
      plugins: Array<{ name: string; source: string; enabled: boolean }>;
    };
    const hello = parsed.plugins.find((plugin) => plugin.name === 'hello-plugin');
    expect(hello?.source).toBe('user');
    // 默认集（plugins 未配置）会包含用户插件
    expect(hello?.enabled).toBe(true);
  });

  it('重复 install 需要 --force', async () => {
    expect(
      (await runPluginCommand({ kind: 'install', path: sourceDir, force: false }, options()))
        .exitCode,
    ).toBe(0);
    const again = await runPluginCommand(
      { kind: 'install', path: sourceDir, force: false },
      options(),
    );
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('already exists');

    const forced = await runPluginCommand(
      { kind: 'install', path: sourceDir, force: true },
      options(),
    );
    expect(forced.exitCode).toBe(0);
  });

  it('install 接受 exports["."] 对象形式的入口', async () => {
    const exportDir = path.join(root, 'exports-plugin');
    fs.mkdirSync(path.join(exportDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(exportDir, 'package.json'),
      JSON.stringify({
        name: 'exports-plugin',
        version: '0.1.0',
        exports: { '.': { import: './src/index.ts', default: './src/index.ts' } },
      }),
      'utf-8',
    );
    fs.writeFileSync(path.join(exportDir, 'src', 'index.ts'), 'export default {};\n', 'utf-8');

    const result = await runPluginCommand(
      { kind: 'install', path: exportDir, force: false },
      options(),
    );
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(userDir, 'exports-plugin', 'src', 'index.ts'))).toBe(true);
  });

  it('install 拒绝缺少 package.json / 入口的目录', async () => {
    const notPlugin = path.join(root, 'not-plugin');
    fs.mkdirSync(notPlugin, { recursive: true });
    expect(
      (await runPluginCommand({ kind: 'install', path: notPlugin, force: false }, options()))
        .exitCode,
    ).toBe(1);

    const noEntry = path.join(root, 'no-entry');
    fs.mkdirSync(noEntry, { recursive: true });
    fs.writeFileSync(
      path.join(noEntry, 'package.json'),
      JSON.stringify({ name: 'no-entry' }),
      'utf-8',
    );
    const result = await runPluginCommand(
      { kind: 'install', path: noEntry, force: false },
      options(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no resolvable entry');
  });

  it('remove 删除用户插件；不存在或非法名报错', async () => {
    await runPluginCommand({ kind: 'install', path: sourceDir, force: false }, options());

    const removed = await runPluginCommand(
      { kind: 'remove', name: 'hello-plugin', yes: true },
      options(),
    );
    expect(removed.exitCode).toBe(0);
    expect(fs.existsSync(path.join(userDir, 'hello-plugin'))).toBe(false);

    expect(
      (await runPluginCommand({ kind: 'remove', name: 'hello-plugin', yes: true }, options()))
        .exitCode,
    ).toBe(1);
    expect(
      (await runPluginCommand({ kind: 'remove', name: '../escape', yes: true }, options()))
        .exitCode,
    ).toBe(1);
  });
});
