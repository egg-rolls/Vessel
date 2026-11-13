#!/usr/bin/env bun

/**
 * 会话卡片第二行 agent 标签的门禁（0.52）。
 *
 * 存在的理由：非 team 成员的 primary body 会话原本第二行只有一个裸 primary 徽标，看不出
 * 是哪个 agent。sessionAgentLabels 给它补成 name@primary —— 但这个函数一旦多标/错标，
 * 就会盖掉 team 成员的节点地址（第二行信息量更高），或者出现半个 @primary。这里用
 * roster 字面量把语义钉死：只标非 team 成员的 primary body，且名字缺失宁可不标。
 *
 * 最后三条是「接线反向断言」：函数算得再对，只要没从 useChatSessions 一路透传到
 * SessionList，用户看到的还是裸 primary。改接线的名字就同步改这里（判据只认特征串）。
 *
 * 用法：bun run scripts/check-session-agent-label.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LabelRoster,
  type LabelSession,
  sessionAgentLabels,
  sessionAgentRetiredLabels,
} from '../apps/web/src/domains/chat/session-agent-labels';

const CHAT_DIR = join(import.meta.dir, '..', 'apps', 'web', 'src', 'domains', 'chat');

/** 读 chat 域的一个源文件（接线断言用；只看文本，不 import React 侧模块）。 */
function readChatSource(file: string): string {
  return readFileSync(join(CHAT_DIR, file), 'utf8');
}

/** 会话列表：每条会话都是真的被渲染的那种（列表是过滤依据）。 */
const SESSIONS: readonly LabelSession[] = [
  { session_id: 'sess-temp' },
  { session_id: 'sess-member' },
  { session_id: 'sess-ghost' },
  { session_id: 'sess-noname' },
  { session_id: 'sess-multi-primary' },
  { session_id: 'sess-multi-secondary' },
  { session_id: 'sess-unbound' },
  // 0.52：rotate 之前的旧身体会话，也在列表里（只是此前第二行是空的）。
  { session_id: 'sess-temp-old' },
  { session_id: 'sess-closed-old' },
];

/**
 * 一个节点：一个 team（reviewer 是成员）、一个临时成员（builder，owner = main）、
 * 一个没名字的临时成员、一个 rotate 过的 agent（两具 body）、一个未加入 Team 的 agent。
 */
const ROSTER: LabelRoster = {
  node: { current: true, name: 'node-a' },
  agents: [
    { name: 'builder', role: 'temporary', owner: 'main', session_id: 'sess-temp' },
    { name: 'reviewer', role: 'member', team_id: 'team-1', session_id: 'sess-member' },
    { name: '   ', role: 'temporary', owner: 'main', session_id: 'sess-noname' },
    {
      name: 'rotator',
      role: 'temporary',
      owner: 'main',
      session_id: 'sess-multi-primary',
      bodies: [
        { body_id: 'sess-multi-secondary', session_id: 'sess-multi-secondary', primary: false },
        { body_id: 'sess-multi-primary', session_id: 'sess-multi-primary', primary: true },
      ],
    },
    { name: 'lonely', session_id: 'sess-unbound' },
  ],
  rosters: [
    {
      team: { team_id: 'team-1' },
      members: [{ name: 'reviewer', role: 'member', session_id: 'sess-member' }],
    },
  ],
};

/** 同一份 roster，但 node 不是当前节点、名字也缺（地址算不出来）。 */
const ROSTER_NO_ADDRESS: LabelRoster = { ...ROSTER, node: { current: false } };

const LABELS = sessionAgentLabels([ROSTER], SESSIONS, 'primary');

/** 旧身体标签的后缀（这里直接写死，避免探针依赖 i18n 运行时）。 */
const OLD_BODY_SUFFIX = '（旧身体）';

/** rotate 过的 agent： 里是退役 body；外加一个已注销 agent 的旧 body。 */
const RETIRED_ROSTER: LabelRoster = {
  node: { current: true, name: 'node-a' },
  agents: [
    {
      name: 'rotator',
      role: 'temporary',
      owner: 'main',
      session_id: 'sess-multi-primary',
      bodies: [{ body_id: 'sess-multi-primary', session_id: 'sess-multi-primary', primary: true }],
      body_history: [
        { session_id: 'sess-multi-secondary' },
        { session_id: 'sess-never-listed' },
        { session_id: 'sess-multi-primary' },
      ],
    },
    {
      name: 'builder',
      role: 'temporary',
      owner: 'main',
      session_id: 'sess-temp',
      body_history: [{ session_id: 'sess-temp-old' }, { session_id: 'sess-temp' }],
    },
    {
      name: 'gone',
      role: 'temporary',
      owner: 'main',
      body_history: [{ session_id: 'sess-closed-old' }],
    },
    { name: 'reviewer', role: 'member', team_id: 'team-1', session_id: 'sess-member' },
  ],
  rosters: [
    {
      team: { team_id: 'team-1' },
      members: [{ name: 'reviewer', role: 'member', session_id: 'sess-member' }],
    },
  ],
};

const RETIRED_LABELS = sessionAgentRetiredLabels(
  [RETIRED_ROSTER],
  SESSIONS,
  (name) => name + OLD_BODY_SUFFIX,
);

