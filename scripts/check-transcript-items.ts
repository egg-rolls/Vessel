#!/usr/bin/env bun

/**
 * 单一 item 流门禁（ 的机械判定）。
 *
 * 这里钉死的是「身份」而不是观感：同一个逻辑对象在 live 与 history 里只能是**同一个
 * item**（key 相同、数量唯一），运行→结束不换 key。
 *
 * 用法：bun run scripts/check-transcript-items.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { pendingStripView } from '../apps/web/src/domains/chat/pending-strip';
import {
  buildTranscriptItems,
  type TranscriptItem,
} from '../apps/web/src/domains/chat/transcript-items';
import type { Message } from '../apps/web/src/gateway/types/sessions';
import type { RunGroup, TimelineItem } from '../apps/web/src/state/events';

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { role, content, ...extra };
}

function assistantCall(id: string, name: string, args = '{}', content = ''): Message {
  return {
    role: 'assistant',
    content,
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  };
}

function toolMsg(callId: string, output: string): Message {
  return { role: 'tool', content: output, tool_call_id: callId };
}

function group(overrides: Partial<RunGroup> & { runId: string }): RunGroup {
  return {
    status: 'running',
    hasRunEvent: true,
    items: [],
    ...overrides,
  };
}

function textItem(text: string, key = 'text-0'): TimelineItem {
  return { kind: 'text', text, key };
}

function toolItem(callId: string, status: 'running' | 'done' | 'error'): TimelineItem {
  return {
    kind: 'event',
    key: `ev-${callId}`,
    event: {
      type: status === 'running' ? 'tool.call.started' : 'tool.call.completed',
      run_id: 'r1',
      ts: 1000,
      data: { run_id: 'r1', tool_call_id: callId, tool_name: 'bash', arguments: {}, result: 'ok' },
    },
  };
}

function noticeItem(seq: number, ts: number): TimelineItem {
  return {
    kind: 'notice',
    key: `notice-${seq}`,
    event: { type: 'context.compacted', run_id: 'session', ts, data: {} },
  };
}

function keys(items: readonly TranscriptItem[]): string[] {
  return items.map((item) => item.key);
}

function count(items: readonly TranscriptItem[], kind: TranscriptItem['kind']): number {
  return items.filter((item) => item.kind === kind).length;
}

interface Fixture {
  name: string;
  why: string;
  check: () => boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'F1 同一工具在 live 与 history 同时存在 → 一个 item',
    why: 'live 有 tool.call 事件、history 有配对结果时，必须是同一个 tool:<callId>，不能两张卡',
    check: () => {
      const items = buildTranscriptItems({
        messages: [msg('user', 'run tsc'), assistantCall('c1', 'bash'), toolMsg('c1', 'ok')],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', items: [toolItem('c1', 'running')], input: 'run tsc' })],
        queued: [],
      });
      const tools = items.filter((item) => item.kind === 'tool');
      return tools.length === 1 && tools[0]?.key === 'tool:c1';
    },
  },
  {
    name: 'F2 同一段正文：流式中 vs flush 后 → 同一个 key',
    why: '尾部未闭合段用当前段序做 key，flush 后段序不变，所以不会重挂',
    check: () => {
      const streaming = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', liveText: 'hello' })],
        queued: [],
      });
      const flushed = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', items: [textItem('hello')], status: 'completed' })],
        queued: [],
      });
      const a = streaming.find((item) => item.kind === 'run-text');
      const b = flushed.find((item) => item.kind === 'run-text');
      return a?.key === 'run:r1:text:0' && b?.key === 'run:r1:text:0';
    },
  },
  {
    name: 'F3 两个不同 callId → 两个 tool item',
    why: '不同调用不能合并',
    check: () => {
      const items = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [
          group({ runId: 'r1', items: [toolItem('c1', 'running'), toolItem('c2', 'running')] }),
        ],
        queued: [],
      });
      const ids = items.filter((item) => item.kind === 'tool').map((item) => item.key);
      return ids.length === 2 && ids.includes('tool:c1') && ids.includes('tool:c2');
    },
  },
  {
    name: 'F4 同一句话连发两次 → 两条消息 item，各认领各的',
    why: '按内容认领最容易吞消息；必须按轮次顺序一对一匹配',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', '再来一次'),
          msg('assistant', '第一次答复'),
          msg('user', '再来一次'),
        ],
        messageIndexOffset: 0,
        liveGroups: [
          group({ runId: 'r1', status: 'completed', input: '再来一次', output: '第一次答复' }),
          group({ runId: 'r2', input: '再来一次' }),
        ],
        queued: [],
      });
      const userItems = items.filter(
        (item) => item.kind === 'message' && item.message.role === 'user',
      );
      const unclaimedInput = items.some((item) => item.kind === 'run-input');
      return (
        userItems.length === 2 &&
        userItems[0]?.key === 'msg:0' &&
        userItems[1]?.key === 'msg:2' &&
        !unclaimedInput
      );
    },
  },
  {
    name: 'F4b 只到第一轮历史 → 第二轮仍渲染（不被第一轮认领掉）',
    why: '第二轮的消息还没落盘时，必须由 run 自己渲染输入，不能被上一轮的认领吞掉',
    check: () => {
      const items = buildTranscriptItems({
        messages: [msg('user', '再来一次'), msg('assistant', '第一次答复')],
        messageIndexOffset: 0,
        liveGroups: [
          group({ runId: 'r1', status: 'completed', input: '再来一次', output: '第一次答复' }),
          group({ runId: 'r2', input: '再来一次' }),
        ],
        queued: [],
      });
      return items.some((item) => item.kind === 'run-input' && item.key === 'run:r2:input');
    },
  },
  {
    name: 'F5 notice 逐条成 item，且不打断分组',
    why: 'notice 两条各自一个 item；它们不参与连续发言人判定',
    check: () => {
      const items = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r1',
            items: [
              textItem('a', 'text-0'),
              noticeItem(1, 1200),
              noticeItem(2, 1300),
              textItem('b', 'text-1'),
            ],
          }),
        ],
        queued: [],
      });
      const notices = items.filter((item) => item.kind === 'notice');
      const texts = items.filter((item) => item.kind === 'run-text');
      const grouped = texts.map((item) => (item as { groupStart?: boolean }).groupStart);
      return (
        notices.length === 2 && grouped.length === 2 && grouped[0] === true && grouped[1] === false
      );
    },
  },
  {
    name: 'F6 窗口前插：start 100 → 50，已有 item key 不变',
    why: 'msg 用绝对下标，前插只改 offset',
    check: () => {
      const messages = [msg('user', 'a'), msg('assistant', 'b')];
      const before = buildTranscriptItems({
        messages,
        messageIndexOffset: 100,
        liveGroups: [],
        queued: [],
      });
      const after = buildTranscriptItems({
        messages,
        messageIndexOffset: 50,
        liveGroups: [],
        queued: [],
      });
      return (
        JSON.stringify(keys(before)) === JSON.stringify(['msg:100', 'msg:101']) &&
        JSON.stringify(keys(after)) === JSON.stringify(['msg:50', 'msg:51'])
      );
    },
  },
  {
    name: 'F7 认领失败（guardrail 改写过正文）→ 两条都渲染',
    why: '内容对不上时宁可重复也不能吞消息',
    check: () => {
      const items = buildTranscriptItems({
        messages: [msg('user', '原始输入'), msg('assistant', '落盘答复')],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', input: '被改写过的输入', output: '完全不同的输出' })],
        queued: [],
      });
      const messages = items.filter((item) => item.kind === 'message');
      const input = items.some((item) => item.kind === 'run-input');
      return messages.length === 2 && input;
    },
  },
  {
    name: 'F9 早于可见窗口的 live item 保留真实 ts（不再沉到末尾）',
    why: '夹取成 ts=undefined 会让旧卡排到新卡后面，屏幕上时间看起来倒序',
    check: () => {
      const items = buildTranscriptItems({
        messages: [msg('user', 'window-start', { timestamp: 5000 })],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r-old', input: 'old', startedAt: 1000 })],
        queued: [],
        windowStartTs: 5000,
      });
      const keysInOrder = keys(items);
      // 旧的 run-input 必须排在窗口首条消息之前，且带真实 ts（不是 undefined）。
      const oldItem = items.find((item) => item.kind === 'run-input');
      return keysInOrder[0] === 'run:r-old:input' && oldItem !== undefined && oldItem.ts === 1000;
    },
  },
  {
    name: 'F8 只有 tool_calls 的 assistant 消息不产生空 item',
    why: '那次调用的工具卡代表它；再出一个空消息 item 就是幽灵行',
    check: () => {
      const items = buildTranscriptItems({
        messages: [msg('user', 'go'), assistantCall('c1', 'bash'), toolMsg('c1', 'ok')],
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
      });
      return count(items, 'message') === 1 && count(items, 'tool') === 1;
    },
  },
  {
    name: 'F15 待处理条带：held 在前（ts 升序），其余按 ts 升序，只预览 3 条',
    why: '条带只做稳定排序 + 折叠，不做假拖拽；held（已排队）必须排在未读之前',
    check: () => {
      const view = pendingStripView([
        { message_id: 'c', from: 'a', summary: 's3', status: 'unread', ts: 300 },
        { message_id: 'b', from: 'a', summary: 's2', status: 'held', ts: 200 },
        { message_id: 'a', from: 'a', summary: 's1', status: 'held', ts: 100 },
        { message_id: 'd', from: 'a', summary: 's4', status: 'unread', ts: 400 },
      ]);
      return (
        view.total === 4 &&
        view.preview.length === 3 &&
        view.hidden === 1 &&
        view.ordered.map((entry) => entry.message_id).join(',') === 'a,b,c,d'
      );
    },
  },
  {
    name: 'F14 run 结束后历史回填，工具卡仍留在思考与正文之间',
    why: '历史侧工具 item 的 ts 是所属 assistant 消息时间，会把卡顶到正文之后（聚堆）',
    check: () => {
      const runGroup = group({
        runId: 'r-order',
        input: 'go',
        output: 'done text',
        startedAt: 1000,
        status: 'completed',
        items: [
          { kind: 'reasoning', text: 'think', key: 'a', startedAt: 1001 },
          toolItem('c1', 'running'),
          toolItem('c1', 'done'),
          textItem('done text', 't'),
        ],
      });
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'go', { timestamp: 999 }),
          msg('assistant', 'done text', {
            timestamp: 1004,
            reasoning_content: 'think',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
          }),
          msg('tool', 'ok', { timestamp: 1005, tool_call_id: 'c1' }),
        ],
        messageIndexOffset: 0,
        liveGroups: [runGroup],
        queued: [],
      });
      return (
        items.length === 4 &&
        items.map((item) => item.kind).join(',') === 'message,run-reasoning,tool,run-text'
      );
    },
  },
  {
    name: 'F13 run 缺 startedAt/firstTs 但有 tool item 时间 → 排在消息之间而不是末尾',
    why: '事件被边界回放裁掉只剩部分条目时，整组没有 ts 会沉到最底（旧工具卡挂在新内容后面）',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', '早', { timestamp: 1000 }),
          msg('assistant', '晚', { timestamp: 2000 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r-cut',
            // 故意不给 startedAt / firstTs：只留一条带时间（ts=1500）的工具事件
            items: [
              {
                kind: 'event',
                key: 'ev-cut',
                event: {
                  type: 'tool.call.started',
                  run_id: 'r-cut',
                  ts: 1500,
                  data: {
                    run_id: 'r-cut',
                    tool_call_id: 'c-cut',
                    tool_name: 'bash',
                    arguments: {},
                  },
                },
              },
            ],
          }),
        ],
        queued: [],
      });
      const keys = items.map((item) => item.key);
      const tool = items.find((item) => item.kind === 'tool');
      return (
        keys.indexOf('tool:c-cut') === 1 &&
        tool !== undefined &&
        tool.ts === 1500 &&
        keys.length === 3
      );
    },
  },
  {
    name: 'F11 vessel:notice 可见时生成 notice 类 item（不是 message）',
    why: '打开「显示系统信息」后它曾被渲染成用户气泡；结构化消息必须走 notice 卡',
    check: () => {
      const messages = [
        { role: 'user' as const, name: 'vessel:notice', content: '[inbox] 3 unread, 1 pending' },
      ];
      const visible = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
        noticeKindOf: (message) => (message.name === 'vessel:notice' ? 'notice' : undefined),
      });
      const hidden = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
        isHidden: (message) => message.name === 'vessel:notice',
        noticeKindOf: (message) => (message.name === 'vessel:notice' ? 'notice' : undefined),
      });
      const first = visible[0];
      return (
        visible.length === 1 &&
        first !== undefined &&
        first.kind === 'runtime-notice' &&
        first.noticeKind === 'notice' &&
        hidden.length === 0
      );
    },
  },
  {
    name: 'F11b 用户自己发的 [inbox] 开头的文本仍是普通消息',
    why: '按正文前缀猜会吞掉用户输入：这是刻意不做文本启发式的反向保护',
    check: () => {
      const items = buildTranscriptItems({
        messages: [msg('user', '[inbox] 这是我粘贴的日志，不是系统提示')],
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
      });
      const first = items[0];
      return items.length === 1 && first !== undefined && first.kind === 'message';
    },
  },
  {
    name: 'F9 vessel:source 默认隐藏 → 不出 item；打开可见性后出现（或被吸收）',
    why: 'runtime 上下文消息必须按可见性开关过滤；回归时它会以普通消息行呈现成第二条',
    check: () => {
      const messages = [
        {
          role: 'user' as const,
          name: 'vessel:source',
          content: '<from location="a@node:team" />',
        },
        msg('user', 'hello'),
      ];
      const hidden = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
        isHidden: (message) => message.name === 'vessel:source',
      });
      const visible = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
      });
      return count(hidden, 'message') === 1 && count(visible, 'message') === 2;
    },
  },
  {
    name: 'F10b 来源行被隐藏时，地址仍然吸进 agent 卡（信息不丢）',
    why: '默认档 vessel:source 不显示，但用户要的是地址挂到卡上，而不是整条信息消失',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          {
            role: 'user' as const,
            name: 'vessel:source',
            content: '<from location="simplify-core@n1:vessel" />',
          },
          { role: 'user' as const, name: 'agent:simplify-core', content: '收到' },
        ],
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
        isHidden: (message) => message.name === 'vessel:source',
      });
      const messages = items.filter((item) => item.kind === 'message');
      const first = messages[0];
      const source = first !== undefined && first.kind === 'message' ? first.sourceText : undefined;
      return messages.length === 1 && source === 'simplify-core@n1:vessel';
    },
  },
  {
    name: 'F10 vessel:source 紧跟 agent 消息 → 被吸收，地址进 agent 卡',
    why: '打开系统信息时也不该出现「来源行 + agent 卡」两条；地址挂到 agent 卡 meta',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          {
            role: 'user' as const,
            name: 'vessel:source',
            content: '<from location="simplify-core@n1:vessel" />',
          },
          { role: 'user' as const, name: 'agent:simplify-core', content: '收到，我来处理' },
        ],
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
      });
      const messages = items.filter((item) => item.kind === 'message');
      const agent = messages.find(
        (item) => item.kind === 'message' && item.message.name !== undefined,
      );
      const source = agent !== undefined && agent.kind === 'message' ? agent.sourceText : undefined;
      return messages.length === 1 && source === 'simplify-core@n1:vessel';
    },
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
  console.error(`transcript items: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`transcript items: ${FIXTURES.length} fixtures passed`);
