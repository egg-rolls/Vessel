/**
 * `vessel start` 舰队级启动（cli-single-source T1；topology §4.2/§4.3 形态 A）。
 *
 * 四拍：检测（collectGatewayState 单读入口）→ 分流（running→skipped；
 * stale/absent→startDaemonCommand 共享接缝；unknown/foreign-host→拒绝不动文件）→
 * spawn（复用 startDaemonCommand 全量接缝，平台管线承载 auto_start node/hub）→
 * 健康确认（重读状态；startDaemonCommand 内部等待覆盖 node readiness）。
 *
 * 形态 A（main 裁定）：编排层**不**显式 spawn node/hub（防双跑）；顺序/回滚 =
 * 平台管线现状。不写自己的 pid/lock、不新增状态文件、不新增平台 RPC。
 *
 * K7（fleet-compose 跨批协调点）：codeDir? 预留——加法透传
 * entryPath=<codeDir>/src/cli.ts、execPath（缺省当前 bun）到 startDaemonCommand；
 * 本批只预留 + 透传，compose 后续批经 ctx.fleet.start 消费。
 *
 * @module vessel/start-command
 */

import * as path from 'node:path';
import { loadConfig, type VesselConfig } from '../../../../packages/config/src/index';
import { expandHome, resolveDataDir } from '../../../data/data-paths';
import { loadNodeRegistry } from '../../../gateway/node-registry';
import { collectGatewayState } from '../../../gateway/pid';
import { resolveGatewayToken } from '../../../gateway/transport-factory';
import { t } from '../../../i18n';
import type { GatewaySelector } from '../../args';
import { ui } from '../../output';
import {
  deriveGatewayInstance,
  type GatewayCommandDeps,
  startDaemonCommand,
} from '../gateway/gateway-command';
import { runNodeCommand } from '../node-command';

/** 冻结签名（PLAN §6）；接线方 = command-spec.ts load thunk（vessel start）+ restart start 段（T3）。 */
export interface StartFleetOptions extends GatewayCommandDeps {
  /** 形态一：停前快照恢复（restart 收敛用）；instance/port/host 原样恢复。与 selector/name 互斥。 */
  targets?: readonly { instance: string; port?: number; host?: string }[];
  /** 形态二：选择器（缺省归一 { all: true }）；与 targets/name 互斥。 */
  selector?: GatewaySelector;
  /** 位置参数目标名（instance / registry node）；名称解析在本函数。 */
  name?: string;
  /** 健康确认可选上限；缺省沿用组件 daemon 预算（平台 60s）。到点如实报告不强杀。 */
  timeoutMs?: number;
  /** --yes 兼容 noop（start 缺省无确认，§8.10；非破坏性动作）。 */
  yes?: boolean;
  /** K7 预留（compose 批消费）：代码隔离 → entryPath/execPath 加法透传。 */
  codeDir?: string;
}

/**
 * `vessel start`：返回退出码。
 * 0 = 全部就绪 / 全部已运行跳过；1 = 任一组件失败 / 未知 name / 状态不可判拒绝。
 * 不自动回滚（已健康组件保持运行，失败如实报告，重跑收敛）。
 */
