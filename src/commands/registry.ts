/**
 * CLI 一次性命令注册表
 *
 * 每个命令自己判断是否命中（`match`），命中后执行并返回退出码。
 * cli.ts 只负责解析参数、按顺序匹配、执行与统一落 exitCode；
 * 主 REPL / serve / headless 路径不经过这里。
 */

import { loadConfig, type VesselConfig } from '../../packages/config/src/index';
import { runAgentCommand } from '../agent-command';
import { agentsCommand } from '../agents-command';
import type { CliArgs } from '../cli-args';
import { runUpdateCommand } from '../cli-update';
import { runCompletionCommand } from '../completion-command';
import {
  configInitCommand,
  configPathCommand,
  configSetCommand,
  configShowCommand,
} from '../config-command';
import { resolveDataDir } from '../data-paths';
import { doctorCommand } from '../doctor-command';
import { errorsCommand } from '../errors-command';
import { runEvalCommand } from '../eval-command';
import { isForegroundGatewayCommand, runGatewayCommand } from '../gateway-command';
import { runHubCommand } from '../hub-command';
import { applyLocale } from '../i18n';
import { logsCommand } from '../logs-command';
import { migrateCommand } from '../migrate-command';
import { runPluginCommand } from '../plugin-command';
import { runResumeList } from '../resume-command';
import { statusCommand } from '../status-command';
import { runTeamCommand } from '../team-command';
import {
  tenantCreateCommand,
  tenantGetCommand,
  tenantListCommand,
  tenantUpdateCommand,
} from '../tenant-command';
import { listTools } from '../tools-list';
import { tracePruneCommand } from '../trace-command';
import { ui } from '../ui-style';
import { attentionCommand } from './attention';
import { runFederationCommand } from './federation';

export interface CliCommandContext {
  /** `VESSEL_MOCK=1|true` */
  useMock: boolean;
  /** 已解析配置（入口可注入；hub 等命令缺省自行 loadConfig）。 */
  config?: VesselConfig;
}

export interface CliCommand {
  name: string;
  match(args: CliArgs): boolean;
  /** 返回进程退出码；`undefined` 等价于 0 */
  run(args: CliArgs, ctx: CliCommandContext): Promise<number | undefined>;
}

/** 打印一次性命令结果并返回退出码 */
function printCommandResult(result: { exitCode: number; stdout: string; stderr: string }): number {
  if (result.stdout !== '') console.log(result.stdout);
  if (result.stderr !== '') console.error(ui.err(result.stderr));
  return result.exitCode;
}

/**
 * 一次性命令也尊重 `config.ui.language`（0.10 R2-20）：
 * 配置读取失败时保持入口的 env locale，不阻断命令。
 */
export async function applyCommandLocale(): Promise<void> {
  try {
    const { config } = await loadConfig();
    applyLocale((config.ui as { language?: string } | undefined)?.language);
  } catch {
    // 配置不可读：沿用 VESSEL_LANG / LANG / LC_ALL
  }
}

/** tenant 命令的数据根（本地命令，不 bootstrap） */
async function resolveCommandDataDir(): Promise<string> {
  const { config } = await loadConfig();
  return resolveDataDir(config);
}

/** federation 等本地命令需要同时拿到 dataDir 与已解析配置 */
async function resolveCommandContext(): Promise<{ dataDir: string; config: VesselConfig }> {
  const { config } = await loadConfig();
  return { dataDir: resolveDataDir(config), config };
}

/** `--tools`：列出当前配置下的工具（headless 口径，不需要 Key） */
async function printTools(): Promise<void> {
  const { tools, warnings } = await listTools();
  for (const w of warnings) console.warn(`⚠ ${w}`);
  console.log(ui.section(`Tools (${tools.length}):`));
  for (const t of tools) console.log(`  - ${t.name}: ${t.description}`);
  // 0.15：--tools 是一次性命令，仍按 headless 口径；ask_user 只在交互 REPL / gateway 注册。
  console.log('ask_user (interactive REPL / gateway only)');
}

