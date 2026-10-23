/**
 * 节点侧 hub 控制面装配（S5）。
 *
 * 把 `AgentService` 投影成 `HubControlLike` / `HubTeamScopeLike`：
 * - snapshot 只白名单投影（agent / team 元数据），不透传 session / model / prompt / usage；
 * - subscribe 把成员生命周期事件映射成 `agent.state` 指针；
 * - team 归属经结构化可选读取（S3 未合入时 `team_id` 不存在，unbound 成员不进目录）；
 * - node token 控制面由 `createNodeTokenControl` 持有。
 *
 * @module vessel/hub-wiring
 */

import {
  type AgentEvent,
  type AgentService,
  DEFAULT_OWNER,
  type MemberStatus,
} from '@vessel-agent/agent';
import type { Logger } from '@vessel-agent/core';
import {
  HUB_MAX_AGENTS,
  HUB_MAX_TEAMS,
  type HubAgentMeta,
  type HubControlChange,
  type HubControlLike,
  type HubNodeSnapshotInput,
  type HubPointerInput,
  type HubTeamMeta,
  type HubTeamScopeLike,
  type NodeTokenControlLike,
} from '../packages/serve/src/index';
import { createNodeTokenControl } from './node-token-control';

/** 成员生命周期事件 → 目录变化（开放字符串，不新增常量导出）。 */
const AGENT_STATE_EVENTS = new Set([
  'agent.spawned',
  'agent.resumed',
  'agent.closed',
  'agent.rotated',
  'agent.rejoined',
  'agent.retired',
]);

/** teamSource 里表示“日志已写入”的 kind；roster 单独处理。 */
const TEAM_MESSAGE_KINDS = new Set(['post', 'mention', 'reply', 'system']);

/** TeamService 事件的最小形状（只读指针字段，绝不读正文）。 */
export interface HubTeamEventLike {
  team_id?: string;
  kind?: string;
  message_id?: string;
}

/**
 * S3 Team 服务的结构化端口。S3 未合入时不注入；这里不 import S3 类型。
 * `list()` 条目只读 `team_id / name / member_count / agent_count`。
 */
export interface HubTeamSourceLike {
  list(): Promise<readonly unknown[]>;
  subscribe?(listener: (event: HubTeamEventLike) => void): () => void;
}

export interface CreateHubControlOptions {
  service: AgentService;
  teamSource?: HubTeamSourceLike;
  logger?: Logger;
  /** 可注入时钟（测试用）；缺省 `Date.now`。 */
  now?: () => number;
  /**
   * private 成员的 view owner；缺省 `DEFAULT_OWNER`。
   * 目录只投影元数据，不因 private 而隐藏自己 tenant 的成员。
   */
  ownerId?: string;
}

export interface CreateTeamScopeOptions {
  service: AgentService;
  logger?: Logger;
  /** 与 `createHubControl` 一致：private 可见性判定使用的 viewer。 */
  ownerId?: string;
}

export interface CreateHubRuntimeOptions extends CreateHubControlOptions {
  dataDir: string;
  tenantId: string;
  nodeId: string;
}

