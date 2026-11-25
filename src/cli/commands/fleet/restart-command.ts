/**
 * `vessel restart [name]`：docker 式 stop → start 编排（用户裁定 #6，cli-topology-design §7）。
 *
 * 名称解析（instance name / node name / dataDir 别名）：
 * - 给 name：先按本舰队 gateway 实例名匹配（collectGatewayState entries.instance）；
 *   命中 → 重启该实例（stop 整实例舰队 → start 平台 daemon）。未命中再按 registry
 *   node 名匹配 → 委托 `node restart` 接缝（只重启该 node）。都不命中 → 如实报错。
 * - 不给 name：缺省本舰队全量（空选择器归一 {all:true}，与 vessel stop 同口径）；
 *   `--instance/--port/--all` 收窄。
 *
 * 语义（D11）：stop 段复用各组件共享接缝（stopGateway，默认优雅不限时 + 进度，
 * --force 传播）；**stop 未全成 → 不 start**（防双跑/端口冲突），如实报告 + 提示
 * --force 升级。start 段复用既有 daemon start 接缝（startDaemonCommand / node daemon），
 * 不新造 start 面（start/ps 命令面归 q-cli-ps）。确认一次覆盖 stop+start（S3 规则）。
 *
 * 舰队边界（§3）：清点/操作严格限本舰队 dataDir；跨舰队恒走显式 --user-config/--data-dir。
 *
 * @module vessel/restart-command
 */

import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, type VesselConfig } from '../../../../packages/config/src/index';
import { resolveDataDir } from '../../../data/data-paths';
import { isHumanTerminal } from '../../../gateway/gateway-banner';
import { loadNodeRegistry } from '../../../gateway/node-registry';
import {
  collectGatewayState,
  type GatewayPidRecord,
  type GatewayStateEntry,
  isProcessAlive,
  readGatewayPidRecord,
} from '../../../gateway/pid';
import { gatewayBaseUrl } from '../../../gateway/reload';
import {
  clearSelfRestartHandoff,
  isSelfRestartHandoffStale,
  readSelfRestartHandoff,
  SELF_RESTART_WAIT_MS,
  type SelfRestartHandoff,
  writeSelfRestartHandoff,
} from '../../../gateway/self-restart';
import { resolveGatewayToken } from '../../../gateway/transport-factory';
import { t } from '../../../i18n';
import { effectiveNodeTokenAuto } from '../../../node/token-derive';
import { createHttpRpcClient } from '../../../rpc/http-client';
import type { GatewaySelector } from '../../args';
import { ui } from '../../output';
import {
  type GatewayCommandDeps,
  resolveGatewayTargets,
  startDaemonCommand,
  stopGateway,
} from '../gateway/gateway-command';
import { nodeRestartCommand } from '../node-command';

/** 冻结签名；接线方 = src/cli/registry.ts。 */
export interface RestartFleetOptions extends GatewayCommandDeps {
  /** 位置参数目标名（instance / node）；缺省 = 本舰队全量。 */
  name?: string;
  yes?: boolean;
  force?: boolean;
  timeoutMs?: number;
  selector?: GatewaySelector;
  /** 自重启 Option A：预约即返回「正在重启」，detached 编排者等触发者 run 终态后执行。 */
  self?: boolean;
  /** --self 的续作嘱托（重启后首轮输入）。 */
  prompt?: string;
  /** 触发者会话（缺省 env VESSEL_SESSION_ID）。 */
  session?: string;
  /** 触发者 run（缺省 env VESSEL_RUN_ID）。 */
  run?: string;
  /** 编排者等待预算（缺省 120s）。 */
  waitTimeoutMs?: number;
  /** 内部：编排者模式（wait→stop→start）。 */
  orchestrate?: boolean;
  /** 内部：交接文件所在 dataDir。 */
  handoff?: string;
}

/**
 * `vessel restart [name]`：返回退出码。
 * 0 = 重启成功 / 本无运行且启动成功 / 用户取消；1 = 任一失败、非交互无 --yes 拒绝、stop 未全成。
 */
