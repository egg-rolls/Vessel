/**
 * agent 活动订阅 watcher（q-sub-unify-p1 M4a：doc-subscription agent 源的宿主侧）。
 *
 * 照抄 node-health-watch 范式，但传输是**双流事件驱动**（lead 裁定 R1，设计稿 §6.3 errata）：
 * - ① `AgentService.subscribe`：agent.* 生命周期白名单事件（自带 visibility/team_id/name）；
 * - ② `parentEvents`（EventStream）：run.* 终态（run_id = 成员 id；与 agent.* 同一条父流，
 *   TeamService / peer-notices 双订阅先例）。run.* 不带 visibility ⇒ 经 service 成员记录
 *   解析；private / 未知 **fail-closed 跳过**（§9：private 永不落盘）。
 *
 * 需求驱动：tick 扫订阅状态文件 source==='agent' 目标（scanAgentTargets）；无目标零写盘。
 * tick 同时从 service.list() 取权威基线（state/presence/role），事件空窗也有快照。
 * 事件到达即折叠事实并按签名变化写盘（订阅目标才写）。
 *
 * 活动签名 rev = `state:presence:last_run_ts:role`（'-' 占位，health 先例）；
 * checked_at / last_event_ts **不进签名**（每事件都刷新，进签名会每 run 误报）。
 * 快照落 `<stateDir>/agents/<encodeURIComponent(target)>.json`（插件 agent.ts 读端同口径）。
 *
 * 联邦地址目标：P1 本地分支不探测（无快照 ⇒ 插件 rev='' 首观语义）；P3 接远端。
 *
 * @module vessel/agent-activity-watch
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentEvent, AgentService, MemberStatus } from '../../packages/agent/src/index';
import type { VesselConfig } from '../../packages/config/src/index';
import { atomicWrite, type EventStream, type Logger } from '../../packages/core/src/index';
import { parseDocSubscriptionConfig } from '../../plugins/context/doc-subscription/src/index';
import { declarativePluginEntries, pluginConfigFor } from '../plugin/plugin-config';

/** 缺省基线节拍（与 health 同节拍；事件驱动即时写，tick 只补权威基线）。 */
export const DEFAULT_AGENT_WATCH_INTERVAL_MS = 20_000;
/** 单 tick 最多处理的目标数（防异常状态文件刷爆）。 */
const MAX_TARGETS_PER_TICK = 64;

/**
 * 事件白名单（lead 裁定 R1 最终 13 词；emit 点钉死）：
 * agent.* 在 AgentService.subscribe 流；run.* 在 parentEvents 父流。
 * 排除：agent.message.queued / inbox.changed / team.budget.* / agent.create.failed / permission.*。
 */
const AGENT_EVENT_WHITELIST: ReadonlySet<string> = new Set([
  'agent.spawned',
  'agent.closed',
  'agent.retired',
  'agent.rejoined',
  'agent.restarting',
  'agent.restarted',
  'agent.stale',
  'agent.updated',
  'agent.role.changed',
  'agent.session.activated',
]);
const RUN_EVENT_WHITELIST: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/** visibility 闸（照抄 team-service.ts:1527 口径）：只有 team/tenant 落盘。 */
function isPublicVisibility(visibility: unknown): boolean {
  return visibility === 'team' || visibility === 'tenant';
}

/** 折叠中的单目标活动事实。 */
interface AgentActivityFacts {
  state?: string;
  presence?: string;
  role?: string;
  last_run_ts?: number;
  name?: string;
  team_id?: string;
  visibility?: string;
  last_event_type?: string;
  last_event_ts?: number;
}

/** 活动签名（与插件 agent.ts agentSignature 逐字同口径）。 */
export function agentActivitySignature(facts: AgentActivityFacts): string {
  return [
    facts.state ?? '-',
    facts.presence ?? '-',
    facts.last_run_ts ?? '-',
    facts.role ?? '-',
  ].join(':');
}

export interface AgentActivityWatchOptions {
  /** live 配置（stateDir 热应用后下一 tick 生效）。 */
  getConfig: () => VesselConfig;
  /** 成员服务（wiring 之后创建，直引；list() 取权威基线 + visibility 解析）。 */
  service: AgentService;
  /** run.* 终态父流（与 TeamService options.events 同源）；缺省 ⇒ 只订 agent.* 流。 */
  parentEvents?: EventStream;
  logger?: Logger;
  intervalMs?: number;
  /** 验证注入：节拍器。 */
  timers?: {
    set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (handle: ReturnType<typeof setTimeout>) => void;
  };
}