/** hub 控制面 + team 归属 + 节点 token 控制面的装配结果。 */
export interface HubRuntime {
  hubControl: HubControlLike;
  teamScope: HubTeamScopeLike;
  nodeTokens: NodeTokenControlLike;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 结构化读取成员 team 归属；S3 未合入时为 undefined。 */
function readTeamId(member: MemberStatus): string | undefined {
  const value = (member as { team_id?: unknown }).team_id;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** 白名单构造单条 agent 投影。 */
function projectAgent(member: MemberStatus, teamId: string): HubAgentMeta {
  const agent: HubAgentMeta = {
    agent_id: member.id,
    team_id: teamId,
    membership: member.membership === 'left' ? 'left' : 'present',
    presence: member.presence === 'live' ? 'live' : 'gone',
  };
  if (typeof member.name === 'string' && member.name !== '') agent.name = member.name;
  if (typeof member.epoch === 'number' && Number.isFinite(member.epoch)) {
    agent.epoch = Math.floor(member.epoch);
  }
  return agent;
}

/** 从 teamSource.list() 的条目白名单构造 team 投影。 */
function projectTeam(entry: unknown, lastActive: number | undefined): HubTeamMeta | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as {
    team_id?: unknown;
    name?: unknown;
    member_count?: unknown;
    agent_count?: unknown;
    online_count?: unknown;
  };
  const teamId = readString(record.team_id);
  if (teamId === undefined) return undefined;
  const team: HubTeamMeta = {
    team_id: teamId,
    name: readString(record.name) ?? teamId,
    member_count: readCount(record.member_count),
    agent_count: readCount(record.agent_count),
  };
  const online = readCount(record.online_count);
  if (typeof record.online_count === 'number' && Number.isFinite(record.online_count)) {
    team.online_count = online;
  }
  if (lastActive !== undefined) team.last_active = lastActive;
  return team;
}

function memberSessionIds(member: MemberStatus): string[] {
  const sessions: string[] = [];
  const record = member as {
    session_id?: unknown;
    current_body?: { session_id?: unknown };
    body_history?: unknown;
  };
  const base = readString(record.session_id);
  if (base !== undefined) sessions.push(base);
  const current = readString(record.current_body?.session_id);
  if (current !== undefined) sessions.push(current);
  if (Array.isArray(record.body_history)) {
    for (const entry of record.body_history) {
      const session = readString((entry as { session_id?: unknown } | null)?.session_id);
      if (session !== undefined) sessions.push(session);
    }
  }
  return sessions;
}

/**
 * 创建 hub 目录投影。
 *
 * `snapshot` 每次重新 list；`subscribe` 维护 `agent_id -> team_id` 缓存，
 * 找不到 team 时只发 `directoryChanged`（不伪造归属）。`last_active` 只由
 * 本模块内存的 pointer ts 维护，不读日志。
 */
export function createHubControl(options: CreateHubControlOptions): HubControlLike {
  const { service, teamSource, logger } = options;
  const clock = options.now ?? Date.now;
  const viewer = options.ownerId ?? DEFAULT_OWNER;
  /** team_id -> 最近一次指针 ts（只本进程内）。 */
  const lastActive = new Map<string, number>();

  async function listTeams(): Promise<HubTeamMeta[]> {
    if (teamSource === undefined) return [];
    const entries = await teamSource.list();
    const teams: HubTeamMeta[] = [];
    for (const entry of entries) {
      const baseline = projectTeam(entry, undefined);
      if (baseline === undefined) continue;
      const ts = lastActive.get(baseline.team_id);
      teams.push(ts !== undefined ? (projectTeam(entry, ts) ?? baseline) : baseline);
    }
    return teams;
  }

  async function snapshot(_tenantId: string): Promise<HubNodeSnapshotInput> {
    const members = await service.list({ viewer });
    const agents: HubAgentMeta[] = [];
    for (const member of members) {
      const teamId = readTeamId(member);
      // unbound 成员（S3 未合入 / 尚未分 team）不进目录。
      if (teamId === undefined) continue;
      agents.push(projectAgent(member, teamId));
    }
    const teams = await listTeams();
    const onlineByTeam = new Map<string, number>();
    let liveAgents = 0;
    for (const agent of agents) {
      if (agent.presence !== 'live') continue;
      liveAgents += 1;
      if (agent.membership !== 'present') continue;
      onlineByTeam.set(agent.team_id, (onlineByTeam.get(agent.team_id) ?? 0) + 1);
    }
    const teamsWithOnline = teams.map((team) => {
      const online = onlineByTeam.get(team.team_id);
      return online === undefined ? team : { ...team, online_count: online };
    });
    return {
      counts: { teams: teams.length, agents: agents.length, live_agents: liveAgents },
      teams: teamsWithOnline.slice(0, HUB_MAX_TEAMS),
      agents: agents.slice(0, HUB_MAX_AGENTS),
      truncated: teams.length > HUB_MAX_TEAMS || agents.length > HUB_MAX_AGENTS,
    };
  }

  function emit(listener: (change: HubControlChange) => void, change: HubControlChange): void {
    try {
      listener(change);
    } catch (error) {
      // 监听方异常不得影响 AgentService 的事件分发。
      logger?.warn('hub.control.listener_failed', { error: errorMessage(error) });
    }
  }

  function subscribe(_tenantId: string, listener: (change: HubControlChange) => void): () => void {
    let disposed = false;
    let refreshing: Promise<void> | undefined;
    const teamByAgent = new Map<string, string>();

    const refreshTeamCache = (): Promise<void> => {
      if (refreshing !== undefined) return refreshing;
      refreshing = (async () => {
        try {
          const members = await service.list({ viewer });
          if (disposed) return;
          teamByAgent.clear();
          for (const member of members) {
            const teamId = readTeamId(member);
            if (teamId !== undefined) teamByAgent.set(member.id, teamId);
          }
        } catch (error) {
          logger?.warn('hub.control.team_cache_failed', { error: errorMessage(error) });
        } finally {
          refreshing = undefined;
        }
      })();
      return refreshing;
    };

    void refreshTeamCache();

    const unsubscribeService = service.subscribe((event: AgentEvent) => {
      if (disposed) return;
      const type = readString((event as { type?: unknown }).type);
      if (type === undefined || !AGENT_STATE_EVENTS.has(type)) return;
      const agentId = readString((event as { agent_id?: unknown }).agent_id);
      const teamId = agentId !== undefined ? teamByAgent.get(agentId) : undefined;
      const ts = clock();
      const change: HubControlChange = { directoryChanged: true };
      if (teamId !== undefined) {
        lastActive.set(teamId, ts);
        const pointer: HubPointerInput = { team_id: teamId, reason: 'agent.state', ts };
        change.pointers = [pointer];
      }
      // 事件后刷新缓存：后续事件使用新的归属 / 新增成员。
      void refreshTeamCache();
      emit(listener, change);
    });

    let unsubscribeTeams: (() => void) | undefined;
    if (teamSource?.subscribe !== undefined) {
      try {
        unsubscribeTeams = teamSource.subscribe((event) => {
          if (disposed) return;
          const kind = readString(event.kind);
          if (kind === undefined) return;
          const teamId = readString(event.team_id);
          const change: HubControlChange = {};
          if (kind === 'roster') {
            // roster 改变成员 / 计数，目录需要重新 snapshot。
            change.directoryChanged = true;
            if (teamId !== undefined) {
              const ts = clock();
              lastActive.set(teamId, ts);
              change.pointers = [{ team_id: teamId, reason: 'team.roster', ts }];
            }
          } else if (TEAM_MESSAGE_KINDS.has(kind)) {
            // message 只发指针；request_id 来自 message_id，绝不带正文。
            if (teamId === undefined) return;
            const ts = clock();
            const requestId = readString(event.message_id);
            lastActive.set(teamId, ts);
            const pointer: HubPointerInput = {
              team_id: teamId,
              reason: 'team.message',
              ts,
              ...(requestId !== undefined ? { request_id: requestId } : {}),
            };
            change.pointers = [pointer];
          } else {
            // 未知 / 缺失 kind：忽略。
            return;
          }
          emit(listener, change);
        });
      } catch (error) {
        logger?.warn('hub.control.team_subscribe_failed', { error: errorMessage(error) });
      }
    }

    return () => {
      if (disposed) return;
      disposed = true;
      unsubscribeService();
      unsubscribeTeams?.();
    };
  }

  return { snapshot, subscribe };
}

/**
 * team-scoped token 的 session → team 归属缓存。
 *
 * `teamForSession` 是同步接口：缓存由 `service.list()` 在后台填充；
 * 未命中时再触发一次刷新（不阻塞调用方，未知 session 返回 undefined）。
 */
export function createTeamScope(options: CreateTeamScopeOptions): HubTeamScopeLike {
  const viewer = options.ownerId ?? DEFAULT_OWNER;
  const bySession = new Map<string, string>();
  let refreshing: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (refreshing !== undefined) return refreshing;
    refreshing = (async () => {
      try {
        const members = await options.service.list({ viewer });
        bySession.clear();
        for (const member of members) {
          const teamId = readTeamId(member);
          if (teamId === undefined) continue;
          for (const sessionId of memberSessionIds(member)) bySession.set(sessionId, teamId);
        }
      } catch (error) {
        options.logger?.warn('hub.team_scope.refresh_failed', { error: errorMessage(error) });
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  void refresh();

  return {
    teamForSession(sessionId: string): string | undefined {
      const teamId = bySession.get(sessionId);
      if (teamId === undefined) void refresh();
      return teamId;
    },
  };
}

/** 装配 hub 控制面、team 归属与节点 token 控制面。 */
export async function createHubRuntime(options: CreateHubRuntimeOptions): Promise<HubRuntime> {
  const hubControl = createHubControl(options);
  const teamScope = createTeamScope({
    service: options.service,
    ...(options.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  const nodeTokens = await createNodeTokenControl({
    dataDir: options.dataDir,
    tenantId: options.tenantId,
    nodeId: options.nodeId,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { hubControl, teamScope, nodeTokens };
}
