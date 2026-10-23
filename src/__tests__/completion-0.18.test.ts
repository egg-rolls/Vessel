/**
 * 0.18 `vessel completion`：四种 shell 脚本生成、spec 与 registry 一致性、错误退出码。
 *
 * 脚本只做静态断言（关键 token / 括号与引号平衡 / 覆盖范围）；
 * 退出码用子进程验证，临时 HOME 隔离真实配置。
 */
import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../cli-args';
import { cliCommands } from '../commands/registry';
import { renderCompletionScript } from '../completion-script';
import {
  COMPLETION_COMMANDS,
  COMPLETION_SHELLS,
  GLOBAL_FLAGS,
  topLevelWords,
} from '../completion-spec';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

function count(text: string, char: string): number {
  return [...text].filter((value) => value === char).length;
}

/** fish 把 `--json` / `-p` 写成 `-l json` / `-s p` */
function fishFlagForm(flag: string): string {
  return flag.startsWith('--') ? `-l ${flag.slice(2)}` : `-s ${flag.slice(1)}`;
}

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-completion-'));
  try {
    const proc = Bun.spawn([process.execPath, cliPath, ...args], {
      cwd: tmpDir,
      env: {
        ...process.env,
        VESSEL_LANG: 'en',
        LANG: '',
        LC_ALL: '',
        USERPROFILE: tmpDir,
        HOME: tmpDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('completion scripts - 关键 token', () => {
  it('bash 使用 COMP_WORDS / COMP_CWORD / compgen，并保留 -o default', () => {
    const script = renderCompletionScript('bash');
    expect(script).toContain('_vessel()');
    expect(script).toContain('COMP_WORDS');
    expect(script).toContain('COMP_CWORD');
    expect(script).toContain('compgen -W');
    expect(script).toContain('complete -o default -F _vessel vessel');
    expect(script).not.toContain('complete -f');
  });

  it('zsh 带 #compdef、_arguments / _describe 与 compdef', () => {
    const script = renderCompletionScript('zsh');
    expect(script.startsWith('#compdef vessel')).toBe(true);
    expect(script).toContain('_arguments');
    expect(script).toContain('_describe');
    expect(script).toContain('compdef _vessel vessel');
  });

  it('fish 使用 __fish_use_subcommand 与 __fish_seen_subcommand_from', () => {
    const script = renderCompletionScript('fish');
    expect(script).toContain("complete -c vessel -f -n '__fish_use_subcommand'");
    expect(script).toContain('__fish_seen_subcommand_from');
    expect(script).toContain("-a 'start' -d 'Vessel subcommand'");
    expect(script).toContain(
      "-n '__fish_seen_subcommand_from gateway; and not __fish_seen_subcommand_from start",
    );
  });

  it('powershell 使用 Register-ArgumentCompleter -Native 与 CompletionResult', () => {
    const script = renderCompletionScript('powershell');
    expect(script).toContain('Register-ArgumentCompleter -Native -CommandName vessel');
    expect(script).toContain('param($wordToComplete, $commandAst, $cursorPosition)');
    expect(script).toContain('[System.Management.Automation.CompletionResult]::new');
  });

  it('四种脚本都以换行结尾', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletionScript(shell);
      expect(script.endsWith('\n')).toBe(true);
      expect(script.length).toBeGreaterThan(500);
    }
  });
});

describe('completion scripts - 覆盖范围', () => {
  it('顶层命令与全局 flags 出现在所有脚本里', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletionScript(shell);
      for (const word of topLevelWords()) {
        const needle = shell === 'fish' && word.startsWith('-') ? fishFlagForm(word) : word;
        expect({ shell, word, found: script.includes(needle) }).toEqual({
          shell,
          word,
          found: true,
        });
      }
    }
  });

  it('二级子命令与命令 flags 出现在所有脚本里', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletionScript(shell);
      for (const command of COMPLETION_COMMANDS) {
        for (const sub of command.subcommands ?? []) {
          expect({ shell, sub: sub.name, found: script.includes(sub.name) }).toEqual({
            shell,
            sub: sub.name,
            found: true,
          });
        }
        for (const flag of command.flags ?? []) {
          const needle = shell === 'fish' ? fishFlagForm(flag) : flag;
          expect({ shell, flag, found: script.includes(needle) }).toEqual({
            shell,
            flag,
            found: true,
          });
        }
      }
    }
  });

  it('hub 子命令与 flags 被收录', () => {
    const hub = COMPLETION_COMMANDS.find((command) => command.token === 'hub');
    expect(hub?.registryName).toBe('hub');
    expect(hub?.subcommands?.map((sub) => sub.name)).toEqual([
      'start',
      'directory',
      'watch',
      'pair',
      'node',
      'token',
      'data-token',
    ]);
    const flags = new Set<string>();
    for (const sub of hub?.subcommands ?? []) {
      for (const flag of sub.flags ?? []) flags.add(flag);
    }
    for (const flag of [
      '--hub-url',
      '--token-env',
      '--admin-token-env',
      '--token-id',
      '--team',
      '--code',
      '--alias',
      '--ttl',
    ]) {
      expect({ flag, covered: flags.has(flag) }).toEqual({ flag, covered: true });
    }
    for (const shell of COMPLETION_SHELLS) {
      const script = renderCompletionScript(shell);
      for (const flag of ['--hub-url', '--admin-token-env', '--token-id']) {
        const needle = shell === 'fish' ? fishFlagForm(flag) : flag;
        expect({ shell, flag, found: script.includes(needle) }).toEqual({
          shell,
          flag,
          found: true,
        });
      }
    }
  });

  it('常用 flags 与静态候选值被收录', () => {
    const common = [
      '--json',
      '--daemon',
      '--instance',
      '--port',
      '--host',
      '--tenant',
      '--session',
      '--resume',
      '--run',
      '--tools',
      '--connect',
    ];
    const allFlags = new Set<string>(GLOBAL_FLAGS);
    for (const command of COMPLETION_COMMANDS) {
      for (const flag of command.flags ?? []) allFlags.add(flag);
      for (const sub of command.subcommands ?? []) {
        for (const flag of sub.flags ?? []) allFlags.add(flag);
      }
    }
    for (const flag of common) {
      expect({ flag, covered: allFlags.has(flag) }).toEqual({ flag, covered: true });
    }
    const zsh = renderCompletionScript('zsh');
    expect(zsh).toContain('(latest beta)');
    expect(zsh).toContain('(active disabled)');
    expect(zsh).toContain('(pending running completed failed cancelled interrupted)');
    const bash = renderCompletionScript('bash');
    expect(bash).toContain("'workflow list|--status'");
    expect(bash).toContain("'gateway reload|--scope'");
  });
});

