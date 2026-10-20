/**
 * Gateway 系统服务注册（0.12 DECISION-023 §2.2）。
 *
 * - Linux：systemd **user** unit（不需要 root）；
 * - macOS：LaunchAgent plist；
 * - Windows：登录时计划任务（schtasks，避免管理员服务）。
 *
 * 服务运行命令固定为 `vessel gateway start`（不带 `--daemon`，由服务管理器托管）。
 * 只实现当前平台；显式指定其它平台或在不支持平台调用时明确报错，不静默降级。
 *
 * 本模块只负责生成定义与执行命令；测试通过注入 `runCommand` 断言形状，
 * 不实际写入开发机的服务管理器。
 *
 * @module vessel/gateway/service
 */

import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { type CommandRunner, defaultCommandRunner } from './pid';

/** 支持的服务管理器 */
export type ServiceTarget = 'systemd' | 'launchd' | 'schtasks';

/** Windows 计划任务名（冻结） */
export const SCHTASKS_TASK_NAME = 'VesselGateway';

/** 服务命令（冻结；服务管理器负责常驻） */
export const SERVICE_COMMAND = 'vessel gateway start';

/** 服务定义上下文 */
export interface ServiceContext {
  dataDir: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  runCommand?: CommandRunner;
}

/** 生成结果 */
export interface ServiceDefinition {
  target: ServiceTarget;
  /** 文件路径；Windows 计划任务没有文件（undefined） */
  path?: string;
  content: string;
  install: string[][];
  uninstall: string[][];
  logPath: string;
}

export type ServiceResult =
  | { ok: true; target: ServiceTarget; path?: string }
  | { ok: false; target: ServiceTarget | null; error: string };

export type ServiceStatus =
  | { supported: true; target: ServiceTarget; installed: boolean; path?: string }
  | { supported: false };

/** 当前平台对应的 target；不支持的平台返回 null */
export function serviceTargetForPlatform(platform: NodeJS.Platform): ServiceTarget | null {
  if (platform === 'linux') return 'systemd';
  if (platform === 'darwin') return 'launchd';
  if (platform === 'win32') return 'schtasks';
  return null;
}

/** 平台名 → 可读说明（错误信息用） */
function platformLabel(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform;
}

/** 解析 target：缺省取当前平台；显式指定必须与当前平台一致 */
export function resolveServiceTarget(
  platform: NodeJS.Platform,
  requested?: ServiceTarget,
): { ok: true; target: ServiceTarget } | { ok: false; error: string } {
  const current = serviceTargetForPlatform(platform);
  if (requested !== undefined) {
    if (current === null) {
      return {
        ok: false,
        error:
          `service registration is not supported on ${platformLabel(platform)}; ` +
          `run ${SERVICE_COMMAND} under your own process supervisor`,
      };
    }
    if (requested !== current) {
      return {
        ok: false,
        error:
          `--${requested} does not match this platform (${platformLabel(platform)} uses --${current}); ` +
          'run the command on the target platform',
      };
    }
    return { ok: true, target: requested };
  }
  if (current === null) {
    return {
      ok: false,
      error:
        `service registration is not supported on ${platformLabel(platform)}; ` +
        `run ${SERVICE_COMMAND} under your own process supervisor`,
    };
  }
  return { ok: true, target: current };
}

