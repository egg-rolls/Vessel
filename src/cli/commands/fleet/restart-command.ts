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

import { createInterface } from 'node:readline/promises';
import { loadConfig, type VesselConfig } from '../../../../packages/config/src/index';
import { resolveDataDir } from '../../../data/data-paths';
import { isHumanTerminal } from '../../../gateway/gateway-banner';
import { loadNodeRegistry } from '../../../gateway/node-registry';
import { collectGatewayState, type GatewayStateEntry } from '../../../gateway/pid';
import { resolveGatewayToken } from '../../../gateway/transport-factory';
import { t } from '../../../i18n';
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
  const kind = deps.stateKind ?? (env.VESSEL_LEGACY_SERVE === '1' ? 'node' : 'platform');
  const collect = deps.collectState ?? collectGatewayState;
  const snapshot = await collect(dataDir, {
    ...(token !== undefined ? { token } : {}),
    kind,
  });
  const entries = snapshot.entries;

  print(ui.info(t('restart.inventory.title', { dataDir })));

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
