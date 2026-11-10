#!/usr/bin/env bun

/**
 * 时间线排序门禁（docs/WEB-UI.md「时间线渲染顺序」的机械判定）。
 *
 * 每个 fixture = 一段输入 + 期望的 key 序列。排序实现只有一处：
 * （纯函数，无 React / DOM）。
 * 这个脚本不测渲染、不测浏览器，只测「顺序」这一条可判定的不变量。
 *
 * 用法：bun run scripts/check-timeline-order.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import {
  orderTimelineEntries,
  type TimelineMessageInput,
  type TimelineOrderInput,
} from '../apps/web/src/domains/chat/timeline-order';

interface Fixture {
  name: string;
  /** 为什么这条 fixture 存在（失败时的诊断线索）。 */
  why: string;
  input: TimelineOrderInput;
  expected: string[];
}

function user(key: string, content: string, ts: number | undefined): TimelineMessageInput {
  return {
    key,
    role: 'user',
    content,
    runtimeContext: false,
    ...(ts !== undefined ? { timestamp: ts } : {}),
  };
}

function assistant(key: string, content: string, ts: number): TimelineMessageInput {
  return { key, role: 'assistant', content, runtimeContext: false, timestamp: ts };
}

function contextMessage(key: string, ts: number): TimelineMessageInput {
  return { key, role: 'user', content: 'runtime context', runtimeContext: true, timestamp: ts };
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'F1 真实 bug：run 起始 ts 早于用户消息',
    why: 'core 先发 run.started 再把用户消息写进上下文并打 timestamp，只按 run 起始时间排会把本轮输出顶到消息上面',
    input: {
      messages: [user('m-u1', '帮我跑 tsc', 1000)],
      live: [{ key: 'run-1', startTs: 999, seq: 11, input: '帮我跑 tsc', running: true }],
    },
    expected: ['m-u1', 'run-1'],
  },
  {
    name: 'F2 同文多轮：第二个 run 锚到第二条消息',
    why: '同一句话连发两次时，本轮 run 必须贴在最新那条消息之后，而不是第一条',
    input: {
      messages: [user('m-u1', '再来一次', 1000), user('m-u2', '再来一次', 2000)],
      live: [{ key: 'run-2', startTs: 1900, seq: 21, input: '再来一次', running: true }],
    },
    expected: ['m-u1', 'm-u2', 'run-2'],
  },
  {
    name: 'F3a guardrail 改写 + running：回落最后一条用户消息',
    why: 'input 与落盘正文不一致时，仍在跑的 run 允许回落到最后一条用户消息之后',
    input: {
      messages: [assistant('m-a0', '上一轮答复', 900), user('m-u1', 'hello', 1000)],
      live: [{ key: 'run-1', startTs: 800, seq: 31, input: '被改写过的输入', running: true }],
    },
    expected: ['m-a0', 'm-u1', 'run-1'],
  },
  {
    name: 'F3b guardrail 改写 + completed：不回落',
    why: '已终态 run 不回落到最后一条用户消息，否则历史轮次的失败/取消卡会被拽到当前轮',
    input: {
      messages: [user('m-u1', 'hello', 1000), assistant('m-a1', 'hi', 1500)],
      live: [{ key: 'run-old', startTs: 500, seq: 32, input: '被改写过的输入', running: false }],
    },
    expected: ['run-old', 'm-u1', 'm-a1'],
  },
  {
    name: 'F4 伪 run 组不聚堆：按 item 各自事件时间落位',
    why: 'session.titled 用常量 run_id session、runtime.notice 用常量 runtime，整组锚在首个事件会让后续系统消息堆在最早时刻',
    input: {
      messages: [user('m-u1', 'q1', 1000), assistant('m-a1', 'a1', 2000)],
      live: [
        {
          key: 'ambient-session',
          items: [
            { key: 'i1', ts: 1500 },
            { key: 'i2', ts: 2500 },
          ],
        },
      ],
    },
    expected: ['m-u1', 'ambient-session#i1', 'm-a1', 'ambient-session#i2'],
  },
  {
    name: 'F5 分页夹取：早于窗口首条的节点落到末尾',
    why: '比可见窗口更早的 live 节点不能插进可见历史中间，否则会出现「陈旧 run 卡黏在消息中间」',
    input: {
      messages: [user('m-u1', 'q1', 5000), assistant('m-a1', 'a1', 5500)],
      windowStartTs: 5000,
      live: [{ key: 'run-stale', startTs: 4000, seq: 51, input: '很早以前的问题', running: false }],
    },
    expected: ['m-u1', 'm-a1', 'run-stale'],
  },
  {
    name: 'F6 同 ts 用 seq 回退，保持稳定',
    why: '同毫秒落位的 live 节点必须有确定的先后（wire seq），不能被插入顺序左右',
    input: {
      messages: [user('m-u1', 'q1', 1000), user('m-u2', 'q2', 2000)],
      live: [
        { key: 'run-b', startTs: 2000, seq: 62, input: 'q2' },
        { key: 'run-a', startTs: 2000, seq: 61, input: 'q2' },
      ],
    },
    expected: ['m-u1', 'm-u2', 'run-a', 'run-b'],
  },
  {
    name: 'F7 缺 timestamp 的消息沿用前一条时间',
    why: '老数据降级：不能因为缺 timestamp 就把消息甩到末尾',
    input: {
      messages: [
        user('m-u1', 'q1', 1000),
        { key: 'm-legacy', role: 'assistant', content: 'legacy', runtimeContext: false },
        user('m-u2', 'q2', 2000),
      ],
      live: [{ key: 'run-2', startTs: 1900, seq: 71, input: 'q2', running: true }],
    },
    expected: ['m-u1', 'm-legacy', 'm-u2', 'run-2'],
  },
  {
    name: 'F8 vessel:* 上下文消息不当 turn 锚点',
    why: '模型侧上下文消息不是用户输入，拿它当锚点会把本轮输出排到真实用户消息之后很远',
    input: {
      messages: [user('m-u1', 'q1', 1000), contextMessage('m-ctx', 3000)],
      live: [{ key: 'run-1', startTs: 900, seq: 81, input: '被改写过的输入', running: true }],
    },
    expected: ['m-u1', 'run-1', 'm-ctx'],
  },
];

/** 跑一条 fixture；返回实际 key 序列。 */
function runFixture(fixture: Fixture): string[] {
  return orderTimelineEntries(fixture.input).map((entry) => entry.key);
}

const failures: { fixture: Fixture; actual: string[] }[] = [];
for (const fixture of FIXTURES) {
  const actual = runFixture(fixture);
  const same =
    actual.length === fixture.expected.length &&
    actual.every((key, index) => key === fixture.expected[index]);
  if (same) continue;
  failures.push({ fixture, actual });
}

if (failures.length > 0) {
  for (const { fixture, actual } of failures) {
    console.log('FAIL ' + fixture.name);
    console.log('     why:      ' + fixture.why);
    console.log('     expected: ' + JSON.stringify(fixture.expected));
    console.log('     actual:   ' + JSON.stringify(actual));
  }
  console.error(
    'timeline order: ' + failures.length + '/' + FIXTURES.length + ' fixture(s) FAILED',
  );
  process.exit(1);
}

console.log('timeline order: ' + FIXTURES.length + ' fixtures passed');