/** 服务定义路径 */
export function serviceDefinitionPath(
  target: ServiceTarget,
  homeDir: string = os.homedir(),
): string | undefined {
  if (target === 'systemd') {
    return path.join(homeDir, '.config', 'systemd', 'user', 'vessel-gateway.service');
  }
  if (target === 'launchd') {
    return path.join(homeDir, 'Library', 'LaunchAgents', 'com.vessel.gateway.plist');
  }
  return undefined;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 生成服务定义（纯函数） */
export function buildServiceDefinition(
  target: ServiceTarget,
  context: Pick<ServiceContext, 'dataDir' | 'homeDir'>,
): ServiceDefinition {
  const homeDir = context.homeDir ?? os.homedir();
  const logPath = path.join(context.dataDir, 'logs', 'gateway.log');
  const filePath = serviceDefinitionPath(target, homeDir);

  if (target === 'systemd') {
    const unitPath = filePath as string;
    const content = [
      '[Unit]',
      'Description=Vessel Gateway',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=/usr/bin/env ${SERVICE_COMMAND}`,
      'Restart=on-failure',
      'RestartSec=5',
      `StandardOutput=append:${logPath}`,
      `StandardError=append:${logPath}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return {
      target,
      path: unitPath,
      content,
      logPath,
      install: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', 'vessel-gateway.service'],
      ],
      uninstall: [
        ['systemctl', '--user', 'disable', '--now', 'vessel-gateway.service'],
        ['systemctl', '--user', 'daemon-reload'],
      ],
    };
  }

  if (target === 'launchd') {
    const plistPath = filePath as string;
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ',
      '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      '  <string>com.vessel.gateway</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>/bin/sh</string>',
      '    <string>-lc</string>',
      `    <string>${SERVICE_COMMAND}</string>`,
      '  </array>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      '  <true/>',
      '  <key>StandardOutPath</key>',
      `  <string>${xmlEscape(logPath)}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${xmlEscape(logPath)}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return {
      target,
      path: plistPath,
      content,
      logPath,
      install: [['launchctl', 'load', '-w', plistPath]],
      uninstall: [['launchctl', 'unload', '-w', plistPath]],
    };
  }

  return {
    target,
    content: '',
    logPath,
    install: [
      [
        'schtasks',
        '/Create',
        '/F',
        '/SC',
        'ONLOGON',
        '/TN',
        SCHTASKS_TASK_NAME,
        '/TR',
        SERVICE_COMMAND,
      ],
    ],
    uninstall: [['schtasks', '/Delete', '/F', '/TN', SCHTASKS_TASK_NAME]],
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 顺序执行命令；首个失败即返回错误 */
async function runAll(
  commands: string[][],
  runCommand: CommandRunner,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const argv of commands) {
    const result = await runCommand(argv);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      return {
        ok: false,
        error:
          `command failed (exit ${result.exitCode}): ${argv.join(' ')}` +
          (detail ? `\n${detail}` : ''),
      };
    }
  }
  return { ok: true };
}

/** 安装/更新系统服务 */
export async function installService(
  target: ServiceTarget,
  context: ServiceContext,
): Promise<ServiceResult> {
  const definition = buildServiceDefinition(target, context);
  const runCommand = context.runCommand ?? defaultCommandRunner;

  if (definition.path) {
    await mkdir(path.dirname(definition.path), { recursive: true });
    await writeFile(definition.path, definition.content, 'utf8');
  }

  const result = await runAll(definition.install, runCommand);
  if (!result.ok) return { ok: false, target, error: result.error };
  return {
    ok: true,
    target,
    ...(definition.path !== undefined ? { path: definition.path } : {}),
  };
}

/** 卸载系统服务（缺失视为已卸载） */
export async function uninstallService(
  target: ServiceTarget,
  context: ServiceContext,
): Promise<ServiceResult> {
  const definition = buildServiceDefinition(target, context);
  const runCommand = context.runCommand ?? defaultCommandRunner;

  // 文件存在才执行管理命令；Windows 计划任务没有文件，总是尝试删除。
  const present = definition.path ? await exists(definition.path) : true;
  if (present) {
    for (const argv of definition.uninstall) {
      const result = await runCommand(argv);
      // 反注册的“未安装”错误不应阻止删除残留文件
      if (result.exitCode !== 0 && definition.target !== 'schtasks') {
        const detail = (result.stderr || result.stdout).trim();
        if (!/not (loaded|found|enabled)|No such file/i.test(detail)) {
          return {
            ok: false,
            target,
            error: `command failed (exit ${result.exitCode}): ${argv.join(' ')}\n${detail}`,
          };
        }
      }
    }
  }

  if (definition.path && present) {
    try {
      await unlink(definition.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          ok: false,
          target,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (target === 'systemd') {
      await runCommand(['systemctl', '--user', 'daemon-reload']);
    }
  }

  return {
    ok: true,
    target,
    ...(definition.path !== undefined ? { path: definition.path } : {}),
  };
}

/** 服务注册状态（只读） */
export async function serviceStatus(
  platform: NodeJS.Platform,
  context: Omit<ServiceContext, 'platform'>,
): Promise<ServiceStatus> {
  const target = serviceTargetForPlatform(platform);
  if (target === null) return { supported: false };

  if (target === 'schtasks') {
    const runCommand = context.runCommand ?? defaultCommandRunner;
    const result = await runCommand(['schtasks', '/Query', '/TN', SCHTASKS_TASK_NAME]);
    return { target, supported: true, installed: result.exitCode === 0 };
  }

  const filePath = serviceDefinitionPath(target, context.homeDir ?? os.homedir()) as string;
  let installed = await exists(filePath);
  if (installed && target === 'systemd') {
    // unit 文件存在但内容不是本工具写的不算注册（避免误报）
    try {
      const content = await readFile(filePath, 'utf8');
      installed = content.includes(SERVICE_COMMAND);
    } catch {
      installed = false;
    }
  }
  return { target, supported: true, installed, path: filePath };
}