/**
 * 有序注册表：命中即停。
 * 顺序与迁移前 cli.ts 的短路顺序一致（help/version 在入口处先行处理）。
 */
export const cliCommands: readonly CliCommand[] = [
  {
    name: 'completion',
    match: (args) => args.completionCommand !== null,
    run: async (args) => {
      if (args.completionCommand === null) return 1;
      return runCompletionCommand(args.completionCommand);
    },
  },
  {
    name: 'tools',
    match: (args) => args.tools,
    run: async () => {
      await printTools();
      return 0;
    },
  },
  {
    name: 'update',
    match: (args) => args.update !== null,
    run: async (args) => {
      if (args.update === null) return 1;
      return runUpdateCommand(args.update);
    },
  },
  {
    name: 'resume-run-list',
    match: (args) => args.resumeRunArg === '',
    run: async (args) =>
      runResumeList({
        ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
      }),
  },
  {
    name: 'eval',
    match: (args) => args.eval !== null,
    run: async (args, ctx) => {
      const command = args.eval;
      if (command === null) return 1;
      return runEvalCommand(command, {
        useMock: ctx.useMock,
        ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
      });
    },
  },
  {
    name: 'config',
    match: (args) => args.configCommand !== null,
    run: async (args) => {
      const command = args.configCommand;
      if (command === null) return 1;
      if (command.kind === 'path') {
        return printCommandResult(await configPathCommand({ json: command.json }));
      }
      if (command.kind === 'init') {
        return printCommandResult(
          await configInitCommand({ json: command.json, force: command.force }),
        );
      }
      if (command.kind === 'set') {
        return printCommandResult(
          await configSetCommand(command.key, command.value, { json: command.json }),
        );
      }
      return printCommandResult(
        await configShowCommand({
          json: command.json,
          sources: command.sources,
          ...(command.tenantId !== undefined ? { tenantId: command.tenantId } : {}),
        }),
      );
    },
  },
  {
    name: 'tenant',
    match: (args) => args.tenantCommand !== null,
    run: async (args) => {
      const command = args.tenantCommand;
      if (command === null) return 1;
      const base = { dataDir: await resolveCommandDataDir(), json: command.json };
      const result =
        command.kind === 'list'
          ? await tenantListCommand(base)
          : command.kind === 'get'
            ? await tenantGetCommand(command.id, base)
            : command.kind === 'create'
              ? await tenantCreateCommand(command.id, {
                  ...base,
                  ...(command.name !== undefined ? { name: command.name } : {}),
                })
              : await tenantUpdateCommand(command.id, {
                  ...base,
                  ...(command.name !== undefined ? { name: command.name } : {}),
                  ...(command.status !== undefined ? { status: command.status } : {}),
                });
      return printCommandResult(result);
    },
  },
  {
    name: 'migrate',
    match: (args) => args.migrate !== null,
    run: async (args) => {
      const command = args.migrate;
      if (command === null) return 1;
      return printCommandResult(
        await migrateCommand({
          from: command.from,
          to: command.to,
          apply: command.apply,
          json: command.json,
          ...(command.tenantId !== undefined ? { tenantId: command.tenantId } : {}),
          ...(command.source !== undefined ? { source: command.source } : {}),
        }),
      );
    },
  },
  {
    name: 'trace',
    match: (args) => args.trace !== null,
    run: async (args) => {
      const command = args.trace;
      if (command === null) return 1;
      return printCommandResult(
        await tracePruneCommand({
          dryRun: command.dryRun,
          json: command.json,
          ...(command.tenantId !== undefined ? { tenantId: command.tenantId } : {}),
        }),
      );
    },
  },
  {
    name: 'plugin',
    match: (args) => args.pluginCommand !== null,
    run: async (args) => {
      const command = args.pluginCommand;
      if (command === null) return 1;
      return printCommandResult(await runPluginCommand(command));
    },
  },
  {
    name: 'doctor',
    match: (args) => args.doctorCommand !== null,
    run: async (args) => {
      const command = args.doctorCommand;
      if (command === null) return 1;
      return printCommandResult(await doctorCommand(command));
    },
  },
  {
    name: 'logs',
    match: (args) => args.logsCommand !== null,
    run: async (args) => {
      if (args.logsCommand === null) return 1;
      return printCommandResult(await logsCommand(args.logsCommand));
    },
  },
  {
    name: 'gateway',
    // 前台 start/restart 由 cli.ts 接进 --serve 管线，这里只处理一次性子命令。
    match: (args) => args.gateway !== null && !isForegroundGatewayCommand(args.gateway),
    run: async (args) => {
      const command = args.gateway;
      if (command === null) return 1;
      return runGatewayCommand(command, { exclusive: args.exclusive });
    },
  },
  {
    name: 'hub',
    match: (args) => args.hubCommand !== null && args.hubCommand !== undefined,
    run: async (args, ctx) => {
      const command = args.hubCommand;
      if (command === null || command === undefined) return 1;
      return runHubCommand(command, {
        ...(ctx.config !== undefined ? { config: ctx.config } : {}),
      });
    },
  },
  {
    name: 'status',
    match: (args) => args.statusCommand !== null,
    run: async (args) => {
      if (args.statusCommand === null) return 1;
      return printCommandResult(
        await statusCommand({
          json: args.statusCommand.json,
          connectUrl: args.connectArg,
          connectToken: args.connectTokenArg,
          caFile: args.caArg,
          tenantId: args.tenantArg,
        }),
      );
    },
  },
  {
    name: 'attention',
    match: (args) => args.attentionCommand !== null,
    run: async (args) => {
      const command = args.attentionCommand;
      if (command === null) return 1;
      return printCommandResult(await attentionCommand(command));
    },
  },
  {
    name: 'agent',
    match: (args) => args.agentCommand !== null,
    run: async (args) => {
      const command = args.agentCommand;
      if (command === null) return 1;
      return printCommandResult(
        await runAgentCommand(command, {
          dataDir: await resolveCommandDataDir(),
          ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
        }),
      );
    },
  },
  {
    name: 'team',
    match: (args) => args.teamCommand !== null,
    run: async (args) => {
      const command = args.teamCommand;
      if (command === null) return 1;
      return printCommandResult(
        await runTeamCommand(command, {
          dataDir: await resolveCommandDataDir(),
          ...(args.tenantArg !== null ? { tenantId: args.tenantArg } : {}),
        }),
      );
    },
  },
  {
    name: 'federation',
    match: (args) => args.federationCommand !== null && args.federationCommand !== undefined,
    run: async (args) => {
      const command = args.federationCommand;
      if (command === null || command === undefined) return 1;
      return printCommandResult(await runFederationCommand(command, await resolveCommandContext()));
    },
  },
  {
    name: 'agents',
    match: (args) => args.agentsCommand !== null,
    run: async (args) => {
      if (args.agentsCommand === null) return 1;
      return printCommandResult(
        await agentsCommand({
          json: args.agentsCommand.json,
          connectUrl: args.connectArg,
          connectToken: args.connectTokenArg,
          caFile: args.caArg,
          tenantId: args.tenantArg,
        }),
      );
    },
  },
  {
    name: 'errors',
    match: (args) => args.errorsCommand !== null,
    run: async (args) => {
      const command = args.errorsCommand;
      if (command === null) return 1;
      return printCommandResult(
        await errorsCommand({
          json: command.json,
          ...(command.limit !== undefined ? { limit: command.limit } : {}),
          connectUrl: args.connectArg,
          connectToken: args.connectTokenArg,
          caFile: args.caArg,
          tenantId: args.tenantArg,
        }),
      );
    },
  },
];

/** 按注册顺序返回首个命中的命令 */
export function matchCommand(args: CliArgs): CliCommand | undefined {
  return cliCommands.find((command) => command.match(args));
}
