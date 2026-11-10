#!/usr/bin/env bun

/**
 * 历史工具配对门禁（buildHistoryToolItems 的机械判定）。
 *
 * 历史里没有事件流的 status / duration：assistant 的 tool_calls[] 与 role:'tool'
 * 消息靠 tool_call_id 配对成卡片。最怕的是「有调用、无结果」渲染成空白，所以
 * fixture 里专门钉死退化路径。
 *
 * 用法：bun run scripts/check-history-tools.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import {
  buildHistoryToolItems,
  type HistoryToolItem,
} from '../apps/web/src/domains/chat/history-tools';
import type { Message } from '../apps/web/src/gateway/types/sessions';

function assistantCalls(calls: { id: string; name: string; args: string }[]): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    })),
  };
}

function toolResult(callId: string, content: string, name?: string): Message {
  return { role: 'tool', content, tool_call_id: callId, ...(name !== undefined ? { name } : {}) };
}

interface Fixture {
  name: string;
  why: string;
  messages: Message[];
  check: (items: HistoryToolItem[]) => boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'F1 正常配对：调用 + 对应结果',
    why: '最常见路径，一个调用必须产出一条 paired item 且带 output',
    messages: [
      assistantCalls([{ id: 'c1', name: 'bash', args: '{"command":"tsc"}' }]),
      toolResult('c1', 'ok'),
    ],
    check: (items) =>
      items.length === 1 &&
      items[0]?.callId === 'c1' &&
      items[0]?.name === 'bash' &&
      items[0]?.paired === true &&
      items[0]?.output === 'ok',
  },
  {
    name: 'F2 结果缺失：卡片不能空白',
    why: '历史被截断时只有调用没有结果；必须产出一条 paired:false + output:undefined 的 item（渲染层显示 outputMissing）',
    messages: [assistantCalls([{ id: 'c2', name: 'read', args: '{"path":"a.ts"}' }])],
    check: (items) =>
      items.length === 1 &&
      items[0]?.paired === false &&
      items[0]?.output === undefined &&
      items[0]?.name === 'read',
  },
  {
    name: 'F3 同轮多调用：按出现顺序各成一条',
    why: '一个 assistant 消息带多个 tool_calls，不能合并成一张卡',
    messages: [
      assistantCalls([
        { id: 'c3', name: 'bash', args: '{}' },
        { id: 'c4', name: 'edit', args: '{}' },
      ]),
      toolResult('c3', 'one'),
      toolResult('c4', 'two'),
    ],
    check: (items) =>
      items.length === 2 &&
      items[0]?.name === 'bash' &&
      items[0]?.output === 'one' &&
      items[1]?.name === 'edit' &&
      items[1]?.output === 'two' &&
      items.every((item) => item.paired),
  },
  {
    name: 'F4 args 为 JSON 字符串：原样保留给渲染层解析',
    why: '纯函数不做解析（渲染层用 parseToolArgs），原始字符串必须一字不差地留下',
    messages: [
      assistantCalls([{ id: 'c5', name: 'bash', args: '{"command":"ls -la"}' }]),
      toolResult('c5', ['a', 'b'].join(String.fromCharCode(10))),
    ],
    check: (items) => items[0]?.args === '{"command":"ls -la"}',
  },
  {
    name: 'F5 未知工具名：如实显示，不吞掉',
    why: '插件工具名不在 catalog 里，也不能因此丢卡或改名',
    messages: [
      assistantCalls([{ id: 'c6', name: 'weird_plugin_tool', args: '{}' }]),
      toolResult('c6', 'done'),
    ],
    check: (items) => items.length === 1 && items[0]?.name === 'weird_plugin_tool',
  },
  {
    name: 'F6 孤立结果（无对应调用）：保留输出',
    why: '历史从中间开始时只有 tool 消息；不能因为配不上调用就丢掉输出',
    messages: [{ role: 'user', content: 'hi' }, toolResult('c-unknown', 'orphan output', 'bash')],
    check: (items) =>
      items.length === 1 &&
      items[0]?.paired === false &&
      items[0]?.output === 'orphan output' &&
      items[0]?.name === 'bash',
  },
];

const failures: { name: string; why: string; items: HistoryToolItem[] }[] = [];
for (const fixture of FIXTURES) {
  const items = buildHistoryToolItems(fixture.messages);
  let ok = false;
  try {
    ok = fixture.check(items);
  } catch {
    ok = false;
  }
  if (!ok) failures.push({ name: fixture.name, why: fixture.why, items });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`FAIL ${failure.name}`);
    console.log(`     why:   ${failure.why}`);
    console.log(`     items: ${JSON.stringify(failure.items)}`);
  }
  console.error(`history tools: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`history tools: ${FIXTURES.length} fixtures passed`);
