#!/usr/bin/env bun

/**
 * 「已归档 / 已停用」可见性门禁（0.51）。
 *
 * 存在的理由：本单的核心承诺是「默认隐藏，但**不是**删除也不是不可达」。这两条
 * 一旦有人重构成「过滤掉就等于删掉」，typecheck 与 biome 都不会红——只有 fixture
 * 能把语义钉死：
 *   - 开关默认 **关**（关 = 隐藏），且 camelCase / snake_case / 缺失 / 非法一律回落到关；
 *   - 三处列表（Team 列表 / Agent 列表 / 成员侧栏）的筛选函数在两种开关值下的行为；
 *   - 搜索口径：默认搜不到归档对象，打开开关后搜得到；
 *   - 直接打开归档 / 停用对象仍可达（detail 层不走筛选，且一定有「待移除」提示）；
 *   - 会话：0.51 是「永不隐藏、只补一枚待移除标记」；**0.52 用户改了口径** —— 归属到已停用
 *     agent 的会话默认不列（多数是 rotate / 注销后没 prune 的残留），打开「显示归档」原样列回、
 *     且**不**再挂任何徽标（归档态已由开关表达）。反查不到（别的节点 / 旧 gateway）一律不动。
 *
 * 用法：`bun run scripts/check-archived-visibility.ts`
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { filterAgentsByQuery } from '../apps/web/src/domains/agents/agent-search';
import { filterTeamResults } from '../apps/web/src/domains/teams/team-search';

/**
 * roster / team 的形状在这里**按结构镜像**声明，而不是 import 那些模块。
 *
 * 为什么：`gateway/NodeProvider` 与 `gateway/team-roster` 会牵出 React 与浏览器全局
 * （`window.location` / `setTimeout` 等），而门禁是在 Node 里跑、根 tsconfig 也没有 DOM
 * lib —— 一 import 就会把「apps/web 的浏览器代码」拉进根 typecheck，报一堆与改动无关的错
 * （0.51 真踩过三次）。镜像只保留判据用到的字段，与 `packages/serve` 的 plugin-host 契约
 * 镜像同一套路。
 */
const APP_ROOT = join(import.meta.dir, '..', 'apps', 'web', 'src');

/** 读 apps/web 源码做接线断言（0.52：可见性口径只有源码级能钉，列表是 React）。 */
function readAppSource(rel: string): string {
  return readFileSync(join(APP_ROOT, rel), 'utf8');
}

interface NodeViewLike {
  current: boolean;
  id?: string;
  name?: string;
}

/** Team 成员（`TeamMember` 的判据子集）。 */
interface TeamMemberLike {
  agent_id: string;
  membership?: string;
  presence?: string;
  visibility?: string;
  name?: string;
  session_id?: string;
  state?: string;
  status?: { kind?: string };
  archived_at?: string | number | null;
}

/** 一条 roster 成员行（`RosterAgent` 的判据子集）。 */
interface RosterAgentLike {
  node: NodeViewLike;
  member: TeamMemberLike;
}

interface NodeRosterLike {
  node: NodeViewLike;
  ok: boolean;
  teams?: readonly TeamSummaryLike[];
  partialErrors?: number;
  stale?: boolean;
  rosters: { team?: TeamSummaryLike; members: readonly TeamMemberLike[] }[];
}

/** Team 摘要（`TeamSummary` 的判据子集）。 */
interface TeamSummaryLike {
  team_id: string;
  name: string;
  archived_at?: number;
}

import {
  closedAgentSessionIds,
  countArchivedTeams,
  countClosedAgents,
  countClosedMembers,
  filterArchivedTeams,
  filterClosedAgents,
  filterClosedMembers,
  hiddenPendingRemovalCount,
  isArchivedTeam,
  isClosedAgent,
  pendingRemovalBadgeKey,
  pendingRemovalNoticeKey,
  resolveShowArchived,
} from '../apps/web/src/state/archive-visibility';
import {
  DISPLAY_SETTINGS,
  isDisplaySettingKey,
  toConfigValue,
} from '../apps/web/src/state/display-settings';

