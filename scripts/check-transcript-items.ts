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
  buildLiveItems,
  buildTranscriptItems,
  type TranscriptItem,
} from '../apps/web/src/domains/chat/transcript-items';
import type { Message } from '../apps/web/src/gateway/types/sessions';
import { EventStore } from '../apps/web/src/state/event-store';
import type { RunGroup, TimelineItem } from '../apps/web/src/state/events';
import { EventGroupCache } from '../apps/web/src/state/group-cache';

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
    name: 'F16 长 run（数千 delta、3 段思考、多轮工具）→ 所有 reasoning 段都在且有序',
    why: 'per-run 上限按 delta 计数会把最早的 thinking 段整段挤出（真实 run 177 轮 / 70k tokens）',
    check: () => {
      const store = new EventStore(0);
      let seq = 0;
      const push = (type: string, data: Record<string, unknown>) => {
        seq += 1;
        store.push({ type, run_id: 'r-long', data, ts: 1000 + seq } as never, { seq });
      };
      push('run.started', { run_id: 'r-long', session_id: 's1', input: 'go' });
      for (let round = 0; round < 3; round += 1) {
        // 每段思考 1200 个 delta：旧上限（2000/run）下第二段起就会挤掉前面的段
        for (let index = 0; index < 1200; index += 1) {
          push('llm.stream.chunk', {
            run_id: 'r-long',
            chunk: { type: 'reasoning_delta', delta: 'x' },
          });
        }
        push('tool.call.started', {
          run_id: 'r-long',
          tool_call_id: `c${round}`,
          tool_name: 'bash',
          arguments: {},
        });
        push('tool.call.completed', {
          run_id: 'r-long',
          tool_call_id: `c${round}`,
          tool_name: 'bash',
          result: 'ok',
          duration_ms: 1,
        });
      }
      store.flush();
      const snapshot = store.getSnapshot();
      const cache = new EventGroupCache();
      const groups = cache.group(snapshot.entries, false, 'user', snapshot.truncatedSince);
      const items = buildLiveItems(groups);
      const reasoningItems = items.filter((item) => item.kind === 'run-reasoning');
      const tools = items.filter((item) => item.kind === 'tool');
      return reasoningItems.length === 3 && tools.length === 3;
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
  // G1 / G2 / G3 的输入与期望逐字照做 HANDOFF-main.md 4.5「三条必过 fixture」：
  // 不要为了方便改输入，也不要放宽期望。
  {
    name: 'G1 输出丢失回归：live 只有 started、历史有结果 -> 一张卡、output 取历史、status 取 live',
    why: '客户端漏掉 tool.call.completed 时落盘输出必须还在；预过滤/合并吞掉它就是空结果卡',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'run it'),
          msg('assistant', '', {
            timestamp: 1001,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
            ],
          }),
          msg('tool', 'PERSISTED-OUTPUT', { timestamp: 1005, tool_call_id: 'c1' }),
        ],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r1',
            status: 'running',
            input: 'run it',
            items: [
              {
                kind: 'event',
                key: 'g1-started',
                event: {
                  type: 'tool.call.started',
                  run_id: 'r1',
                  ts: 1002,
                  data: { run_id: 'r1', tool_call_id: 'c1', tool_name: 'bash', arguments: {} },
                },
              },
            ],
          }),
        ],
        queued: [],
      });
      const cards = items.filter((item) => item.kind === 'tool');
      const card = cards[0];
      return (
        cards.length === 1 &&
        card !== undefined &&
        card.kind === 'tool' &&
        card.key === 'tool:c1' &&
        card.output === 'PERSISTED-OUTPUT' &&
        card.status === 'running' &&
        card.paired === true
      );
    },
  },
  {
    name: 'G2 两边都有 -> 一张卡、output 不丢、status 取 live、位置按历史（不断言 ts）',
    why: '同一调用在 live 与 history 各出现一次时只能出一张卡；历史子序列必须等于 [user, tool]',
    check: () => {
      const messages = [
        msg('user', 'go', { timestamp: 999 }),
        msg('assistant', '', {
          timestamp: 1001,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
        }),
        msg('tool', 'ok', { timestamp: 1005, tool_call_id: 'c1' }),
      ];
      const liveGroups = [
        group({
          runId: 'r1',
          status: 'completed',
          startedAt: 1000,
          items: [
            {
              kind: 'event',
              key: 'g2-started',
              event: {
                type: 'tool.call.started',
                run_id: 'r1',
                ts: 1002,
                data: { run_id: 'r1', tool_call_id: 'c1', tool_name: 'bash', arguments: {} },
              },
            },
            {
              kind: 'event',
              key: 'g2-completed',
              event: {
                type: 'tool.call.completed',
                run_id: 'r1',
                ts: 1003,
                data: {
                  run_id: 'r1',
                  tool_call_id: 'c1',
                  tool_name: 'bash',
                  result: 'ok',
                  duration_ms: 1,
                },
              },
            },
            { kind: 'text', text: 'live tail', key: 'g2-text', startedAt: 1004, endedAt: 1004 },
          ],
        }),
      ];
      const merged = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups,
        queued: [],
      });
      const historyOnly = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
      });
      const historyKeys = new Set(historyOnly.map((item) => item.key));
      const shared = merged.filter((item) => historyKeys.has(item.key)).map((item) => item.key);
      const cards = merged.filter((item) => item.kind === 'tool');
      const card = cards[0];
      return (
        cards.length === 1 &&
        card !== undefined &&
        card.kind === 'tool' &&
        card.output === 'ok' &&
        card.status === 'done' &&
        JSON.stringify(shared) === JSON.stringify(['msg:0', 'tool:c1'])
      );
    },
  },
  {
    name: 'G3 多工具不回退：每个 call 一张卡、a 在 b 之前、输出各归各',
    why: '一轮多个调用回填时不能重新聚堆或颠倒（两种位置口径下的安全网）',
    check: () => {
      const messages = [
        msg('assistant', '', {
          timestamp: 1001,
          tool_calls: [{ id: 'a', type: 'function', function: { name: 'bash', arguments: '{}' } }],
        }),
        msg('tool', 'oa', { timestamp: 1099, tool_call_id: 'a' }),
        msg('assistant', '', {
          timestamp: 1101,
          tool_calls: [{ id: 'b', type: 'function', function: { name: 'bash', arguments: '{}' } }],
        }),
        msg('tool', 'ob', { timestamp: 1199, tool_call_id: 'b' }),
      ];
      const liveGroups = [
        group({
          runId: 'r1',
          status: 'completed',
          startedAt: 1000,
          items: [
            {
              kind: 'event',
              key: 'g3-a-started',
              event: {
                type: 'tool.call.started',
                run_id: 'r1',
                ts: 1100,
                data: { run_id: 'r1', tool_call_id: 'a', tool_name: 'bash', arguments: {} },
              },
            },
            {
              kind: 'event',
              key: 'g3-a-completed',
              event: {
                type: 'tool.call.completed',
                run_id: 'r1',
                ts: 1101,
                data: { run_id: 'r1', tool_call_id: 'a', tool_name: 'bash', result: 'oa' },
              },
            },
            { kind: 'text', text: 'mid text', key: 'g3-text', startedAt: 1150, endedAt: 1150 },
            {
              kind: 'event',
              key: 'g3-b-started',
              event: {
                type: 'tool.call.started',
                run_id: 'r1',
                ts: 1200,
                data: { run_id: 'r1', tool_call_id: 'b', tool_name: 'bash', arguments: {} },
              },
            },
            {
              kind: 'event',
              key: 'g3-b-completed',
              event: {
                type: 'tool.call.completed',
                run_id: 'r1',
                ts: 1201,
                data: { run_id: 'r1', tool_call_id: 'b', tool_name: 'bash', result: 'ob' },
              },
            },
          ],
        }),
      ];
      const merged = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups,
        queued: [],
      });
      const cards = merged.filter((item) => item.kind === 'tool');
      const first = cards[0];
      const second = cards[1];
      return (
        cards.length === 2 &&
        first !== undefined &&
        second !== undefined &&
        first.kind === 'tool' &&
        second.kind === 'tool' &&
        first.key === 'tool:a' &&
        second.key === 'tool:b' &&
        first.output === 'oa' &&
        second.output === 'ob'
      );
    },
  },
  {
    name: 'F18 主 oracle：order(live+history) 与 order(只有 history) 的 key 序列一致',
    why: 'live 只提供更早可见与更细粒度，不得改变最终顺序；否则 run 结束那一刻整段重排',
    check: () => {
      const messages = [
        msg('user', 'go', { timestamp: 1000 }),
        assistantCall('c1', 'bash', '{}', '第一段'),
        toolMsg('c1', 'ok'),
        msg('assistant', '结语', { timestamp: 1600 }),
      ];
      const liveGroups = [
        group({
          runId: 'r-ord',
          input: 'go',
          output: '结语',
          startedAt: 900,
          status: 'completed',
          items: [
            { kind: 'reasoning', text: '想1', key: 'k1', startedAt: 950, endedAt: 980 },
            { kind: 'text', text: '第一段', key: 'k2', startedAt: 990, endedAt: 1010 },
            {
              kind: 'event',
              key: 'ev-c1',
              event: {
                type: 'tool.call.started',
                run_id: 'r-ord',
                ts: 1050,
                data: { run_id: 'r-ord', tool_call_id: 'c1', tool_name: 'bash', arguments: {} },
              },
            },
            { kind: 'reasoning', text: '想2', key: 'k3', startedAt: 1500, endedAt: 1520 },
            { kind: 'text', text: '结语', key: 'k4', startedAt: 1550, endedAt: 1590 },
          ],
        }),
      ];
      const merged = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups,
        queued: [],
      });
      const historyOnly = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
      });
      const historyKeys = new Set(historyOnly.map((item) => item.key));
      const shared = merged.filter((item) => historyKeys.has(item.key)).map((item) => item.key);
      return (
        JSON.stringify(shared) === JSON.stringify(historyOnly.map((item) => item.key)) &&
        shared.length === historyOnly.length
      );
    },
  },
  {
    name: 'F19 工具卡位置与 ts 取历史：同毫秒 / 更早的 live started 都不许把卡提到正文上方',
    why: 'REVIEW 2.1-F：合并若采纳 live 的 ts（min）或倒置 push 序，同毫秒先后就改由 live 插入序决定，卡被顶到本轮正文之前',
    check: () => {
      const messages = [
        // 用户消息 ts 与 live 的 started 同毫秒（1002）；assistant 的 ts（1001）是历史工具 item
        // startedAt 的来源，故意与 live 的 started 不同值，好把「startedAt 取 live」也钉住。
        msg('user', 'go', { timestamp: 1002 }),
        msg('assistant', 'mid', {
          timestamp: 1001,
          tool_calls: [
            { id: 'tc9', type: 'function', function: { name: 'bash', arguments: '{}' } },
          ],
        }),
        msg('tool', 'ok', { timestamp: 1005, tool_call_id: 'tc9' }),
      ];
      const liveGroups = [
        group({
          runId: 'r-f19',
          input: 'go',
          status: 'completed',
          startedAt: 900,
          items: [
            {
              kind: 'event',
              key: 'f19-started',
              event: {
                type: 'tool.call.started',
                run_id: 'r-f19',
                ts: 1002,
                data: { run_id: 'r-f19', tool_call_id: 'tc9', tool_name: 'bash', arguments: {} },
              },
            },
          ],
        }),
      ];
      const merged = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups,
        queued: [],
      });
      const historyOnly = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
      });
      const mergedKeys = merged.map((item) => item.key);
      const tool = merged.find((item) => item.kind === 'tool');
      return (
        JSON.stringify(mergedKeys) === JSON.stringify(historyOnly.map((item) => item.key)) &&
        tool !== undefined &&
        tool.kind === 'tool' &&
        // ts 是历史结果消息的（不是 live 的 1002，也不是 floor 后的 1003）；startedAt 才是 live 的。
        tool.ts === 1005 &&
        tool.startedAt === 1002
      );
    },
  },
  {
    name: 'F20 合并内容规则：内容取历史（不被 8KiB 预览截断）、执行态取 live、兜底名不算内容',
    why: '反过来取（output/args/name 用 live）会把截断预览当内容、把兜底名 tool 当真名；这是 HANDOFF 4.5 的内容规则',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'go', { timestamp: 1000 }),
          // 历史这条调用没带工具名（空串 -> 兜底 'tool'），args 是 JSON 字符串。
          msg('assistant', '', {
            timestamp: 1001,
            tool_calls: [
              { id: 'cc', type: 'function', function: { name: '', arguments: '{"cmd":"ls"}' } },
            ],
          }),
          msg('tool', 'FULL-OUTPUT', { timestamp: 1005, tool_call_id: 'cc' }),
        ],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r20',
            input: 'go',
            status: 'completed',
            startedAt: 900,
            items: [
              {
                kind: 'event',
                key: 'f20-started',
                event: {
                  type: 'tool.call.started',
                  run_id: 'r20',
                  ts: 1002,
                  data: {
                    run_id: 'r20',
                    tool_call_id: 'cc',
                    tool_name: 'bash',
                    arguments: { cmd: 'ls' },
                    truncated: true,
                  },
                },
              },
              {
                kind: 'event',
                key: 'f20-completed',
                event: {
                  type: 'tool.call.completed',
                  run_id: 'r20',
                  ts: 1003,
                  data: {
                    run_id: 'r20',
                    tool_call_id: 'cc',
                    tool_name: 'bash',
                    result: 'PREVIEW-TRUNCATED',
                    duration_ms: 7,
                  },
                },
              },
            ],
          }),
        ],
        queued: [],
      });
      const cards = items.filter((item) => item.kind === 'tool');
      const card = cards[0];
      return (
        cards.length === 1 &&
        card !== undefined &&
        card.kind === 'tool' &&
        card.output === 'FULL-OUTPUT' &&
        card.args === '{"cmd":"ls"}' &&
        card.name === 'bash' &&
        card.status === 'done' &&
        card.durationMs === 7 &&
        card.truncated === true &&
        card.startedAt === 1002 &&
        card.ts === 1005 &&
        card.paired === true
      );
    },
  },
  {
    name: 'F17 live 条目用自己的事件时间（不是组起始 ts）→ 历史回填后不重排',
    why: '全披组起始 ts 会让整段 live 内容在历史到达时被拽到 turn 开头（上面一张卡、中间正文、下面更早的卡）',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'go', { timestamp: 1000 }),
          msg('assistant', '中间答复', { timestamp: 1300 }),
          msg('assistant', '结语', { timestamp: 1500 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r-ts',
            input: 'go',
            output: '结语',
            startedAt: 1000,
            status: 'completed',
            items: [
              { kind: 'reasoning', text: '想', key: 'k1', startedAt: 1100, endedAt: 1150 },
              {
                kind: 'event',
                key: 'ev-tool',
                event: {
                  type: 'tool.call.started',
                  run_id: 'r-ts',
                  ts: 1200,
                  data: {
                    run_id: 'r-ts',
                    tool_call_id: 'c-ts',
                    tool_name: 'bash',
                    arguments: {},
                  },
                },
              },
              { kind: 'text', text: '结语', key: 'k2', startedAt: 1400, endedAt: 1450 },
            ],
          }),
        ],
        queued: [],
      });
      const reasoning = items.find((item) => item.kind === 'run-reasoning');
      const tool = items.find((item) => item.kind === 'tool');
      // 最后一段正文被历史消息认领 → 它的 key 变成 msg:<abs>（位置以历史为准），
      // 于是这里不再存在独立的 run-text item。
      const liveText = items.find((item) => item.kind === 'run-text');
      const claimed = items.filter((item) => item.kind === 'message' && item.key === 'msg:2');
      return (
        reasoning !== undefined &&
        reasoning.ts === 1150 &&
        tool !== undefined &&
        tool.ts === 1200 &&
        liveText === undefined &&
        claimed.length === 1
      );
    },
  },
  {
    name: 'F14 理想交错只存在于 live：落盘后按消息粒度聚合是数据边界，不是 bug',
    why: '历史 tool 消息只带自己的 ts，介质里没有「工具在思考第几句之后」；合并取历史位置=接受聚合，不去猜交错',
    check: () => {
      // ① 只有 live：思考 -> 工具卡 -> 正文 的理想交错确实存在。
      const liveGroup = group({
        runId: 'r-order',
        status: 'completed',
        startedAt: 1000,
        items: [
          { kind: 'reasoning', text: 'think', key: 'rs', startedAt: 1001, endedAt: 1002 },
          {
            kind: 'event',
            key: 'f14-started',
            event: {
              type: 'tool.call.started',
              run_id: 'r-order',
              ts: 1003,
              data: { run_id: 'r-order', tool_call_id: 'c1', tool_name: 'bash', arguments: {} },
            },
          },
          {
            kind: 'event',
            key: 'f14-completed',
            event: {
              type: 'tool.call.completed',
              run_id: 'r-order',
              ts: 1004,
              data: { run_id: 'r-order', tool_call_id: 'c1', tool_name: 'bash', result: 'ok' },
            },
          },
          { kind: 'text', text: 'done text', key: 'ts', startedAt: 1005, endedAt: 1006 },
        ],
      });
      const liveOnly = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [liveGroup],
        queued: [],
      });
      const liveKinds = liveOnly.map((item) => item.kind).join(',');
      // ② 落盘后回填：assistant 一条消息同时带 reasoning_content 与 tool_calls（思考与正文
      //    属于同一条消息），结果消息单独一条 -> 交错信息在落盘介质里就不存在了。
      //    合并后必然是按消息粒度聚合的一行正文 + 一张卡；这不是 bug，别指望历史能给回交错。
      const merged = buildTranscriptItems({
        messages: [
          msg('user', 'go', { timestamp: 999 }),
          msg('assistant', 'done text', {
            timestamp: 1004,
            reasoning_content: 'think',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
            ],
          }),
          msg('tool', 'ok', { timestamp: 1005, tool_call_id: 'c1' }),
        ],
        messageIndexOffset: 0,
        liveGroups: [liveGroup],
        queued: [],
      });
      const mergedKinds = merged.map((item) => item.kind).join(',');
      const tool = merged.find((item) => item.kind === 'tool');
      return (
        liveKinds === 'run-reasoning,tool,run-text' &&
        mergedKinds === 'message,message,tool' &&
        merged.every((item) => item.kind !== 'run-reasoning') &&
        merged.every((item) => item.kind !== 'run-text') &&
        tool !== undefined &&
        tool.kind === 'tool' &&
        tool.output === 'ok'
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
  // --- 迁移自 scripts/check-timeline-order.ts（它守护的 orderTimelineEntries 已删除） ---
  // 旧门禁把一条 run 当作一个排序单位；单一 item 流按 item 拆开，所以这里的 key 是
  // run:<runId>:input / run:<runId>:text:0，断言的是同一批不变量。
  {
    name: 'O1（原 F1）run 起始早于用户消息 → 本轮输出仍在消息之后',
    why: 'core 先发 run.started 再给用户消息打 timestamp；只按 run 起始时间排会把本轮输出顶到用户消息上方',
    check: () => {
      const items = buildTranscriptItems({
        messages: [msg('user', '帮我跑 tsc', { timestamp: 1000 })],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r1',
            input: '帮我跑 tsc',
            startedAt: 999,
            firstSeq: 11,
            items: [textItem('好的', 'k1')],
          }),
        ],
        queued: [],
      });
      const text = items.find((item) => item.kind === 'run-text');
      return (
        keys(items).join(',') === 'msg:0,run:r1:text:0' && text !== undefined && text.ts === 1001
      );
    },
  },
  {
    name: 'O3a（原 F3a）running 且自己没有 ts → 回落到最后一条用户消息之后',
    why: 'guardrail 改写正文后认领失败；仍在跑的 run 不能因此沉底（弱下限只对没有自身 ts 的 item 生效）',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('assistant', '上一轮答复', { timestamp: 900 }),
          msg('user', 'hello', { timestamp: 1000 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', input: '被改写过的输入' })],
        queued: [],
      });
      const input = items.find((item) => item.kind === 'run-input');
      return (
        keys(items).join(',') === 'msg:0,msg:1,run:r1:input' &&
        input !== undefined &&
        input.ts === 1001
      );
    },
  },
  {
    name: 'O3b（原 F3b）已终态且自己没有 ts → 不回落',
    why: '已终态 run 不拿最后一条用户消息兜底，否则历史轮次的失败/取消卡会被拽到当前轮',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'hello', { timestamp: 1000 }),
          msg('assistant', 'hi', { timestamp: 1500 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r-old', input: '被改写过的输入', status: 'completed' })],
        queued: [],
      });
      const input = items.find((item) => item.kind === 'run-input');
      return (
        keys(items).join(',') === 'msg:0,msg:1,run:r-old:input' &&
        input !== undefined &&
        input.ts === undefined
      );
    },
  },
  {
    name: 'O5（原 F5，语义反转）早于窗口首条的 run 保留真实 ts，不再沉底',
    why: '旧的窗口夹取（把更早的节点 ts 抹成 undefined 沉到末尾）已废：它会让旧卡排到新卡后面，屏幕上时间倒序',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'q1', { timestamp: 5000 }),
          msg('assistant', 'a1', { timestamp: 5500 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'run-stale',
            input: '很早以前的问题',
            startedAt: 4000,
            firstSeq: 51,
            status: 'completed',
          }),
        ],
        queued: [],
        windowStartTs: 5000,
      });
      const input = items.find((item) => item.kind === 'run-input');
      return (
        keys(items).join(',') === 'run:run-stale:input,msg:0,msg:1' &&
        input !== undefined &&
        input.ts === 4000
      );
    },
  },
  {
    name: 'O6（原 F6）同 ts 用 seq 回退，不被插入顺序左右',
    why: '同毫秒落位的 live item 必须有确定先后（wire seq），不能被入参顺序左右',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'q1', { timestamp: 1000 }),
          msg('user', 'q2', { timestamp: 2000 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'run-b',
            startedAt: 2000,
            firstSeq: 62,
            items: [{ kind: 'text', text: 'b', key: 'kb', startedAt: 2000 }],
          }),
          group({
            runId: 'run-a',
            startedAt: 2000,
            firstSeq: 61,
            items: [{ kind: 'text', text: 'a', key: 'ka', startedAt: 2000 }],
          }),
        ],
        queued: [],
      });
      return keys(items).join(',') === 'msg:0,msg:1,run:run-a:text:0,run:run-b:text:0';
    },
  },
  {
    name: 'O7（原 F7）缺 timestamp 的历史消息沿用前一条 ts，不沉底',
    why: '历史消息缺 ts 时沿用遍历方向上最近的一条已知 ts（这条规格原先没有实现，msg:1 无 ts 会沉到末尾）；不 carry 就把一轮对话的顺序拉反。前面没有任何已知 ts 时保持 undefined —— carry 不造时间。',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'q1', { timestamp: 1000 }),
          msg('assistant', 'legacy'),
          msg('user', 'q2', { timestamp: 2000 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'run-2', input: 'q2', startedAt: 1900, firstSeq: 71 })],
        queued: [],
      });
      const legacy = items.find((item) => item.kind === 'message' && item.absIndex === 1);
      // 没有前一条可沿用（窗口首条就缺 ts）：保持 undefined——carry 不造时间。
      const headless = buildTranscriptItems({
        messages: [msg('assistant', 'legacy'), msg('user', 'q1', { timestamp: 1000 })],
        messageIndexOffset: 0,
        liveGroups: [],
        queued: [],
      });
      const first = headless.find((item) => item.kind === 'message' && item.absIndex === 0);
      return (
        keys(items).join(',') === 'msg:0,msg:1,msg:2' &&
        legacy !== undefined &&
        legacy.ts === 1000 &&
        first !== undefined &&
        first.ts === undefined
      );
    },
  },
  {
    name: 'O8（原 F8，迁移缺口）vessel:* 上下文消息当前被当作 turn 锚点',
    why: '旧门禁要求模型侧上下文（vessel:*）不参与 turn 锚点；现在最后一条 user 消息的 ts 也算它，running 且无自身 ts 的 run 被拖到它后面（3001）。修掉后把这条翻成 msg:0,run:r1:input,msg:1 且 ts 1001。',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'q1', { timestamp: 1000 }),
          msg('user', '[inbox] 3 unread', { name: 'vessel:notice', timestamp: 3000 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', input: '被改写过的输入' })],
        queued: [],
      });
      const input = items.find((item) => item.kind === 'run-input');
      return (
        keys(items).join(',') === 'msg:0,msg:1,run:r1:input' &&
        input !== undefined &&
        input.ts === 3001
      );
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