export interface AgentActivityWatch {
  start(): void;
  stop(): void;
  /** 立即跑一轮基线（验证 / 诊断用；与节拍 tick 共用防重入闸）。 */
  tick(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** doc-subscription 的 stateDir（与插件 install / node-health-watch 同一份解析）。 */
function resolveStateDir(config: VesselConfig): string {
  const pluginConfig = pluginConfigFor(
    'doc-subscription',
    config.plugins,
    declarativePluginEntries(config),
  );
  return parseDocSubscriptionConfig(pluginConfig).stateDir;
}

/** 扫订阅状态文件，收集 agent 目标（只读；损坏文件跳过）。 */
async function scanAgentTargets(stateDir: string): Promise<string[]> {
  const sessionsDir = path.join(stateDir, 'sessions');
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const targets = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(sessionsDir, name), 'utf-8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.subscriptions)) continue;
    for (const value of Object.values(parsed.subscriptions)) {
      if (!isRecord(value) || value.source !== 'agent') continue;
      const target = optionalString(value, 'path');
      // 联邦地址（含 '@'）P1 本地分支不探测。
      if (target !== undefined && !target.includes('@')) targets.add(target);
      if (targets.size >= MAX_TARGETS_PER_TICK) return [...targets];
    }
  }
  return [...targets];
}

/** 快照文件路径（与插件 agent.ts agentSnapshotPath 逐字同口径）。 */
function snapshotPath(stateDir: string, target: string): string {
  return path.join(stateDir, 'agents', `${encodeURIComponent(target)}.json`);
}

/**
 * 创建 watcher。start 订双流 + 按节拍 tick；stop 断双流 unsubscribe + 取消定时器。
 * 所有失败 best-effort：单目标写失败只记日志，不打断其它目标。
 */
export function createAgentActivityWatch(options: AgentActivityWatchOptions): AgentActivityWatch {
  const logger = options.logger;
  const intervalMs = options.intervalMs ?? DEFAULT_AGENT_WATCH_INTERVAL_MS;
  const setTimer =
    options.timers?.set ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer =
    options.timers?.clear ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;
  let stopped = false;
  let unsubscribeAgent: (() => void) | undefined;
  let unsubscribeRun: (() => void) | undefined;

  /** 折叠事实（agent_id → facts）；tick 用权威基线覆写 state/presence/role。 */
  const folded = new Map<string, AgentActivityFacts>();
  /** 订阅目标集（tick 刷新；事件写盘的需求驱动闸）。 */
  let subscribed = new Set<string>();
  /** 成员状态缓存（run.* visibility 解析；tick 刷新）。 */
  let memberCache = new Map<string, MemberStatus>();
  /** 最近一次写盘签名（签名不变不重写）。 */
  const writtenSignature = new Map<string, string>();

  const writeSnapshot = async (target: string, facts: AgentActivityFacts): Promise<void> => {
    const signature = agentActivitySignature(facts);
    if (writtenSignature.get(target) === signature) return;
    const stateDir = resolveStateDir(options.getConfig());
    const snapshot = {
      v: 1,
      target,
      agent_id: target,
      ...(facts.name !== undefined ? { name: facts.name } : {}),
      ...(facts.team_id !== undefined ? { team_id: facts.team_id } : {}),
      ...(facts.visibility !== undefined ? { visibility: facts.visibility } : {}),
      ...(facts.state !== undefined ? { state: facts.state } : {}),
      ...(facts.presence !== undefined ? { presence: facts.presence } : {}),
      ...(facts.role !== undefined ? { role: facts.role } : {}),
      ...(facts.last_run_ts !== undefined ? { last_run_ts: facts.last_run_ts } : {}),
      ...(facts.last_event_type !== undefined ? { last_event_type: facts.last_event_type } : {}),
      ...(facts.last_event_ts !== undefined ? { last_event_ts: facts.last_event_ts } : {}),
      checked_at: Date.now(),
      via: 'local',
    };
    try {
      await atomicWrite(snapshotPath(stateDir, target), `${JSON.stringify(snapshot)}\n`, {
        mode: 0o600,
        ensureDir: true,
      });
      writtenSignature.set(target, signature);
    } catch (error) {
      logger?.warn('agent_activity_watch.snapshot_write_failed', {
        target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** agent.* 流：白名单 × visibility 闸 → 折叠 → 订阅目标即时写。 */
  const onAgentEvent = (event: AgentEvent): void => {
    if (stopped || !AGENT_EVENT_WHITELIST.has(event.type)) return;
    if (!isPublicVisibility(event.visibility)) return; // private / 未知 fail-closed
    const record = event as unknown as Record<string, unknown>;
    const agentId = optionalString(record, 'agent_id');
    if (agentId === undefined) return;
    const facts = folded.get(agentId) ?? {};
    const state = optionalString(record, 'state');
    if (state !== undefined) facts.state = state;
    const presence = optionalString(record, 'presence');
    if (presence !== undefined) facts.presence = presence;
    const name = optionalString(record, 'name');
    if (name !== undefined) facts.name = name;
    const teamId = optionalString(record, 'team_id');
    if (teamId !== undefined) facts.team_id = teamId;
    facts.visibility = event.visibility as string;
    facts.last_event_type = event.type;
    facts.last_event_ts = typeof record.ts === 'number' ? record.ts : Date.now();
    folded.set(agentId, facts);
    if (subscribed.has(agentId)) void writeSnapshot(agentId, facts);
  };

  /** run.* 父流：终态白名单；visibility 经成员记录解析（fail-closed）。 */
  const onRunEvent = (event: { type: string; run_id?: string; ts?: number }): void => {
    if (stopped || !RUN_EVENT_WHITELIST.has(event.type)) return;
    const agentId = event.run_id; // run.* 的 run_id 始终是成员 id（service.ts 注释）
    if (agentId === undefined) return;
    const member = memberCache.get(agentId);
    if (member === undefined || !isPublicVisibility(member.visibility)) return;
    const facts = folded.get(agentId) ?? {};
    facts.last_run_ts = typeof event.ts === 'number' ? event.ts : Date.now();
    facts.last_event_type = event.type;
    facts.last_event_ts = facts.last_run_ts;
    facts.visibility = member.visibility;
    folded.set(agentId, facts);
    if (subscribed.has(agentId)) void writeSnapshot(agentId, facts);
  };

  const tick = async (): Promise<void> => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const stateDir = resolveStateDir(options.getConfig());
      const targets = await scanAgentTargets(stateDir);
      subscribed = new Set(targets);
      if (targets.length === 0) return;
      // 权威基线：service.list() 一次取全量（visibility 闸同口径）。
      const members = await options.service.list();
      memberCache = new Map(members.map((m) => [m.id, m]));
      for (const target of targets) {
        if (stopped) return;
        const member = memberCache.get(target);
        if (member === undefined || !isPublicVisibility(member.visibility)) continue;
        const facts = folded.get(target) ?? {};
        facts.state = member.state;
        facts.presence = member.presence ?? facts.presence;
        facts.role = member.role;
        facts.name = member.name ?? facts.name;
        facts.team_id = member.team_id ?? facts.team_id;
        facts.visibility = member.visibility;
        folded.set(target, facts);
        await writeSnapshot(target, facts);
      }
    } catch (error) {
      logger?.warn('agent_activity_watch.tick_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      ticking = false;
    }
  };

  // 链式 re-arm（node-health-watch 同不变式）：tick 完成后再排下一拍；stop 断链。
  const schedule = (): void => {
    timer = setTimer(() => {
      void tick().finally(() => {
        if (!stopped) schedule();
      });
    }, intervalMs);
  };

  return {
    start() {
      if (timer !== undefined || stopped) return;
      unsubscribeAgent = options.service.subscribe(onAgentEvent);
      if (options.parentEvents !== undefined) {
        unsubscribeRun = options.parentEvents.subscribe(onRunEvent);
      }
      schedule();
      void tick();
    },
    stop() {
      stopped = true;
      unsubscribeAgent?.();
      unsubscribeAgent = undefined;
      unsubscribeRun?.();
      unsubscribeRun = undefined;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    tick,
  };
}