interface Fixture {
  name: string;
  /** 这条 fixture 守住什么（失败时打印，避免只看到一句红）。 */
  why: string;
  check: () => boolean;
}

function team(id: string, archived?: boolean): TeamSummaryLike {
  return {
    team_id: id,
    name: id,
    member_count: 1,
    ...(archived ? { archived_at: 1_700_000_000 } : {}),
  } as TeamSummaryLike;
}

function member(id: string, state: string, sessionId?: string): TeamMemberLike {
  return {
    agent_id: id,
    name: id,
    membership: 'present',
    presence: state === 'closed' ? 'gone' : 'live',
    visibility: 'private',
    state,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function rosterAgent(node: NodeViewLike, m: TeamMemberLike): RosterAgentLike {
  return { node, member: m };
}

const currentNode = { id: 'local', name: 'local', current: true } as unknown as NodeViewLike;
const otherNode = { id: 'peer', name: 'peer', current: false } as unknown as NodeViewLike;

function nodeRoster(node: NodeViewLike, members: readonly TeamMemberLike[]): NodeRosterLike {
  return {
    node,
    ok: true,
    teams: [team('t1')],
    rosters: [{ team: team('t1'), members }],
    partialErrors: 0,
    stale: false,
  };
}

const live = team('live-team');
const archived = team('archived-team', true);

const FIXTURES: readonly Fixture[] = [
  {
    name: 'F1 开关默认关（缺失 / 空对象 / 未解包 config）',
    why: '默认必须是「隐藏」：读不到配置时不能退化成「全都显示」',
    check: () =>
      resolveShowArchived(undefined) === false &&
      resolveShowArchived(null) === false &&
      resolveShowArchived({}) === false &&
      resolveShowArchived({ config: {} }) === false &&
      resolveShowArchived({ config: { ui: {} } }) === false &&
      resolveShowArchived({ ui: {} }) === false,
  },
  {
    name: 'F2 开关读到 true：camelCase 与 snake_case 两种写法',
    why: 'YAML 是 show_archived、config.get 是 showArchived，两种都必须认',
    check: () =>
      resolveShowArchived({ config: { ui: { showArchived: true } } }) === true &&
      resolveShowArchived({ config: { ui: { show_archived: true } } }) === true &&
      resolveShowArchived({ ui: { showArchived: true } }) === true,
  },
  {
    name: 'F3 非法值 / 显式关：一律当作关',
    why: '脏配置不能把待移除对象漏进默认视图',
    check: () =>
      resolveShowArchived({ config: { ui: { showArchived: 'true' } } }) === false &&
      resolveShowArchived({ config: { ui: { showArchived: 1 } } }) === false &&
      resolveShowArchived({ config: { ui: { showArchived: false } } }) === false,
  },
  {
    name: 'F4 Team 列表：默认隐藏归档，开关打开回到列表',
    why: '这是本单的主诉求；顺序与入参都不能被改动（detail 层还要用原数组）',
    check: () => {
      const input = [live, archived];
      const hidden = filterArchivedTeams(input, false);
      const shown = filterArchivedTeams(input, true);
      return (
        hidden.length === 1 &&
        hidden[0]?.team_id === 'live-team' &&
        shown.length === 2 &&
        shown[1]?.team_id === 'archived-team' &&
        input.length === 2
      );
    },
  },
  {
    name: 'F5 Team 归档判定：archived_at=0 也算归档',
    why: '用真值判断会漏掉 epoch 0 这种脏数据，隐藏就漏成「显示」',
    check: () =>
      isArchivedTeam({ archived_at: 0 }) === true &&
      isArchivedTeam({}) === false &&
      isArchivedTeam(undefined) === false,
  },
  {
    name: 'F6 Agent 列表：默认隐藏 closed，开关打开回到列表',
    why: '停用 agent 与归档 Team 同一条规则，不能只做一半',
    check: () => {
      const idle = rosterAgent(currentNode, member('a-idle', 'idle'));
      const closed = rosterAgent(currentNode, member('a-closed', 'closed'));
      const input = [idle, closed];
      const hidden = filterClosedAgents(input, false);
      const shown = filterClosedAgents(input, true);
      return (
        hidden.length === 1 &&
        hidden[0]?.member.agent_id === 'a-idle' &&
        shown.length === 2 &&
        countClosedAgents(input) === 1
      );
    },
  },
  {
    name: 'F7 成员侧栏：同一判定（trim / 大小写都算 closed）',
    why: '侧栏与列表各写一套判定就会一边隐藏一边显示；state 可能带空白/大写',
    check: () => {
      const members = [
        member('m1', 'running'),
        member('m2', 'CLOSED '),
        member('m3', 'closed'),
        member('m4', 'completed'),
      ];
      const hidden = filterClosedMembers(members, false);
      return (
        hidden.length === 2 &&
        countClosedMembers(members) === 2 &&
        isClosedAgent({ state: ' closed ' }) === true &&
        isClosedAgent({ state: 'idle' }) === false &&
        isClosedAgent(undefined) === false
      );
    },
  },
  {
    name: 'F8 搜索：默认搜不到归档 Team，开关打开后搜得到',
    why: '「隐藏的对象不该出现在默认搜索里，但开启后应该能搜到」是验收原话',
    check: () => {
      const results = [{ node: currentNode, ok: true, teams: [live, archived] }];
      const hiddenHit = filterTeamResults(
        results.map((item) => ({ ...item, teams: filterArchivedTeams(item.teams, false) })),
        'archived',
      );
      const shownHit = filterTeamResults(
        results.map((item) => ({ ...item, teams: filterArchivedTeams(item.teams, true) })),
        'archived',
      );
      return hiddenHit.length === 0 && shownHit[0]?.teams.length === 1;
    },
  },
  {
    name: 'F9 搜索：默认搜不到停用 agent，开关打开后搜得到',
    why: '与 Team 列表同口径，避免「开关键只管了一个列表」',
    check: () => {
      const agents = [
        rosterAgent(currentNode, member('a-idle', 'idle')),
        rosterAgent(currentNode, member('a-closed', 'closed')),
      ];
      return (
        filterAgentsByQuery(filterClosedAgents(agents, false), 'a-closed').length === 0 &&
        filterAgentsByQuery(filterClosedAgents(agents, true), 'a-closed').length === 1
      );
    },
  },
  {
    name: 'F10 直接打开归档 Team / 停用 agent：仍可达且一定有提示',
    why: '隐藏不等于不可达：detail 层不经过筛选函数，打开时必须说清「待移除」',
    check: () => {
      const raw = [live, archived];
      // detail 层从原始数组按 id 找对象（不过滤），所以直接 URL 永远找得到。
      const opened = raw.find((item) => item.team_id === 'archived-team');
      return (
        opened !== undefined &&
        pendingRemovalNoticeKey('team', isArchivedTeam(opened)) === 'archive.notice.team' &&
        pendingRemovalNoticeKey('agent', isClosedAgent({ state: 'closed' })) ===
          'archive.notice.agent' &&
        pendingRemovalNoticeKey('team', isArchivedTeam(live)) === undefined &&
        pendingRemovalNoticeKey('agent', isClosedAgent({ state: 'idle' })) === undefined
      );
    },
  },
  {
    name: 'F11 待移除标记：归档 / 停用各有自己的文案 key',
    why: '标记不能与正常对象长一样，否则「一眼看出待移除」这条验收没落地',
    check: () =>
      pendingRemovalBadgeKey('team') === 'teams.card.archived' &&
      pendingRemovalBadgeKey('agent') === 'agents.card.closed',
  },
  {
    name: 'F12 会话永不隐藏；只有归属到停用 agent 的会话被标记',
    why: '用户自己的历史不能被隐藏；反查得到才标，标的是「待移除」而不是「已删除」',
    check: () => {
      const ids = closedAgentSessionIds([
        nodeRoster(currentNode, [
          member('a-live', 'idle', 's-live'),
          member('a-closed', 'closed', 's-closed'),
          member('a-no-session', 'closed'),
        ]),
      ]);
      return ids.size === 1 && ids.has('s-closed') && !ids.has('s-live');
    },
  },
  {
    name: 'F13 会话反查不到就不标（别的节点 / 非当前节点）',
    why: '宁可漏标也不误标：roster 没覆盖到这条会话时，界面保持沉默而不是谎报待移除',
    check: () => {
      const ids = closedAgentSessionIds([
        nodeRoster(otherNode, [member('a-closed', 'closed', 's-closed')]),
      ]);
      return ids.size === 0;
    },
  },
  {
    name: 'F15 归属到停用 agent 的会话默认不列，开「显示归档」才列（而且要原样、无徽标）',
    why: '0.52 改口径：残留会话混在正常列表里会让人以为 agent 还活着；但一旦开关打开就必须看得见，不能变成「删掉」',
    check: () => {
      const chat = readAppSource('domains/chat/useChatSessions.ts');
      const list = readAppSource('domains/chat/SessionList.tsx');
      return (
        chat.includes('useShowArchived()') &&
        chat.includes('if (showArchived) return matched;') &&
        chat.includes('!closedAgentSessions.has(session.session_id)') &&
        // 徽标必须消失：归档态只由开关表达，再挂「待移除」属于重复表达
        !list.includes('archive.session.agentClosedHint') &&
        !list.includes('pendingRemovalBadgeKey')
      );
    },
  },
  {
    name: 'F14 设置面板：ui.showArchived 是布尔键，写回真布尔值',
    why: '开关必须落在与 ui.showInternalEvents 同一层的可写白名单里，否则保存会 invalid_params',
    check: () => {
      const setting = DISPLAY_SETTINGS.find((item) => item.key === 'ui.showArchived');
      return (
        setting !== undefined &&
        setting.type === 'boolean' &&
        setting.id === 'showArchived' &&
        isDisplaySettingKey('ui.showArchived') &&
        setting !== undefined &&
        toConfigValue(setting, 'true') === true &&
        toConfigValue(setting, 'false') === false &&
        toConfigValue(setting, '1') === undefined
      );
    },
  },
  {
    name: 'F15 归档数量口径：只在提示里说「隐藏了几个」',
    why: '计数必须来自未过滤的原始数据，否则提示永远显示 0',
    check: () => countArchivedTeams([live, archived]) === 1 && countArchivedTeams([live]) === 0,
  },
  {
    name: 'F16 开关打开时「已隐藏 N 个」归零',
    why: '打开开关后它们就在列表里；此时还报隐藏数就是谎报，而且「全都归档了」的空态会永远盖住列表',
    check: () =>
      hiddenPendingRemovalCount([live, archived], false, isArchivedTeam) === 1 &&
      hiddenPendingRemovalCount([live, archived], true, isArchivedTeam) === 0 &&
      hiddenPendingRemovalCount([member('m1', 'closed')], true, isClosedAgent) === 0 &&
      hiddenPendingRemovalCount([member('m1', 'closed')], false, isClosedAgent) === 1,
  },
];

const failures: { name: string; why: string }[] = [];
for (const fixture of FIXTURES) {
  let ok = false;
  try {
    ok = fixture.check();
  } catch {
    ok = false;
  }
  if (!ok) failures.push({ name: fixture.name, why: fixture.why });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`);
    console.log(`     why: ${failure.why}`);
  }
  console.error(`archived visibility: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`archived visibility: ${FIXTURES.length} fixtures passed`);
