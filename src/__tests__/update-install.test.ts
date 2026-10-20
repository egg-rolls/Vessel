import { describe, expect, it } from 'bun:test';
import { runSelfUpdate } from '../cli-update';
import { buildInstallPlan, detectInstallForm } from '../update/install-detect';

const NPM_CLI = '/usr/lib/node_modules/vessel-agent/src/cli.ts';
const BUN_CLI = '/home/u/.bun/install/global/node_modules/vessel-agent/src/cli.ts';
const DEV_CLI = 'D:/repo/Vessel/src/cli.ts';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    print: (line: string) => out.push(line),
    printErr: (line: string) => err.push(line),
  };
}

const baseOptions = { check: false, json: false, force: false };

describe('detectInstallForm', () => {
  it('npm 全局', () => {
    expect(detectInstallForm({ entryPath: NPM_CLI, homeDir: '/home/u', env: {} })).toBe('npm');
  });

  it('bun 全局（含 Windows 布局）', () => {
    expect(detectInstallForm({ entryPath: BUN_CLI, homeDir: '/home/u', env: {} })).toBe('bun');
    expect(
      detectInstallForm({
        entryPath: 'C:/Users/u/.bun/install/global/node_modules/vessel-agent/src/cli.ts',
        homeDir: 'C:/Users/u',
        env: {},
      }),
    ).toBe('bun');
  });

  it('源码 / 开发模式', () => {
    expect(detectInstallForm({ entryPath: DEV_CLI, homeDir: '/home/u', env: {} })).toBe('dev');
    expect(
      detectInstallForm({
        entryPath: '/opt/vessel/bin/vessel',
        cwd: '/repo',
        exists: (p) => p.replace(/\\/g, '/').endsWith('/repo/.git'),
        env: {},
      }),
    ).toBe('dev');
  });

  it('无法识别 → unknown（按 dev 提示）', () => {
    expect(
      detectInstallForm({
        entryPath: '/opt/tool/run.js',
        cwd: '/opt/tool',
        exists: () => false,
        env: {},
      }),
    ).toBe('unknown');
    expect(detectInstallForm({ entryPath: '', env: {} })).toBe('unknown');
  });

  it('VESSEL_INSTALL_FORM 显式覆盖', () => {
    expect(detectInstallForm({ entryPath: NPM_CLI, env: { VESSEL_INSTALL_FORM: 'bun' } })).toBe(
      'bun',
    );
    expect(detectInstallForm({ entryPath: NPM_CLI, env: { VESSEL_INSTALL_FORM: 'nope' } })).toBe(
      'npm',
    );
  });
});

describe('buildInstallPlan', () => {
  it('npm / bun 命令与 dev 提示', () => {
    expect(buildInstallPlan('npm')).toEqual({
      form: 'npm',
      command: ['npm', 'i', '-g', 'vessel-agent@latest'],
    });
    expect(buildInstallPlan('bun')).toEqual({
      form: 'bun',
      command: ['bun', 'add', '-g', 'vessel-agent@latest'],
    });
    expect(buildInstallPlan('dev')).toEqual({
      form: 'dev',
      hint: 'git pull && bun install',
    });
    expect(buildInstallPlan('unknown').hint).toBe('git pull && bun install');
  });
});

describe('runSelfUpdate', () => {
  it('npm：--yes 直接执行，不真装（注入命令）', async () => {
    const calls: string[][] = [];
    const log = capture();
    const code = await runSelfUpdate(
      { ...baseOptions, yes: true },
      {
        form: 'npm',
        runCommand: async (argv) => {
          calls.push(argv);
          return { exitCode: 0, stdout: 'installed', stderr: '' };
        },
        print: log.print,
        printErr: log.printErr,
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([['npm', 'i', '-g', 'vessel-agent@latest']]);
    expect(log.out.join('\n')).toContain('vessel gateway restart');
  });

  it('bun：确认通过后执行', async () => {
    const calls: string[][] = [];
    const log = capture();
    let question = '';
    const code = await runSelfUpdate(baseOptions, {
      form: 'bun',
      stdinIsTTY: true,
      confirm: async (q) => {
        question = q;
        return true;
      },
      runCommand: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      print: log.print,
      printErr: log.printErr,
    });
    expect(code).toBe(0);
    expect(question).toContain('bun add -g vessel-agent@latest');
    expect(calls).toEqual([['bun', 'add', '-g', 'vessel-agent@latest']]);
  });

  it('非 TTY 且无 --yes → 非 0，不执行', async () => {
    const calls: string[][] = [];
    const log = capture();
    const code = await runSelfUpdate(baseOptions, {
      form: 'npm',
      stdinIsTTY: false,
      runCommand: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      print: log.print,
      printErr: log.printErr,
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(log.err.length).toBeGreaterThan(0);
  });

  it('拒绝确认 → 非 0，不执行', async () => {
    const calls: string[][] = [];
    const log = capture();
    const code = await runSelfUpdate(baseOptions, {
      form: 'npm',
      stdinIsTTY: true,
      confirm: async () => false,
      runCommand: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      print: log.print,
      printErr: log.printErr,
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('dev/unknown：只提示 git pull && bun install', async () => {
    for (const form of ['dev', 'unknown'] as const) {
      const calls: string[][] = [];
      const log = capture();
      const code = await runSelfUpdate(
        { ...baseOptions, yes: true },
        {
          form,
          runCommand: async (argv) => {
            calls.push(argv);
            return { exitCode: 0, stdout: '', stderr: '' };
          },
          print: log.print,
          printErr: log.printErr,
        },
      );
      expect(code).toBe(0);
      expect(calls).toEqual([]);
      expect(log.out.join('\n')).toContain('git pull && bun install');
    }
  });

  it('安装失败 → 非 0，旧版本保持不变', async () => {
    const log = capture();
    const code = await runSelfUpdate(
      { ...baseOptions, yes: true },
      {
        form: 'npm',
        runCommand: async () => ({ exitCode: 7, stdout: '', stderr: 'network down' }),
        print: log.print,
        printErr: log.printErr,
      },
    );
    expect(code).toBe(1);
    expect(log.err.join('\n')).toContain('7');
  });

  it('--json：输出可解析的机器结果', async () => {
    const out: string[] = [];
    const code = await runSelfUpdate(
      { ...baseOptions, yes: true, json: true },
      {
        form: 'bun',
        runCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
        print: (line) => out.push(line),
        printErr: () => undefined,
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0] ?? '{}') as {
      form?: string;
      updated?: boolean;
      command?: string[];
      exit_code?: number;
    };
    expect(parsed.form).toBe('bun');
    expect(parsed.updated).toBe(true);
    expect(parsed.command).toEqual(['bun', 'add', '-g', 'vessel-agent@latest']);
    expect(parsed.exit_code).toBe(0);
  });
});