export async function restartFleetCommand(options: RestartFleetOptions = {}): Promise<number> {
  const { name, yes, force, timeoutMs, selector: selectorOption, ...deps } = options;
  const env = deps.env ?? process.env;
  const print = deps.print ?? console.log;
  const printErr = deps.printErr ?? console.error;
  let config: VesselConfig;
  if (deps.config !== undefined) {
    config = deps.config;
  } else {
    const loaded = await loadConfig({ env });
    config = loaded.config;
    for (const warning of loaded.validation.warnings) {
      printErr(ui.warn(`⚠ ${warning.message}`));
    }
  }
  const dataDir = deps.dataDir ?? resolveDataDir(config, env);
  const token = resolveGatewayToken(config, env);
  // 自重启 Option A：编排者模式（内部，detached 进程）/ 预约模式（--self，早返回）。
  if (options.orchestrate === true) {
    return restartOrchestrateCommand({
      deps,
      env,
      config,
      dataDir,
      handoffDir: options.handoff ?? dataDir,
      print,
      printErr,
    });
  }
  if (options.self === true) {
    return selfRestartReserveCommand({
      deps,
      env,
      config,
      dataDir,
      prompt: options.prompt ?? '',
      ...(options.session !== undefined ? { session: options.session } : {}),
      ...(options.run !== undefined ? { run: options.run } : {}),
      ...(options.waitTimeoutMs !== undefined ? { waitTimeoutMs: options.waitTimeoutMs } : {}),
      selector: options.selector,
      print,
      printErr,
    });
  }
  const kind = deps.stateKind ?? (env.VESSEL_LEGACY_SERVE === '1' ? 'node' : 'platform');
  const collect = deps.collectState ?? collectGatewayState;
  const snapshot = await collect(dataDir, {
    ...(token !== undefined ? { token } : {}),
    kind,
  });
  const entries = snapshot.entries;

  print(ui.info(t('restart.inventory.title', { dataDir })));
  // 指路（审计 P0）：平台代码更新优先 gateway restart（handoff 保 node、run 不断）；
  // 本命令是舰队冷重启。只对缺省整舰队/选择器路径提示（name 定向 node 走 node restart）。
  if (name === undefined) print(ui.info(t('restart.platformHint')));

  // ── 名称解析：instance 优先，其次 registry node 名（委托 node restart）。──
  if (name !== undefined && name.trim() !== '') {
    const trimmed = name.trim();
    const instanceMatch = entries.find((entry) => entry.instance === trimmed);
    if (instanceMatch !== undefined) {
      return restartInstances({
        deps,
        env,
        entries: [instanceMatch],
        yes,
        force,
        timeoutMs,
        print,
        printErr,
      });
    }
    const registry = await loadNodeRegistry(dataDir).catch(() => undefined);
    if (registry?.kind === 'ready') {
      const node = registry.registry.nodes.find((item) => item.name === trimmed);
      if (node !== undefined) {
        // node 名命中 → 只重启该 node（用该 node 自己的 dataDir，§3.1 规则 4）。
        return nodeRestartCommand({ ...deps, dataDir: node.data_dir }, force === true);
      }
    }
    printErr(ui.err(t('restart.unknownTarget', { name: trimmed, dataDir })));
    return 1;
  }

  // ── 无 name：选择器（缺省全量）→ 重启本舰队实例。──
  const raw = selectorOption ?? {};
  const selector: GatewaySelector =
    raw.instance === undefined && raw.port === undefined ? { all: true } : raw;
  const targets = await resolveGatewayTargets(dataDir, selector, { entries });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }
  return restartInstances({
    deps,
    env,
    entries: targets.entries,
    yes,
    force,
    timeoutMs,
    print,
    printErr,
  });
}

