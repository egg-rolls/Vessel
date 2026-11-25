/**
 * CLI 一次性命令注册表
 *
 * 每个命令自己判断是否命中（`match`），命中后执行并返回退出码。
 * cli.ts 只负责解析参数、按顺序匹配、执行与统一落 exitCode；
 * 主 REPL / serve / headless 路径不经过这里。
 */

import { loadConfig, type VesselConfig } from '../../packages/config/src/index';
import { resolveDataDir } from '../data/data-paths';
import { applyLocale } from '../i18n';
import { listTools } from '../tools-engine/tools-list';
import type { CliArgs } from './args';
import { runAgentCommand } from './commands/agent/agent-command';
import { runAgentInboxCommand } from './commands/agent/agent-inbox-command';
import { agentsCommand } from './commands/agent/agents-command';
import { attentionCommand } from './commands/attention';
import { runUpdateCommand } from './commands/cli-update';
import { runCompletionCommand } from './commands/completion-command';
import {
  configInitCommand,
  configPathCommand,
  configSetCommand,
  configShowCommand,
} from './commands/config-command';
import { runDevCommand } from './commands/dev-command';
import { doctorCommand } from './commands/doctor-command';
import { errorsCommand } from './commands/errors-command';
import { runEvalCommand } from './commands/eval-command';
import { runFederationCommand } from './commands/federation';
import { fleetStatusCommand } from './commands/fleet/fleet-status-command';
import { statusCommand } from './commands/fleet/status-command';
import { stopFleetCommand } from './commands/fleet/stop-command';
import { isForegroundGatewayCommand, runGatewayCommand } from './commands/gateway/gateway-command';
import { runHubCommand } from './commands/hub-command';
import { logsCommand } from './commands/logs-command';
import { migrateCommand } from './commands/migrate-command';
import { modelCommand } from './commands/model';
import { isForegroundNodeCommand, runNodeCommand } from './commands/node-command';
import { runPluginCommand } from './commands/plugin/plugin-command';
import { pruneCommand } from './commands/prune-command';
import { runResumeList } from './commands/resume-command';
import { rpcListCommand } from './commands/rpc-command';
import { runTeamCommand } from './commands/team-command';
// 0.56：`vessel token show|list|rotate`（根密钥 / 派生 token）。
import { tokenListCommand, tokenRotateCommand, tokenShowCommand } from './commands/token-command';
import { tracePruneCommand } from './commands/trace-command';
import { ui } from './output';

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

