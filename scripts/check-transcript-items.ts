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

import { ASK_ANSWER_MESSAGE_NAME } from '../apps/web/src/domains/chat/ask-answer';
import { pendingStripView } from '../apps/web/src/domains/chat/pending-strip';
import { ROTATE_HANDOFF_MESSAGE_NAME } from '../apps/web/src/domains/chat/rotate-handoff';
import {
  buildHistoryIndex,
  buildTranscriptItems,
  claimRunFactsOf,
  isCardInputMessage,
  oneShotClaims,
  type TranscriptItem,
} from '../apps/web/src/domains/chat/transcript-items';
import type { RunEvent } from '../apps/web/src/gateway/types';
import type { Message } from '../apps/web/src/gateway/types/sessions';
import type { RunGroup, TimelineItem } from '../apps/web/src/state/events';
import { ASK_ANSWER_INPUT_NAME } from '../packages/agent/src/runtime';
import { ROTATE_HANDOFF_INPUT_NAME } from '../packages/agent/src/service';

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

function textItem(
  text: string,
  key = 'text-0',
  anchorSeq?: number,
  segmentIndex?: number,
): TimelineItem {
  return {
    kind: 'text',
    text,
    key,
    ...(anchorSeq !== undefined ? { anchorSeq } : {}),
    ...(segmentIndex !== undefined ? { segmentIndex } : {}),
  };
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
      });
      const tools = items.filter((item) => item.kind === 'tool');
      return tools.length === 1 && tools[0]?.key === 'tool:c1';
    },
  },
  {
    name: 'F2 同一段正文：流式中 vs flush 后 → 同一个 key（段身份锚定首个 delta 的 seq）',
    why: '尾部未闭合段与 flush 后的同一段共用 anchorSeq 派生的 key，所以流式尾巴不会重挂',
    check: () => {
      const streaming = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', liveText: 'hello', liveTextAnchorSeq: 7 })],
      });
      const flushed = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [
          group({ runId: 'r1', items: [textItem('hello', 'text-r1-0', 7)], status: 'completed' }),
        ],
      });
      const a = streaming.find((item) => item.kind === 'run-text');
      const b = flushed.find((item) => item.kind === 'run-text');
      return a?.key === 'run:r1:text:7' && b?.key === 'run:r1:text:7';
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
      });
      const after = buildTranscriptItems({
        messages,
        messageIndexOffset: 50,
        liveGroups: [],
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
      });
      const messages = items.filter((item) => item.kind === 'message');
      const input = items.some((item) => item.kind === 'run-input');
      return messages.length === 2 && input;
    },
  },
  {
    name: 'F28 消息身份：流式原文 vs 落盘打码（同 run_id + 段序）→ 恰好 1 条正文 item，且以落盘为准',
    why: '根因是「拿正文内容当代理键」：Output guardrail 在落盘前把终稿打码（1794482135404 → 179*******404），流式那份与落盘那份内容不再相等 ⇒ 旧判据认不出同一段 ⇒ live + 历史各渲一份（刷新才消失）。身份（run_id + 段序）命中时内容不同也让位；差异不吞也不喊，记进 rewrittenSegments',
    check: () => {
      const first = '先说结论：同意加，但我先只读一遍。';
      const streamed = 'retired_at = 1794482135404 已经写进交接卡。';
      const masked = 'retired_at = 179*******404 已经写进交接卡。';
      const messages = [
        msg('user', '把这些字段贴进交接卡', { run_id: 'r1' }),
        msg('assistant', first, { run_id: 'r1', run_segment: 0 }),
        msg('assistant', masked, { run_id: 'r1', run_segment: 1 }),
      ];
      const groups = [
        group({
          runId: 'r1',
          status: 'completed',
          input: '把这些字段贴进交接卡',
          output: masked,
          items: [textItem(first, 'text-r1-0', 7, 0), textItem(streamed, 'text-r1-1', 12, 1)],
        }),
      ];
      const items = buildTranscriptItems({ messages, messageIndexOffset: 0, liveGroups: groups });
      // 屏上：三条历史消息（输入 + 两段正文），一条 live 正文都不剩。
      const bodies = items.filter((item) => item.kind === 'message' || item.kind === 'run-text');
      const liveTexts = items.filter((item) => item.kind === 'run-text');
      const last = items.find((item) => item.kind === 'message' && item.absIndex === 2);
      // 留痕：认领统计必须记下「这一段按身份让位、且落盘正文被改写过」。
      const history = buildHistoryIndex(messages, 0);
      const stats = oneShotClaims(history, claimRunFactsOf(groups)).stats;
      return (
        liveTexts.length === 0 &&
        bodies.length === 3 &&
        last !== undefined &&
        last.kind === 'message' &&
        last.message.content === masked &&
        stats.rewrittenSegments === 1 &&
        stats.unclaimedSegments === 0
      );
    },
  },
  {
    name: 'F29 旧数据没有 run_id → 退回内容比较（不删路径、不放松判据）',
    why: '身份是 additive 的：旧会话 / 旧日志没有 run_id 时只能按内容认领 —— 内容相等照旧让位，内容被打码改写就照旧两份（可见、F5 可恢复）。这条 fixture 钉住「新路径没有偷偷放宽旧路径」',
    check: () => {
      const same = '普通答复，逐字相同。';
      const equal = buildTranscriptItems({
        messages: [msg('user', '问'), msg('assistant', same)],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r-old',
            status: 'completed',
            input: '问',
            output: same,
            items: [textItem(same, 'text-r-old-0', 3, 0)],
          }),
        ],
      });
      const equalBodies = equal.filter(
        (item) => item.kind === 'message' || item.kind === 'run-text',
      );
      const streamed = 'retired_at = 1794482135404 已经写进交接卡。';
      const masked = 'retired_at = 179*******404 已经写进交接卡。';
      const rewritten = buildTranscriptItems({
        messages: [msg('user', '贴进来'), msg('assistant', masked)],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r-old',
            status: 'completed',
            input: '贴进来',
            output: masked,
            items: [textItem(streamed, 'text-r-old-0', 5, 0)],
          }),
        ],
      });
      const rewrittenBodies = rewritten.filter(
        (item) => item.kind === 'message' || item.kind === 'run-text',
      );
      // 内容相等 ⇒ 正文只出 1 份（内容认领照旧）；被改写 ⇒ 正文 2 份
      // （旧数据没有身份时的已知降级，行为与改动前完全一致）。
      return equalBodies.length === 2 && rewrittenBodies.length === 3;
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
      });
      const historyOnly = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
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
      });
      const historyOnly = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
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
      });
      const historyOnly = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
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
        noticeKindOf: (message) => (message.name === 'vessel:notice' ? 'notice' : undefined),
      });
      const hidden = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
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
    name: 'F-P1 prompt.system_context → 一张 prompt-context 卡（不是原始 notice 行）',
    why: '「模型这一轮看到了什么系统消息」必须是可折叠的专用卡：退回 notice 行等于把原文塞进原始载荷里',
    check: () => {
      const items = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r1',
            items: [
              {
                kind: 'event',
                key: 'ev-7',
                anchorSeq: 7,
                event: {
                  type: 'prompt.system_context',
                  run_id: 'r1',
                  ts: 1500,
                  data: {
                    hash: 'deadbeefdeadbeef',
                    system_prompt: 'BASE SYSTEM',
                    self_card: '[Self Card]\nrole: r1',
                    model: 'test-model',
                    message_count: 3,
                    tools_count: 2,
                    estimated_tokens: 1200,
                  },
                },
              },
            ],
          }),
        ],
      });
      const cards = items.filter((item) => item.kind === 'prompt-context');
      const card = cards[0];
      return (
        cards.length === 1 &&
        card !== undefined &&
        // key 锚事件 seq（回放重放同一事件不换 key，卡片不重挂）。
        card.key === 'prompt:ev-7' &&
        card.runId === 'r1' &&
        card.hash === 'deadbeefdeadbeef' &&
        card.systemPrompt === 'BASE SYSTEM' &&
        card.selfCard?.includes('Self Card') === true &&
        card.messageCount === 3 &&
        card.toolsCount === 2 &&
        card.estimatedTokens === 1200 &&
        // 不得同时落一条普通 notice 行（同一事件两条就是双出）。
        count(items, 'notice') === 0
      );
    },
  },
  {
    name: 'F-P2 prompt.system_context 载荷不成形 → 退回 notice 行（不吞事件）',
    why: '旧日志 / 第三方改写的载荷没有 hash 或没有原文：宁可少一张卡，也不吞掉事件、更不猜内容',
    check: () => {
      const items = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r1',
            items: [
              {
                kind: 'event',
                key: 'ev-8',
                event: {
                  type: 'prompt.system_context',
                  run_id: 'r1',
                  ts: 1600,
                  data: { run_id: 'r1' },
                },
              },
            ],
          }),
        ],
      });
      return count(items, 'prompt-context') === 0 && count(items, 'notice') === 1;
    },
  },
  {
    name: 'F-P3 事件流 + sessions.get 两路都在（同 hash）→ 只出一张卡',
    why: '刷新后 detail 派生会补一张；事件流里同一份系统消息还在时再补一张就是双出（hash 是同一份的身份）',
    check: () => {
      const event: RunEvent = {
        type: 'prompt.system_context',
        run_id: 'r1',
        ts: 1500,
        data: {
          hash: 'deadbeefdeadbeef',
          system_prompt: 'BASE SYSTEM',
          self_card: '[Self Card]\nrole: r1',
        },
      } as RunEvent;
      const liveGroups = [
        group({
          runId: 'r1',
          items: [{ kind: 'event', key: 'ev-7', event }],
        }),
      ];
      // 同一份（同 hash）从 detail 再补一次：必须被去重掉。
      const both = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups,
        sessionSystemContext: {
          hash: 'deadbeefdeadbeef',
          systemPrompt: 'BASE SYSTEM',
          selfCard: '[Self Card]\nrole: r1',
        },
      });
      // 只有 detail（事件回放窗口里已经没有它了，例如进程重启后）→ 补出**同一张卡**。
      const detailOnly = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups: [],
        sessionSystemContext: {
          hash: 'deadbeefdeadbeef',
          systemPrompt: 'BASE SYSTEM',
          selfCard: '[Self Card]\nrole: r1',
          runId: 'r1',
          at: 1500,
        },
      });
      const detailCard = detailOnly.find((item) => item.kind === 'prompt-context');
      // 不同 hash（配置热应用后换过一份）→ 两路各自成立，两张卡都要在。
      const different = buildTranscriptItems({
        messages: [],
        messageIndexOffset: 0,
        liveGroups,
        sessionSystemContext: { hash: 'ffffffffffffffff', selfCard: 'NEW CARD' },
      });
      return (
        count(both, 'prompt-context') === 1 &&
        both[0]?.key === 'prompt:ev-7' &&
        count(detailOnly, 'prompt-context') === 1 &&
        detailCard?.key === 'prompt:session:deadbeefdeadbeef' &&
        detailCard.runId === 'r1' &&
        detailCard.ts === 1500 &&
        count(different, 'prompt-context') === 2
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
        isHidden: (message) => message.name === 'vessel:source',
      });
      const visible = buildTranscriptItems({
        messages,
        messageIndexOffset: 0,
        liveGroups: [],
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
        messages: [msg('user', 'q1', { timestamp: 1000 }), msg('user', 'q2', { timestamp: 2000 })],
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
      });
      const legacy = items.find((item) => item.kind === 'message' && item.absIndex === 1);
      // 没有前一条可沿用（窗口首条就缺 ts）：保持 undefined——carry 不造时间。
      const headless = buildTranscriptItems({
        messages: [msg('assistant', 'legacy'), msg('user', 'q1', { timestamp: 1000 })],
        messageIndexOffset: 0,
        liveGroups: [],
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
    name: 'O8（原 F8）vessel:* 上下文消息不当 turn 锚点',
    why: 'turn 锚点只认人说的最后一句的 ts；runtime 上下文（vessel:*）也是 role user 但不参与。算进去会把「运行中且自己没有 ts」的 run 拖到上下文消息之后（3001），实际输入在它之前（1001）。',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          msg('user', 'q1', { timestamp: 1000 }),
          msg('user', '[inbox] 3 unread', { name: 'vessel:notice', timestamp: 3000 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', input: '被改写过的输入' })],
      });
      const input = items.find((item) => item.kind === 'run-input');
      // 反向断言：普通用户消息仍然是锚点（只排除 vessel:*，不是「不再用最后一条用户消息」）。
      const plain = buildTranscriptItems({
        messages: [msg('user', 'q1', { timestamp: 1000 }), msg('user', 'q2', { timestamp: 3000 })],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r1', input: '被改写过的输入' })],
      });
      const plainInput = plain.find((item) => item.kind === 'run-input');
      return (
        keys(items).join(',') === 'msg:0,run:r1:input,msg:1' &&
        input !== undefined &&
        input.ts === 1001 &&
        plainInput !== undefined &&
        plainInput.ts === 3001
      );
    },
  },
  // --- 0.52 失败卡（run-error-visible） ---
  {
    name: 'F23 待批答复（async ask）身份：历史名 ask:answer → 一张卡；运行态同名输入被认领后让位；解析失败回退普通消息',
    why: '答案必须是 user 消息（协议要求），但人是在待批页回答的：渲成用户气泡会让人以为是自己刚发的。身份只认 name=ask:answer；解析不出必须回退（宁可少一张卡，不能吞正文）；live 与 history 必须是同一个逻辑对象（不许一卡一气泡）',
    check: () => {
      const answer =
        '[ask_user answer req-1] Answers from the human to your pending ask_user request:\n' +
        '1. Scope: stay on the safe subset';
      // (a) 历史侧：名字 + 可解析正文 ⇒ 一张 ask-answer 卡（不再出用户消息 item）。
      const history = buildTranscriptItems({
        messages: [msg('user', answer, { name: ASK_ANSWER_MESSAGE_NAME, timestamp: 2000 })],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const card = history.find((item) => item.kind === 'ask-answer');
      // (b) 运行态与历史同一对象：run 分组的 input_name 也是 ask:answer ⇒ live 那条被认领让位。
      const live = buildTranscriptItems({
        messages: [msg('user', answer, { name: ASK_ANSWER_MESSAGE_NAME, timestamp: 2000 })],
        messageIndexOffset: 0,
        liveGroups: [
          group({
            runId: 'r-ask',
            input: answer,
            inputName: ASK_ANSWER_MESSAGE_NAME,
            startedAt: 1990,
          }),
        ],
      });
      // (c) 名字对但正文不可解析 ⇒ 退回普通用户消息（正文不许被吞）。
      const fallback = buildTranscriptItems({
        messages: [
          msg('user', 'just some text', { name: ASK_ANSWER_MESSAGE_NAME, timestamp: 2000 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const fallbackMessage = fallback.find((item) => item.kind === 'message');
      return (
        card !== undefined &&
        card.kind === 'ask-answer' &&
        card.card.requestId === 'req-1' &&
        card.card.rows.length === 1 &&
        card.card.summary === 'Scope' &&
        history.every((item) => item.kind !== 'message' || item.message.role !== 'user') &&
        keys(live).join(',') === 'msg:0' &&
        live.filter((item) => item.kind === 'ask-answer').length === 1 &&
        fallbackMessage !== undefined &&
        fallbackMessage.kind === 'message' &&
        fallbackMessage.message.content === 'just some text'
      );
    },
  },
  {
    name: 'F24 待批答复的字面量对账：Web 身份名与 agent 侧 Message.name 必须一致',
    why: '两侧各写一个字面量（web 不能 import packages/agent），漂移会让卡片静默退回用户气泡 —— 没有报错，只有观感错',
    check: () => ASK_ANSWER_MESSAGE_NAME === ASK_ANSWER_INPUT_NAME,
  },
  // --- rotate 交接卡（rotate-handoff） ---
  {
    name: 'F25 rotate 交接身份：历史名 rotate:handoff:<epoch> → 一张交接卡；运行态同名输入被认领后让位；名字不合形状回退普通消息',
    why: '交接嘱托是发起 rotate 的 agent 写的（不是坐在键盘前的人打的字），渲成用户气泡会让人以为是自己刚发的；epoch 只能随 name 持久化，读不懂就不写（不猜）；live 与 history 必须是同一个逻辑对象（不许一卡一气泡），名字不合形状时必须回退（宁可少一张卡，不能吞正文）',
    check: () => {
      const brief = '你是 rotate 后的第三具身体：先读交接书，再把扫尾做完。';
      const named = `${ROTATE_HANDOFF_MESSAGE_NAME}:3`;
      // (a) 历史侧：名字 + epoch ⇒ 一张交接卡（不再出用户消息 item）。
      const history = buildTranscriptItems({
        messages: [msg('user', brief, { name: named, timestamp: 2000 })],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const card = history.find((item) => item.kind === 'rotate-handoff');
      // (b) 运行态与历史同一对象：run 分组的 input_name 同名 ⇒ live 那条被认领让位。
      const live = buildTranscriptItems({
        messages: [msg('user', brief, { name: named, timestamp: 2000 })],
        messageIndexOffset: 0,
        liveGroups: [group({ runId: 'r-rot', input: brief, inputName: named, startedAt: 1990 })],
      });
      // (c) 名字没带 epoch（旧数据 / 直接 `rotate:handoff`）⇒ 卡片在，epoch 缺省。
      const bare = buildTranscriptItems({
        messages: [msg('user', brief, { name: ROTATE_HANDOFF_MESSAGE_NAME, timestamp: 2000 })],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const bareCard = bare.find((item) => item.kind === 'rotate-handoff');
      // (d) 名字不合形状（第三段不是数字 / 前缀后缀粘连）⇒ 退回普通消息，正文不许被吞。
      const fallback = buildTranscriptItems({
        messages: [
          msg('user', brief, { name: `${ROTATE_HANDOFF_MESSAGE_NAME}x`, timestamp: 2000 }),
        ],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const fallbackMessage = fallback.find((item) => item.kind === 'message');
      return (
        card !== undefined &&
        card.kind === 'rotate-handoff' &&
        card.epoch === 3 &&
        card.text === brief &&
        history.every((item) => item.kind !== 'message' || item.message.role !== 'user') &&
        keys(live).join(',') === 'msg:0' &&
        live.filter((item) => item.kind === 'rotate-handoff').length === 1 &&
        bareCard !== undefined &&
        bareCard.kind === 'rotate-handoff' &&
        bareCard.epoch === undefined &&
        fallbackMessage !== undefined &&
        fallbackMessage.kind === 'message' &&
        fallbackMessage.message.content === brief
      );
    },
  },
  {
    name: 'F26 rotate 交接的字面量对账：Web 身份前缀与 agent 侧 ROTATE_HANDOFF_INPUT_NAME 必须一致',
    why: '两侧各写一个字面量（web 不能 import packages/agent），漂移会让交接卡静默退回用户气泡 —— 没有报错，只有观感错',
    check: () => ROTATE_HANDOFF_MESSAGE_NAME === ROTATE_HANDOFF_INPUT_NAME,
  },
  {
    name: 'F27 卡片输入不是「前一条用户输入」：A2A / rotate 交接不做 edit-retry 锚点；回退成普通消息的名字仍算人输入',
    why: '交接卡不是人打的字：能被编辑成别的内容或被重发，等于把伪造的改写伪装成一段真实发生的交接。判定必须与建 item 同一组函数（否则出现「渲成卡、却仍当人的话重发」）；名字不合形状时它本来就渲成气泡，操作也该跟气泡一致',
    check: () => {
      const brief = '你是 rotate 后的第三具身体：先读交接书，再把扫尾做完。';
      const a2a = msg('user', 'agent 说的话', { name: 'agent:helper' });
      const handoff = msg('user', brief, { name: `${ROTATE_HANDOFF_MESSAGE_NAME}:3` });
      const human = msg('user', '人打的字');
      const fallbackName = msg('user', brief, { name: `${ROTATE_HANDOFF_MESSAGE_NAME}x` });
      // 反向断言：判定与渲成什么一致（交接卡 ↔ 卡；普通消息 ↔ 人输入）。
      const handoffKinds = buildTranscriptItems({
        messages: [handoff],
        messageIndexOffset: 0,
        liveGroups: [],
      }).map((item) => item.kind);
      const humanKinds = buildTranscriptItems({
        messages: [human],
        messageIndexOffset: 0,
        liveGroups: [],
      }).map((item) => item.kind);
      return (
        isCardInputMessage(a2a) &&
        isCardInputMessage(handoff) &&
        !isCardInputMessage(human) &&
        !isCardInputMessage(fallbackName) &&
        handoffKinds.join(',') === 'rotate-handoff' &&
        humanKinds.join(',') === 'message'
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
