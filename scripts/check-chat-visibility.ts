#!/usr/bin/env bun

/**
 * 会话时间线「可见性」门禁（live 与 history 共用同一判定的机械自检）。
 *
 * 存在的理由：工具卡曾出现「run 运行中不显示、落盘后突然出现」——live 与 history
 * 各写一套规则。现在两边都走 ，
 * 这个脚本用 fixture 把档位语义钉死，并断言「运行中与已终态判定一致」。
 *
 * 用法：bun run scripts/check-chat-visibility.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import {
  eventRowVisible,
  filterTimelineItems,
  historyToolVisible,
  runningToolHint,
  toolVisible,
} from '../apps/web/src/domains/chat/chat-visibility';
import type { ChatRenderItem } from '../apps/web/src/domains/chat/tool-cards';
import type { Verbosity } from '../apps/web/src/state/visibility';

function tool(status: 'running' | 'done' | 'error'): ChatRenderItem {
  return {
    kind: 'tool',
    key: `tool-${status}`,
    name: 'bash',
    status,
    startedAt: 1,
  };
}

function text(value: string): ChatRenderItem {
  return { kind: 'text', text: value, key: 'text-1' };
}

const liveTool = (status: 'running' | 'done' | 'error') => [text('正文'), tool(status)];

interface Fixture {
  name: string;
  why: string;
  /** 实际判定：返回可见项 / 是否可见。 */
  check: () => boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'F1 minimal + live running tool -> 隐藏',
    why: 'minimal 只留失败工具；运行中的工具卡不能因为「还在跑」被特殊对待',
    check: () =>
      !filterTimelineItems(liveTool('running'), { verbosity: 'minimal', running: true }).some(
        (item) => item.kind === 'tool',
      ),
  },
  {
    name: 'F2 minimal + live failed tool -> 显示',
    why: '失败永不静默（minimal 也要留失败工具）',
    check: () =>
      filterTimelineItems(liveTool('error'), { verbosity: 'minimal', running: true }).some(
        (item) => item.kind === 'tool',
      ),
  },
  {
    name: 'F3 minimal + history tool -> 隐藏',
    why: '真 bug：history 曾不查档位直接渲 pre 块，于是 run 落盘后工具卡“突然出现”',
    check: () => !historyToolVisible('done', 'minimal'),
  },
  {
    name: 'F4 normal + live running tool -> 显示',
    why: 'normal 下运行中的工具卡必须实时出现，不能等 run 落盘',
    check: () =>
      filterTimelineItems(liveTool('running'), { verbosity: 'normal', running: true }).some(
        (item) => item.kind === 'tool',
      ),
  },
  {
    name: 'F5 normal + history tool -> 显示',
    why: 'normal 下已落盘的工具消息同样要显示（与 live 一致）',
    check: () => historyToolVisible('done', 'normal'),
  },
  {
    name: 'F6 运行中 vs 终态判定一致（逐档）',
    why: '不变量：同一档位下 running 与 done 的可见性必须相同，否则会“跑的时候藏、跑完冒出来”',
    check: () =>
      (['minimal', 'normal', 'debug'] as Verbosity[]).every(
        (verbosity) => toolVisible('running', verbosity) === toolVisible('done', verbosity),
      ),
  },
  {
    name: 'F7 minimal + 错误事件行 -> 显示',
    why: 'minimal 收紧原始事件行时，错误 / 失败行仍要可见（失败永不静默）',
    check: () =>
      eventRowVisible('run.failed', 'minimal') && eventRowVisible('tool.call.failed', 'minimal'),
  },
  {
    name: 'F9 minimal + 在飞工具 -> 一行状态可见',
    why: 'minimal 隐藏了工具卡，需要一行紧凑状态说明正在跑哪个工具，否则看起来像卡住',
    check: () => {
      const hint = runningToolHint(liveTool('running'), { verbosity: 'minimal', running: true });
      return hint !== undefined && hint.name === 'bash';
    },
  },
  {
    name: 'F10 minimal + 终态成功工具 -> 该行消失',
    why: '工具结束（或 run 结束）后活动行必须消失，不能留一条「运行中」',
    check: () =>
      runningToolHint([tool('done')], { verbosity: 'minimal', running: true }) === undefined &&
      runningToolHint(liveTool('running'), { verbosity: 'minimal', running: false }) === undefined,
  },
  {
    name: 'F11 normal + 在飞工具 -> 不显示活动行',
    why: 'normal 有完整工具卡，再叠一行状态是重复信息',
    check: () =>
      runningToolHint(liveTool('running'), { verbosity: 'normal', running: true }) === undefined,
  },
  {
    name: 'F12 minimal + 失败工具 -> 不出活动行（失败卡本身可见）',
    why: '失败工具已经以卡片形式显示，不该再补一条活动提示',
    check: () =>
      runningToolHint([tool('error')], { verbosity: 'minimal', running: true }) === undefined &&
      filterTimelineItems([tool('error')], { verbosity: 'minimal', running: true }).some(
        (item) => item.kind === 'tool',
      ),
  },
  {
    name: 'F8 minimal + 普通事件行 -> 隐藏',
    why: 'minimal 语义是「只留正文 / 上下文 notice / 失败」，普通事件行不该刷屏',
    check: () => !eventRowVisible('llm.stream.chunk', 'minimal'),
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
    console.log('     why: ' + failure.why);
  }
  console.error(
    'chat visibility: ' + failures.length + '/' + FIXTURES.length + ' fixture(s) FAILED',
  );
  process.exit(1);
}

console.log('chat visibility: ' + FIXTURES.length + ' fixtures passed');