export async function startFleetCommand(options: StartFleetOptions = {}): Promise<number> {
  const { targets, selector, name, timeoutMs, codeDir, ...deps } = options;
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
  // 舰队边界抬头（topology §3）：解析 dataDir + 来源；env 兜底来源加 warning。
  const source =
    deps.dataDir !== undefined
      ? 'flag'
      : (env.VESSEL_DATA_DIR ?? '').trim() !== ''
        ? 'env'
        : 'config';
  print(ui.info(t('start.inventory.title', { dataDir })));
  if (source === 'env') print(ui.warn(t('start.envWarning')));

  // K7 加法透传（本批无 CLI 消费方；compose 批经 codeDir 注入）。
  const entryPath = codeDir !== undefined ? path.join(codeDir, 'src', 'cli.ts') : undefined;
  const execPath = codeDir !== undefined ? process.execPath : undefined;

  const token = resolveGatewayToken(config, env);
  const hubDataDir = configuredHubDataDir(config);
  const collect = deps.collectState ?? collectGatewayState;
  const kind = deps.stateKind ?? (env.VESSEL_LEGACY_SERVE === '1' ? 'node' : 'platform');
  const collectOptions = {
    ...(token !== undefined ? { token } : {}),
    ...(hubDataDir !== undefined ? { hubDataDir } : {}),
    kind,
  };
  const snapshot = await collect(dataDir, collectOptions);

  // 目标解析：name 定向 / targets 快照 / selector（缺省本 dataDir 舰队）。
  let startTargets: Array<{ instance: string; port?: number; host?: string }>;
  if (name !== undefined) {
    const instanceMatch = snapshot.entries.find((entry) => entry.instance === name);
    if (instanceMatch !== undefined) {
      startTargets = [{ instance: name }];
    } else {
      const registry = await loadNodeRegistry(dataDir).catch(() => undefined);
      const node =
        registry?.kind === 'ready'
          ? registry.registry.nodes.find((candidate) => candidate.name === name)
          : undefined;
      if (node !== undefined) {
        // registry node 名命中 → 委托 node start 接缝（镜像 restart 委托 nodeRestartCommand 先例）。
        return runNodeCommand({ kind: 'start', daemon: true }, { ...deps, dataDir: node.data_dir });
      }
      printErr(ui.err(t('start.unknownName', { name })));
      return 1;
    }
  } else if (targets !== undefined) {
    startTargets = [...targets];
  } else {
    const raw = selector ?? {};
    const instance = deriveGatewayInstance(raw.instance, raw.port);
    startTargets = [{ instance, ...(raw.port !== undefined ? { port: raw.port } : {}) }];
    // --all：单 dataDir 舰队（平台管线承载 node/hub）；不跨 dataDir（topology §3）。
  }
  if (startTargets.length === 0) {
    print(ui.info(t('start.nothing')));
    return 0;
  }

  let started = 0;
  let skipped = 0;
  let failed = 0;
  for (const target of startTargets) {
    const entry = snapshot.entries.find((candidate) => candidate.instance === target.instance);
    const state = entry?.state ?? 'absent';
    if (state === 'running') {
      print(ui.info(t('start.skipped', { instance: target.instance })));
      skipped += 1;
      continue;
    }
    if (state === 'unknown' || state === 'foreign-host') {
      printErr(ui.err(t('start.refused', { instance: target.instance, state })));
      failed += 1;
      continue;
    }
    // stale/absent/starting/degraded → 共享接缝（内部守卫/清理/回滚保留）。
    const code = await startDaemonCommand({
      ...deps,
      config,
      dataDir,
      instance: target.instance,
      ...(target.port !== undefined ? { port: target.port } : {}),
      ...(target.host !== undefined ? { host: target.host } : {}),
      ...(entryPath !== undefined ? { entryPath } : {}),
      ...(execPath !== undefined ? { execPath } : {}),
      ...(timeoutMs !== undefined ? { waitMs: timeoutMs } : {}),
    });
    // 健康确认拍：重读状态（单读入口同口径）；already_running 竞态归一 skipped。
    const after = await collect(dataDir, collectOptions);
    const afterEntry = after.entries.find((candidate) => candidate.instance === target.instance);
    if (afterEntry?.state === 'running') {
      if (code === 0) started += 1;
      else skipped += 1;
    } else {
      failed += 1;
    }
  }
  print(ui.info(t('start.done', { started, skipped, failed })));
  return failed > 0 ? 1 : 0;
}

/** hub 数据根（与 gateway-command/stop-command 同口径；只读配置）。 */
function configuredHubDataDir(config: VesselConfig): string | undefined {
  const configured = config.hub?.dataDir;
  return configured === undefined ? undefined : path.resolve(expandHome(configured));
}
