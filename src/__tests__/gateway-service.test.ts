import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildServiceDefinition,
  installService,
  resolveServiceTarget,
  SCHTASKS_TASK_NAME,
  SERVICE_COMMAND,
  serviceDefinitionPath,
  serviceStatus,
  serviceTargetForPlatform,
  uninstallService,
} from '../gateway/service';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-gateway-service-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runner(result: { exitCode: number; stdout?: string; stderr?: string } = { exitCode: 0 }) {
  const calls: string[][] = [];
  return {
    calls,
    runCommand: async (argv: string[]) => {
      calls.push(argv);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

describe('平台 target', () => {
  it('三平台映射', () => {
    expect(serviceTargetForPlatform('linux')).toBe('systemd');
    expect(serviceTargetForPlatform('darwin')).toBe('launchd');
    expect(serviceTargetForPlatform('win32')).toBe('schtasks');
    expect(serviceTargetForPlatform('aix')).toBeNull();
  });

  it('显式 target 必须与当前平台一致', () => {
    const matched = resolveServiceTarget('linux', 'systemd');
    expect(matched.ok).toBe(true);
    const mismatched = resolveServiceTarget('linux', 'launchd');
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.error).toContain('does not match this platform');
      expect(mismatched.error).toContain('run the command on the target platform');
    }
    const unsupported = resolveServiceTarget('aix');
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error).toContain('not supported');
  });
});

describe('服务定义生成', () => {
  const home = path.join('home', 'user');

  it('systemd user unit', () => {
    const def = buildServiceDefinition('systemd', { dataDir: '/data/vessel', homeDir: home });
    expect(def.path).toBe(path.join(home, '.config', 'systemd', 'user', 'vessel-gateway.service'));
    expect(def.content).toContain('ExecStart=/usr/bin/env vessel gateway start');
    expect(def.content).toContain('[Install]');
    expect(def.content).toContain('WantedBy=default.target');
    expect(def.content).not.toContain('--daemon');
    expect(def.install).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'vessel-gateway.service'],
    ]);
    expect(def.uninstall[0]).toContain('disable');
  });

  it('launchd plist', () => {
    const def = buildServiceDefinition('launchd', { dataDir: '/data/vessel', homeDir: home });
    expect(def.path).toBe(path.join(home, 'Library', 'LaunchAgents', 'com.vessel.gateway.plist'));
    expect(def.content).toContain(`<string>${SERVICE_COMMAND}</string>`);
    expect(def.content).toContain('<key>RunAtLoad</key>');
    expect(def.content).toContain('<key>KeepAlive</key>');
    expect(def.content).not.toContain('--daemon');
    expect(def.install[0]?.[0]).toBe('launchctl');
  });

  it('schtasks 登录任务（避免管理员）', () => {
    const def = buildServiceDefinition('schtasks', { dataDir: '/data/vessel', homeDir: home });
    expect(def.path).toBeUndefined();
    const create = def.install[0] ?? [];
    expect(create[0]).toBe('schtasks');
    expect(create).toContain('ONLOGON');
    expect(create).toContain(SCHTASKS_TASK_NAME);
    expect(create).toContain(SERVICE_COMMAND);
    expect(create.join(' ')).not.toContain('/RU');
    expect(create.join(' ')).not.toContain('--daemon');
    expect(def.uninstall[0]).toEqual(['schtasks', '/Delete', '/F', '/TN', SCHTASKS_TASK_NAME]);
  });

  it('serviceDefinitionPath', () => {
    expect(serviceDefinitionPath('schtasks', home)).toBeUndefined();
    expect(serviceDefinitionPath('systemd', home)).toContain('vessel-gateway.service');
  });
});

describe('installService / uninstallService', () => {
  it('写文件并执行注册命令', async () => {
    const home = tmpDir();
    const dataDir = path.join(home, 'data');
    const fake = runner();
    const result = await installService('systemd', {
      dataDir,
      homeDir: home,
      runCommand: fake.runCommand,
    });
    expect(result.ok).toBe(true);
    const unitPath = path.join(home, '.config', 'systemd', 'user', 'vessel-gateway.service');
    expect(fs.existsSync(unitPath)).toBe(true);
    expect(fs.readFileSync(unitPath, 'utf8')).toContain(SERVICE_COMMAND);
    expect(fake.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'vessel-gateway.service'],
    ]);
  });

  it('注册命令失败返回错误', async () => {
    const home = tmpDir();
    const fake = runner({ exitCode: 1, stderr: 'systemd is not running' });
    const result = await installService('systemd', {
      dataDir: path.join(home, 'data'),
      homeDir: home,
      runCommand: fake.runCommand,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('systemd is not running');
  });

  it('卸载移除文件并执行反注册', async () => {
    const home = tmpDir();
    const dataDir = path.join(home, 'data');
    await installService('launchd', { dataDir, homeDir: home, runCommand: runner().runCommand });

    const fake = runner();
    const result = await uninstallService('launchd', {
      dataDir,
      homeDir: home,
      runCommand: fake.runCommand,
    });
    expect(result.ok).toBe(true);
    expect(fake.calls[0]?.[0]).toBe('launchctl');
    expect(fake.calls[0]).toContain('unload');
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.vessel.gateway.plist');
    expect(fs.existsSync(plistPath)).toBe(false);
  });

  it('未安装时 uninstall 幂等（不执行 launchctl）', async () => {
    const home = tmpDir();
    const fake = runner();
    const result = await uninstallService('launchd', {
      dataDir: path.join(home, 'data'),
      homeDir: home,
      runCommand: fake.runCommand,
    });
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});

describe('serviceStatus', () => {
  it('systemd：unit 文件含服务命令才算注册', async () => {
    const home = tmpDir();
    const dataDir = path.join(home, 'data');
    const unitPath = path.join(home, '.config', 'systemd', 'user', 'vessel-gateway.service');
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });

    expect(await serviceStatus('linux', { dataDir, homeDir: home })).toEqual({
      supported: true,
      target: 'systemd',
      installed: false,
      path: unitPath,
    });

    fs.writeFileSync(unitPath, '[Service]\nExecStart=/usr/bin/env vessel gateway start\n');
    const status = await serviceStatus('linux', { dataDir, homeDir: home });
    expect(status.supported).toBe(true);
    if (status.supported) expect(status.installed).toBe(true);

    fs.writeFileSync(unitPath, '[Service]\nExecStart=/usr/bin/other\n');
    const foreign = await serviceStatus('linux', { dataDir, homeDir: home });
    if (foreign.supported) expect(foreign.installed).toBe(false);
  });

  it('win32：schtasks 查询', async () => {
    const found = await serviceStatus('win32', {
      dataDir: '/data',
      runCommand: runner({ exitCode: 0 }).runCommand,
    });
    expect(found).toEqual({ supported: true, target: 'schtasks', installed: true });

    const missing = await serviceStatus('win32', {
      dataDir: '/data',
      runCommand: runner({ exitCode: 1 }).runCommand,
    });
    expect(missing).toEqual({ supported: true, target: 'schtasks', installed: false });
  });

  it('不支持的平台', async () => {
    expect(await serviceStatus('aix', { dataDir: '/data' })).toEqual({ supported: false });
  });
});