/** 本地命令的数据根（不 bootstrap） */
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
  const { tools, warnings, aliases } = await listTools();
  for (const w of warnings) console.warn(`⚠ ${w}`);
  console.log(ui.section(`Tools (${tools.length}):`));
  for (const t of tools) console.log(`  - ${t.name}: ${t.description}`);
  // 0.33：headless 也注册 ask（请求落盘后挂起），这里仍不展开它的 schema。
  console.log('ask (interactive REPL / gateway / headless-async; not listed here)');
  // 0.55：旧名不是工具，只在这一版还能用；列出来是为了「改名不静默」。
  if (aliases.length > 0) {
    console.log(ui.section('Deprecated tool-name aliases (still accepted, removed next version):'));
    for (const a of aliases) {
      console.log(`  - ${a.alias} → ${a.target} (deprecated, removed in ${a.removeIn})`);
    }
  }
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
    run: async () => runResumeList({}),
  },
  {
    name: 'eval',
    match: (args) => args.eval !== null,
    run: async (args, ctx) => {
      const command = args.eval;
      if (command === null) return 1;
      return runEvalCommand(command, {
        useMock: ctx.useMock,
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
        }),
      );
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
        }),
      );
    },
  },
  {
    name: 'token',
    match: (args) => (args.tokenCommand ?? null) !== null,
    run: async (args) => {
      const command = args.tokenCommand ?? null;
      if (command === null) return 1;
      if (command.kind === 'show') {
        return printCommandResult(
          await tokenShowCommand(
            {
              purpose: command.purpose,
              ...(command.id !== undefined ? { id: command.id } : {}),
              json: command.json,
            },
            {
              allowNonInteractive: command.allowNonInteractive,
              ...(command.dataDir !== undefined ? { dataDir: command.dataDir } : {}),
            },
          ),
        );
      }
      if (command.kind === 'list') {
        return printCommandResult(
          await tokenListCommand(
            { json: command.json },
            { ...(command.dataDir !== undefined ? { dataDir: command.dataDir } : {}) },
          ),
        );
      }
      return printCommandResult(
        await tokenRotateCommand(
          { yes: command.yes, json: command.json },
          { ...(command.dataDir !== undefined ? { dataDir: command.dataDir } : {}) },
        ),
      );
    },
  },
  {
    name: 'prune',
    match: (args) => args.prune !== null,
    run: async (args) => {
      const command = args.prune;
      if (command === null) return 1;
      return printCommandResult(
        await pruneCommand({
          yes: command.yes,
          dryRun: command.dryRun,
          json: command.json,
          ...(command.olderThanMs !== undefined ? { olderThanMs: command.olderThanMs } : {}),
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
      return runGatewayCommand(command);
    },
  },
  {
    name: 'node',
    // 前台 node start 由 cli.ts 接进 serve 管线；这里只处理一次性子命令。
    match: (args) => args.node !== null && !isForegroundNodeCommand(args.node),
    run: async (args) => {
      const command = args.node;
      if (command === null) return 1;
      return runNodeCommand(command);
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
        }),
      );
    },
  },
  {
    name: 'stop',
    match: (args) => args.stopCommand !== null,
    run: async (args) => {
      const command = args.stopCommand;
      if (command === null) return 1;
      return stopFleetCommand({
        yes: command.yes,
        selector: command.selector,
        timeoutMs: command.timeoutMs,
        connectUrl: args.connectArg,
        connectToken: args.connectTokenArg,
        caFile: args.caArg,
      });
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
    name: 'dev',
    match: (args) => args.devCommand !== null,
    run: async (args) => {
      const command = args.devCommand;
      if (command === null) return 1;
      return printCommandResult(await runDevCommand(command));
    },
  },
  {
    name: 'agent',
    match: (args) => args.agentCommand !== null,
    run: async (args) => {
      const command = args.agentCommand;
      if (command === null) return 1;
      const dataDir = await resolveCommandDataDir();
      return printCommandResult(
        command.kind === 'inbox'
          ? await runAgentInboxCommand(command, { dataDir })
          : await runAgentCommand(command, {
              dataDir,
              connectUrl: args.connectArg,
              connectToken: args.connectTokenArg,
              caFile: args.caArg,
              nodeId: args.nodeTargetArg,
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
          connectUrl: args.connectArg,
          connectToken: args.connectTokenArg,
          caFile: args.caArg,
          nodeId: args.nodeTargetArg,
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
        }),
      );
    },
  },
  {
    name: 'model',
    match: (args) => args.modelCommand !== null,
    run: async (args) => {
      const command = args.modelCommand;
      if (command === null) return 1;
      return printCommandResult(
        await modelCommand(command, {
          connectUrl: args.connectArg,
          connectToken: args.connectTokenArg,
          caFile: args.caArg,
        }),
      );
    },
  },
  {
    name: 'rpc',
    match: (args) => args.rpcCommand !== null && args.rpcCommand !== undefined,
    run: async (args) => {
      const command = args.rpcCommand;
      if (command === null || command === undefined) return 1;
      return printCommandResult(
        await rpcListCommand({
          json: command.json,
          connectUrl: args.connectArg,
          connectToken: args.connectTokenArg,
          caFile: args.caArg,
          nodeId: args.nodeTargetArg,
        }),
      );
    },
  },
  {
    name: 'fleet',
    match: (args) => args.fleetCommand !== null && args.fleetCommand !== undefined,
    run: async (args) => {
      const command = args.fleetCommand;
      if (command === null || command === undefined) return 1;
      return printCommandResult(await fleetStatusCommand({ json: command.json }));
    },
  },
];

/** 按注册顺序返回首个命中的命令 */
export function matchCommand(args: CliArgs): CliCommand | undefined {
  return cliCommands.find((command) => command.match(args));
}