interface Fixture {
  name: string;
  why: string;
  check: () => boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'F1 非 team 成员的 primary 会话 -> 名字@primary',
    why: '临时成员（owner = main）的会话拿不到节点地址，第二行要能看出是谁',
    check: () => LABELS.get('sess-temp') === 'builder@primary',
  },
  {
    name: 'F2 team 成员的会话 -> 不产出',
    why: '成员的会话走 agentAddresses（name@node:team），标签一旦产出就会盖掉地址',
    check: () => !LABELS.has('sess-member'),
  },
  {
    name: 'F3 roster 里找不到该会话的 agent -> 不产出',
    why: '会话列表里有、roster 里没有（刚关掉的会话 / 别的节点）时不许瞎猜名字',
    check: () => !LABELS.has('sess-ghost'),
  },
  {
    name: 'F4 agent.name 为空 / 只有空格 -> 不产出',
    why: '宁可不显示，也不要出现半个 @primary（渲染自然落回 primary 徽标）',
    check: () => !LABELS.has('sess-noname') && ![...LABELS.values()].includes('@primary'),
  },
  {
    name: 'F5 一个 agent 有多具 body -> 只标 primary 那具',
    why: 'rotate 之后旧 body 的会话不是 primary body，标上就骗人',
    check: () =>
      LABELS.get('sess-multi-primary') === 'rotator@primary' && !LABELS.has('sess-multi-secondary'),
  },
  {
    name: 'F6 未加入 Team 的 agent（无 role / owner / team_id）-> 产出',
    why: 'roleOf 会把缺 role 的条目推断成 member，但 agents.list 里这类 agent 是未绑定的',
    check: () => LABELS.get('sess-unbound') === 'lonely@primary',
  },
  {
    name: 'F7 node 不是当前节点 / 没有名字 -> 成员会话依然不产出',
    why: '地址算不出来时成员的第二行保持原样（掉回 primary 徽标），不能被我改成名字@primary',
    check: () => !sessionAgentLabels([ROSTER_NO_ADDRESS], SESSIONS).has('sess-member'),
  },
  {
    name: 'F8 不传 sessions -> 不过滤（primaryWord 缺省为 primary）',
    why: '纯函数的默认口径要与传 t(team.member.primaryBadge) 时一致，别依赖调用方',
    check: () => sessionAgentLabels([ROSTER]).get('sess-temp') === 'builder@primary',
  },
  {
    name: 'F9 接线：useChatSessions 派生 + ChatView 透传',
    why: '函数算对了但没派生/没透传，用户看到的还是裸 primary（不许在渲染里现算）',
    check: () =>
      readChatSource('useChatSessions.ts').includes('sessionAgentLabels(rosters, sessions') &&
      readChatSource('ChatView.tsx').includes('agentLabels={sessionsApi.agentLabels}'),
  },
  {
    name: 'F10 接线：SessionRail 转交给 SessionList',
    why: '中间少一层就断链（SessionRail 是列表唯一的渲染入口）',
    check: () =>
      readChatSource('SessionRail.tsx').includes('agentLabels={agentLabels}') &&
      readChatSource('SessionRail.tsx').includes('agentLabels: ReadonlyMap<string, string>'),
  },
  {
    name: 'F12 已退役 body 的会话 -> 名字（旧身体）',
    why: 'rotate 之前那具身体的会话既不在 bodies[] 也不在 primary 里，之前整行是空的（用户报的空白）',
    check: () =>
      RETIRED_LABELS.get('sess-multi-secondary') === 'rotator（旧身体）' &&
      RETIRED_LABELS.get('sess-temp-old') === 'builder（旧身体）',
  },
  {
    name: 'F13 现役 body 不会被标成旧身体',
    why: '迟到的 body_history 不许覆盖现状（否则活着的会话被打成历史）',
    check: () =>
      !RETIRED_LABELS.has('sess-temp') &&
      !RETIRED_LABELS.has('sess-multi-primary') &&
      !RETIRED_LABELS.has('sess-member'),
  },
  {
    name: 'F14 不在会话列表里的旧 body 不产出',
    why: '没被列出的会话不需要标签；产出来只占内存、还可能被误用',
    check: () => !RETIRED_LABELS.has('sess-never-listed'),
  },
  {
    name: 'F15 已注销 agent 的 body 也能标（名字还在 body_history 里）',
    why: 'agent 注销后成员条目仍在 roster，会话历史仍要能看出是谁的',
    check: () => RETIRED_LABELS.get('sess-closed-old') === 'gone（旧身体）',
  },
  {
    name: 'F16 接线：useChatSessions 派生 agentRetiredLabels + 三处透传',
    why: '算对了没透传，用户看到的仍是空白第二行',
    check: () =>
      readChatSource('useChatSessions.ts').includes(
        'sessionAgentRetiredLabels(rosters, sessions',
      ) &&
      readChatSource('ChatView.tsx').includes(
        'agentRetiredLabels={sessionsApi.agentRetiredLabels}',
      ) &&
      readChatSource('SessionRail.tsx').includes('agentRetiredLabels={agentRetiredLabels}'),
  },
  {
    name: 'F17 接线：SessionList 四级回退 + 已退役用灰色 class',
    why: '现役用主题色、已退役用 primary 灰；四级顺序一破，地址/名字会被旧身体标签顶掉',
    check: () =>
      readChatSource('SessionList.tsx').includes('agentRetiredLabels?.get(session.session_id)') &&
      readChatSource('SessionList.tsx').includes(
        'className="session-agent session-agent-primary"',
      ) &&
      readChatSource('SessionList.tsx').includes('className="session-agent session-agent-address"'),
  },
  {
    name: 'F11 接线：SessionList 三级第二行 + 地址优先',
    why: '地址优先这条一破，team 成员的节点地址就会被名字@primary 顶掉',
    check: () =>
      readChatSource('SessionList.tsx').includes(
        'agentAddress ? undefined : agentLabels?.get(session.session_id)',
      ),
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
  console.error(`session agent label: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`session agent label: ${FIXTURES.length} fixtures passed`);