/** 重启一组实例：确认 → stop（优雅/force）→ 全成才 start → 汇总。 */
async function restartInstances(input: {
  deps: GatewayCommandDeps;
  env: Record<string, string | undefined>;
  entries: GatewayStateEntry[];
  yes?: boolean;
  force?: boolean;
  timeoutMs?: number;
  print: (line: string) => void;
  printErr: (line: string) => void;
}): Promise<number> {
  const { deps, entries, print, printErr } = input;
  // 停前快照：保留每个实例的 instance/port/host（start 段原样恢复）。
  const previous = entries.map((entry) => ({
    instance: entry.instance,
    port: entry.record?.port,
    host: entry.record?.host,
  }));

  for (const entry of entries) {
    const pid = entry.record?.pid ?? entry.lock?.pid ?? '-';
    print(t('restart.inventory.instance', { instance: entry.instance, state: entry.state, pid }));
  }
  if (entries.length === 0) {
    // 本无运行：docker restart 仍会 start（幂等启动）。直接进 start 段。
    print(ui.info(t('restart.nothingRunning')));
  } else {
    print(ui.warn(t('stop.warning.activeSessions')));
    const decision = await confirmRestart(input.yes, print, printErr);
    if (decision === 'refused') return 1;
    if (decision === 'cancelled') return 0;
  }

  // ── stop 段（D11：未全成不 start）。复用 stopGateway 共享接缝（优雅不限时 + 进度 / force）。──
  if (entries.length > 0) {
    const selector: GatewaySelector =
      entries.length === 1 && previous[0] !== undefined
        ? { instance: previous[0].instance }
        : { all: true };
    const stopCode = await stopGateway({
      ...deps,
      keepNodes: false,
      selector,
      entries,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.force === true ? { force: true } : {}),
    });
    if (stopCode !== 0) {
      printErr(ui.err(t('restart.stopFailed')));
      return stopCode;
    }
  }

  // ── start 段：复用既有 daemon start 接缝（不新造 start 面）。──
  let failed = false;
  if (previous.length === 0) {
    // 本无运行实例：按缺省实例启动（与 gateway start 缺省同口径）。
    const code = await startDaemonCommand({ ...deps });
    if (code !== 0) failed = true;
  } else {
    for (const target of previous) {
      print(ui.info(t('restart.starting', { instance: target.instance })));
      const code = await startDaemonCommand({
        ...deps,
        instance: target.instance,
        ...(target.port !== undefined ? { port: target.port } : {}),
        ...(target.host !== undefined ? { host: target.host } : {}),
      });
      if (code !== 0) failed = true;
    }
  }
  if (failed) {
    printErr(ui.err(t('restart.failed')));
    return 1;
  }
  print(ui.ok(t('restart.done')));
  return 0;
}

/**
 * S3 确认（与 stop 同规则）：--yes 跳过；非交互且无 --yes → 拒绝 exit 1；
 * 交互 y/N，N/EOF → 取消 exit 0（零进程被动）。
 */