describe('completion scripts - 引号与括号平衡', () => {
  // bash / zsh 的 `pattern)` 是 case 分支语法，单个 `)` 合法；只检查花括号与方括号。
  const pairsFor = (shell: string): ReadonlyArray<readonly [string, string]> =>
    shell === 'bash' || shell === 'zsh'
      ? [
          ['{', '}'],
          ['[', ']'],
        ]
      : [
          ['(', ')'],
          ['{', '}'],
          ['[', ']'],
        ];

  for (const shell of COMPLETION_SHELLS) {
    it(`${shell} 的引号与括号成对`, () => {
      const script = renderCompletionScript(shell);
      expect(count(script, "'") % 2).toBe(0);
      expect(count(script, '"') % 2).toBe(0);
      for (const [open, close] of pairsFor(shell)) {
        expect({ open, count: count(script, open) }).toEqual({
          open,
          count: count(script, close),
        });
      }
    });
  }
});

describe('completion spec 与 registry 一致', () => {
  const specNames = new Set(
    COMPLETION_COMMANDS.map((command) => command.registryName).filter(
      (name): name is string => name !== null,
    ),
  );

  it('注册表里的每个一次性命令都能在 spec 找到', () => {
    for (const command of cliCommands) {
      expect({ command: command.name, covered: specNames.has(command.name) }).toEqual({
        command: command.name,
        covered: true,
      });
    }
  });

  it('spec 不引用不存在的注册表命令', () => {
    const registryNames = new Set(cliCommands.map((command) => command.name));
    for (const name of specNames) {
      expect({ name, exists: registryNames.has(name) }).toEqual({ name, exists: true });
    }
  });
});

describe('argv 解析', () => {
  it('识别支持的 shell', () => {
    const parsed = parseArgs(['completion', 'zsh']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.completionCommand).toEqual({ shell: 'zsh', requested: 'zsh' });
  });

  it('无参数保留 null，由命令打印用法', () => {
    const parsed = parseArgs(['completion']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.completionCommand).toEqual({ shell: null, requested: null });
  });

  it('未知 shell 保留原始输入，由命令报用法错误', () => {
    const parsed = parseArgs(['completion', 'tcsh']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.completionCommand).toEqual({ shell: null, requested: 'tcsh' });
  });

  it('completion --help 走全局 help', () => {
    const parsed = parseArgs(['completion', '--help']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.help).toBe(true);
    expect(parsed.args.completionCommand).toBeNull();
  });
});

describe('CLI 退出码', () => {
  it('completion bash 输出脚本并退出 0', async () => {
    const result = await runCli(['completion', 'bash']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('_vessel()');
    expect(result.stderr).toBe('');
  });

  it('completion 无参数：用法写 stderr，退出 1', async () => {
    const result = await runCli(['completion']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('vessel completion <bash|zsh|fish|powershell>');
  });

  it('completion 未知 shell：退出 1 并指出输入', async () => {
    const result = await runCli(['completion', 'tcsh']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unknown shell "tcsh"');
    expect(result.stderr).toContain('vessel completion <bash|zsh|fish|powershell>');
  });

  it('--help 列出 completion', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('vessel completion <shell>');
  });
});
