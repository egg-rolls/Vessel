/**
 * `vessel update [--check] [--yes] [--channel latest|beta] [--json]`
 *
 * - `--check`：只检查新版本（0.1 行为不变）；
 * - 无 `--check`：按安装形态自更新（0.12 DECISION-023 §2.4）：
 *   npm 全局 → `npm i -g vessel-agent@<latest|beta>`；bun 全局 → `bun add -g`；
 *   源码/开发模式 → 只提示 `git pull && bun install`，不改工作区。
 *   安装目标按解析后的通道选择 dist-tag，beta 通道装 `vessel-agent@beta`。
 *
 * 默认先确认；`--yes` 跳过；非 TTY 无 `--yes` 直接失败。失败返回非 0。
 * 退出码：0 成功（含已最新 / dev 提示）、1 网络/清单/安装失败、2 参数/通道错误。
 */

import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../packages/config/src/index';
import { t } from './i18n';
import { ui } from './ui-style';
import { checkForUpdate } from './update/check';
import { buildInstallPlan, detectInstallForm, type InstallForm } from './update/install-detect';
import type { UpdateChannel } from './update/manifest';
import { readPackageVersion } from './version';

export interface UpdateCommandOptions {
  check: boolean;
  channel?: UpdateChannel;
  json: boolean;
  force: boolean;
  /** 0.12：跳过自更新确认 */
  yes?: boolean;
}

/** 命令结果 */
export interface UpdateCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 自更新测试注入 */
export interface UpdateCommandDeps {
  entryPath?: string;
  exists?: (filePath: string) => boolean;
  /** 安装命令执行器；`capture` 为 true 时收集输出（--json） */
  runCommand?: (argv: string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  /** 交互确认（缺省 readline） */
  confirm?: (question: string) => Promise<boolean>;
  stdinIsTTY?: boolean;
  /** 强制安装形态（测试） */
  form?: InstallForm;
  /** 配置加载（测试注入；缺省 loadConfig） */
  loadConfig?: () => Promise<{
    config: { update?: { channel?: UpdateChannel; source?: string } };
  }>;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}

async function defaultRunCommand(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const proc = Bun.spawn(argv, {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return { exitCode: await proc.exited, stdout: '', stderr: '' };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function captureRunCommand(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const proc = Bun.spawn(argv, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** 自更新：返回退出码（导出供测试注入；不读配置） */
export async function runSelfUpdate(
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps = {},
): Promise<number> {
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  const form =
    deps.form ??
    detectInstallForm({
      ...(deps.entryPath !== undefined ? { entryPath: deps.entryPath } : {}),
      ...(deps.exists !== undefined ? { exists: deps.exists } : {}),
    });
  const channel = options.channel ?? 'latest';
  const plan = buildInstallPlan(form, channel);

  if (!plan.command) {
    const hint = plan.hint ?? 'git pull && bun install';
    if (options.json) {
      print(JSON.stringify({ form, updated: false, command: null, hint }, null, 2));
    } else {
      print(t('update.devHint', { hint }));
      print(t('update.restartHint'));
    }
    return 0;
  }

  const argv = plan.command;
  const commandText = argv.join(' ');

  if (options.yes !== true) {
    const tty = deps.stdinIsTTY ?? process.stdin.isTTY === true;
    if (!tty) {
      printErr(t('update.needsYes'));
      return 1;
    }
    const question = `${t('update.confirm', { command: commandText })} [y/N] `;
    const confirmed = await (deps.confirm ?? promptConfirm)(question);
    if (!confirmed) {
      printErr(t('update.cancelled'));
      return 1;
    }
  }

  const runner = deps.runCommand ?? (options.json ? captureRunCommand : defaultRunCommand);
  const result = await runner(argv);

  if (result.exitCode !== 0) {
    printErr(t('update.installFailed', { code: result.exitCode, command: commandText }));
    if (options.json) {
      print(
        JSON.stringify(
          {
            form,
            updated: false,
            command: argv,
            exit_code: result.exitCode,
            output: `${result.stdout}${result.stderr}`.trim().slice(-4000),
          },
          null,
          2,
        ),
      );
    }
    return 1;
  }

  if (options.json) {
    print(
      JSON.stringify(
        {
          form,
          updated: true,
          command: argv,
          exit_code: 0,
          output: `${result.stdout}${result.stderr}`.trim().slice(-4000),
        },
        null,
        2,
      ),
    );
  } else {
    print(ui.ok(t('update.updated', { command: commandText })));
    print(t('update.restartHint'));
  }
  return 0;
}

/** 执行更新命令，返回进程退出码 */
export async function runUpdateCommand(
  options: UpdateCommandOptions,
  deps: UpdateCommandDeps = {},
): Promise<number> {
  const { config } = await (deps.loadConfig ?? loadConfig)();

  const channel = resolveChannel(options.channel, config.update?.channel);
  if (!channel) {
    console.error(t('update.invalidChannel'));
    return 2;
  }

  if (!options.check) {
    return runSelfUpdate({ ...options, channel }, deps);
  }

  const current = readPackageVersion();

  try {
    const result = await checkForUpdate({
      currentVersion: current,
      channel,
      source: process.env.VESSEL_UPDATE_SOURCE ?? config.update?.source,
      timeoutMs: 5000,
    });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            current: result.current,
            latest: result.latest,
            channel: result.channel,
            up_to_date: result.upToDate,
            install_hint: result.installHint,
          },
          null,
          2,
        ),
      );
    } else if (result.upToDate) {
      console.log(ui.ok(t('update.upToDate', { current, channel: result.channel })));
    } else {
      console.log(
        ui.warn(
          t('update.available', {
            current,
            latest: result.latest,
            channel: result.channel,
          }),
        ),
      );
      console.log(result.installHint);
      console.log(t('update.selfHint'));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(t('update.failed', { detail: message }));
    return 1;
  }
}

/** CLI > VESSEL_CHANNEL > 配置 > latest；非法环境变量返回 null */
export function resolveChannel(
  cliChannel: UpdateChannel | undefined,
  configChannel: UpdateChannel | undefined,
): UpdateChannel | null {
  const raw = cliChannel ?? process.env.VESSEL_CHANNEL ?? configChannel ?? 'latest';
  if (raw === 'latest' || raw === 'beta') return raw;
  return null;
}