async function confirmRestart(
  yes: boolean | undefined,
  print: (line: string) => void,
  printErr: (line: string) => void,
): Promise<'proceed' | 'cancelled' | 'refused'> {
  if (yes === true) return 'proceed';
  if (!isHumanTerminal()) {
    printErr(ui.err(t('stop.nonInteractive')));
    return 'refused';
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let confirmed = false;
  try {
    const answer = await rl.question(t('restart.confirm.prompt'));
    confirmed = /^(y|yes)$/i.test(answer.trim());
  } catch {
    confirmed = false;
  } finally {
    rl.close();
  }
  if (confirmed) return 'proceed';
  print(ui.info(t('stop.cancelled')));
  return 'cancelled';
}

// ── 自重启 Option A（runlost-graceful-restart-audit §4.2）──────────────
//
// 等待方向反转（I2）：restart 等触发者 run 到终态，触发者 run 不等 restart。
// `--self` 受理（写 continuation 标记）+ spawn detached 编排者后**立即返回**，
// 模型收尾本回合 → run 自然完成 → 编排者才动手 stop（drain 集合里没有触发者，
// 编排者悖论从根上不存在）。编排者不是被杀进程的后代（I1）：POSIX detached
// 自成进程组、CLI 退出后 reparent；Windows/WSL 在 VM 内，不在 Windows 进程树。

/** 预约受理的输入（restartFleetCommand 解析后转交）。 */
interface SelfRestartReserveInput {
  deps: GatewayCommandDeps;
  env: Record<string, string | undefined>;
  config: VesselConfig;
  dataDir: string;
  prompt: string;
  session?: string;
  run?: string;
  waitTimeoutMs?: number;
  selector?: GatewaySelector;
  print: (line: string) => void;
  printErr: (line: string) => void;
}

/** node RPC 短客户端（预约 / 编排者共用；回环 http，与 node stop 同口径）。 */
function nodeRpcClient(record: GatewayPidRecord, token: string, tls = false) {
  return createHttpRpcClient({
    baseUrl: gatewayBaseUrl(record, tls),
    token,
    subscribe: false,
    requestTimeoutMs: 5_000,
  });
}

/** node 生效 token（显式 > VESSEL_NODE_TOKEN > 派生；与 node stop 同口径）。 */
function nodeTokenFor(
  config: VesselConfig,
  dataDir: string,
  env: Record<string, string | undefined>,
): string {
  const resolved = effectiveNodeTokenAuto({ config, dataDir, env });
  return resolved.ok ? (resolved.value.token ?? '') : '';
}

/**
 * `vessel restart --self --prompt <嘱托>`：预约自重启，**立即返回**。
 *
 * 序列：认触发者（flags > env VESSEL_SESSION_ID/VESSEL_RUN_ID，bash 工具注入）
 * → node RPC 写 continuation 标记（RunJournal 单写口）→ 写交接文件 →
 * spawn detached 编排者 → 回填编排者 pid → 返回「正在重启，请收尾本回合」。
 */
async function selfRestartReserveCommand(input: SelfRestartReserveInput): Promise<number> {
  const { deps, env, config, dataDir, print, printErr } = input;
  const sessionId = input.session ?? env.VESSEL_SESSION_ID ?? '';
  const runId = input.run ?? env.VESSEL_RUN_ID;
  if (sessionId === '') {
    printErr(
      ui.err(
        'restart --self: cannot identify the triggering session ' +
          '(pass --session <id> or run inside a bash tool call which injects VESSEL_SESSION_ID)',
      ),
    );
    return 1;
  }
  if (input.prompt.trim() === '') {
    printErr(ui.err('restart --self: --prompt must be non-empty (continuation after restart)'));
    return 1;
  }

  // 触发者 node 的监听记录（隐式拓扑 node dataDir == 舰队 dataDir）。
  const nodeRecord = await readGatewayPidRecord(dataDir);
  if (nodeRecord === null || !isProcessAlive(nodeRecord.pid)) {
    printErr(ui.err(`restart --self: no running node in ${dataDir} (gateway.pid absent or dead)`));
    return 1;
  }
  const token = nodeTokenFor(config, dataDir, env);
  const client = nodeRpcClient(nodeRecord, token, config.node?.tls !== undefined);
  let accepted: { run_id?: string };
  try {
    accepted = (await client.request('node.restart.self', {
      session_id: sessionId,
      ...(runId !== undefined && runId !== '' ? { run_id: runId } : {}),
      prompt: input.prompt,
    })) as { run_id?: string };
  } catch (error) {
    printErr(ui.err(`restart --self: reservation rejected: ${String(error)}`));
    return 1;
  } finally {
    await client.close().catch(() => undefined);
  }
  const triggeringRunId = accepted.run_id ?? runId ?? '';
  if (triggeringRunId === '') {
    printErr(ui.err('restart --self: node did not return the triggering run_id'));
    return 1;
  }

  // stop/start 目标：本 dataDir 的平台实例（缺省全量；--instance/--port 收窄）。
  const snapshot = await collectGatewayState(dataDir, {
    kind: 'platform',
    ...(token !== '' ? { token } : {}),
  });
  const targets = await resolveGatewayTargets(dataDir, input.selector ?? { all: true }, {
    entries: snapshot.entries,
  });
  if (!targets.ok) {
    printErr(ui.err(targets.error));
    return 1;
  }
  if (targets.entries.length === 0) {
    printErr(
      ui.err(
        'restart --self: no platform gateway in this dataDir ' +
          '(standalone node: self-restart requires the platform topology)',
      ),
    );
    return 1;
  }

  const handoff: SelfRestartHandoff = {
    kind: 'self-restart',
    requested_at: Date.now(),
    ttl_ms: 10 * 60_000,
    session_id: sessionId,
    run_id: triggeringRunId,
    prompt: input.prompt,
    wait_timeout_ms: input.waitTimeoutMs ?? SELF_RESTART_WAIT_MS,
    node: { data_dir: dataDir, pid: nodeRecord.pid },
    targets: targets.entries.map((entry) => ({
      instance: entry.instance,
      ...(entry.record?.port !== undefined ? { port: entry.record.port } : {}),
      ...(entry.record?.host !== undefined ? { host: entry.record.host } : {}),
    })),
  };
  await writeSelfRestartHandoff(dataDir, handoff);

  // detached 编排者：脱离被杀进程树（I1），CLI 立即退出也不影响它。
  const entryPath = process.argv[1];
  if (entryPath === undefined || entryPath === '') {
    await clearSelfRestartHandoff(dataDir);
    printErr(ui.err('restart --self: cannot resolve the vessel entry script (process.argv[1])'));
    return 1;
  }
  const logPath = path.join(dataDir, 'logs', 'self-restart-orchestrator.log');
  const spawn = deps.spawn ?? Bun.spawn;
  let orchestratorPid: number;
  try {
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const handle = await open(logPath, 'a', 0o600);
    try {
      const proc = spawn(
        [process.execPath, entryPath, 'restart', '--orchestrate', '--data-dir', dataDir],
        {
          stdin: 'ignore',
          stdout: handle.fd,
          stderr: handle.fd,
          detached: true,
          windowsHide: true,
          env: { ...process.env, VESSEL_DATA_DIR: dataDir },
        },
      );
      proc.unref();
      orchestratorPid = proc.pid;
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    await clearSelfRestartHandoff(dataDir);
    printErr(ui.err(`restart --self: failed to spawn the orchestrator: ${String(error)}`));
    return 1;
  }
  await writeSelfRestartHandoff(dataDir, { ...handoff, orchestrator_pid: orchestratorPid });

  print(
    ui.ok(
      `restart reserved (orchestrator pid ${orchestratorPid}): it will wait for your run ` +
        `(${triggeringRunId}) to finish, then gracefully stop and start the fleet. ` +
        'Finish this turn now — your continuation prompt is persisted and will be delivered ' +
        'as the first input after restart. Inbox notes are supplementary only.',
    ),
  );
  return 0;
}

/** 编排者输入（detached 进程内执行）。 */
interface RestartOrchestrateInput {
  deps: GatewayCommandDeps;
  env: Record<string, string | undefined>;
  config: VesselConfig;
  dataDir: string;
  handoffDir: string;
  print: (line: string) => void;
  printErr: (line: string) => void;
}

const ORCHESTRATE_POLL_MS = 2_000;

/** run 终态判定：queued/running 之外都是终态（completed/failed/cancelled/interrupted）。 */
function isTerminalRunStatus(status: unknown): boolean {
  return typeof status === 'string' && status !== 'queued' && status !== 'running';
}

/**
 * `vessel restart --orchestrate`（内部）：读交接文件 → 等触发者 run 终态（有界）
 * → 优雅 stop（drain-to-quiesce，触发者已终态不在等待集）→ start → 清交接文件。
 *
 * fail-safe（审计 §4.2）：等待超时 ⇒ 撤销 continuation 标记 + 不重启，旧进程继续跑；
 * 触发者 node 已死（崩溃）⇒ 照样 stop/start（启动恢复走有疤路径）。
 */
async function restartOrchestrateCommand(input: RestartOrchestrateInput): Promise<number> {
  const { deps, env, config, dataDir, handoffDir, print, printErr } = input;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const handoff = await readSelfRestartHandoff(handoffDir);
  if (handoff === null) {
    printErr(ui.err(`restart --orchestrate: no valid handoff in ${handoffDir}`));
    return 1;
  }
  if (isSelfRestartHandoffStale(handoff)) {
    await clearSelfRestartHandoff(handoffDir);
    printErr(ui.err('restart --orchestrate: handoff expired (orchestrator stale); not restarting'));
    return 1;
  }
  print(
    ui.info(
      `self-restart orchestrator: session=${handoff.session_id} run=${handoff.run_id} ` +
        `wait_budget=${handoff.wait_timeout_ms}ms targets=${handoff.targets.map((x) => x.instance).join(',')}`,
    ),
  );

  // ── wait：轮询触发者 run 至终态（有界；超时不重启）。──
  const nodeToken = nodeTokenFor(config, handoff.node.data_dir, env);
  const deadline = Date.now() + Math.max(0, handoff.wait_timeout_ms);
  for (;;) {
    if (!isProcessAlive(handoff.node.pid)) {
      print(
        ui.warn(
          'self-restart orchestrator: triggering node already dead; proceeding (scarred recovery)',
        ),
      );
      break;
    }
    const record = await readGatewayPidRecord(handoff.node.data_dir);
    if (record !== null && record.pid === handoff.node.pid) {
      const client = nodeRpcClient(record, nodeToken, config.node?.tls !== undefined);
      try {
        const result = (await client.request('runs.get', { run_id: handoff.run_id })) as {
          run?: { status?: unknown };
        };
        if (isTerminalRunStatus(result.run?.status)) {
          print(
            ui.info(
              `self-restart orchestrator: triggering run terminal (${String(result.run?.status)})`,
            ),
          );
          break;
        }
      } catch (error) {
        // not_found = 记录缺失（视为终态缺失，交给启动对账）；网络抖动继续轮询。
        if (String(error).includes('not_found')) {
          print(ui.warn('self-restart orchestrator: triggering run record missing; proceeding'));
          break;
        }
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    if (Date.now() >= deadline) {
      // fail-safe：撤销预约（清 continuation 标记），不重启，旧进程继续服务。
      if (record !== null) {
        const client = nodeRpcClient(record, nodeToken, config.node?.tls !== undefined);
        try {
          await client.request('node.restart.self', {
            session_id: handoff.session_id,
            cancel: true,
          });
        } catch {
          // 撤销失败不阻断退出：标记留着，下次启动续作投递仍会判终态。
        } finally {
          await client.close().catch(() => undefined);
        }
      }
      await clearSelfRestartHandoff(handoffDir);
      printErr(
        ui.err(
          `self-restart orchestrator: run ${handoff.run_id} still active after ` +
            `${handoff.wait_timeout_ms}ms; restart ABORTED (old process untouched)`,
        ),
      );
      return 1;
    }
    await sleep(ORCHESTRATE_POLL_MS);
  }

  // ── stop：优雅（drain-to-quiesce）；触发者已终态，不在 drain 等待集。──
  const snapshot = await collectGatewayState(dataDir, {
    kind: 'platform',
    ...(nodeToken !== '' ? { token: nodeToken } : {}),
  });
  const wanted = new Set(handoff.targets.map((target) => target.instance));
  const entries = snapshot.entries.filter((entry) => wanted.has(entry.instance));
  if (entries.length > 0) {
    const selector: GatewaySelector =
      entries.length === 1 && entries[0] !== undefined
        ? { instance: entries[0].instance }
        : { all: true };
    const stopCode = await stopGateway({
      ...deps,
      keepNodes: false,
      selector,
      entries,
    });
    if (stopCode !== 0) {
      await clearSelfRestartHandoff(handoffDir);
      printErr(ui.err('self-restart orchestrator: stop failed; NOT starting (no double-run)'));
      return stopCode;
    }
  } else {
    print(ui.warn('self-restart orchestrator: no matching platform entries at stop time'));
  }

  // ── start：复用既有 daemon start 接缝（原实例/端口恢复）。──
  let failed = false;
  for (const target of handoff.targets) {
    print(ui.info(`self-restart orchestrator: starting ${target.instance}`));
    const code = await startDaemonCommand({
      ...deps,
      instance: target.instance,
      ...(target.port !== undefined ? { port: target.port } : {}),
      ...(target.host !== undefined ? { host: target.host } : {}),
    });
    if (code !== 0) failed = true;
  }
  await clearSelfRestartHandoff(handoffDir);
  if (failed) {
    printErr(ui.err('self-restart orchestrator: start failed (see instance logs)'));
    return 1;
  }
  print(
    ui.ok('self-restart orchestrator: restart complete; continuation will be delivered at startup'),
  );
  return 0;
}
