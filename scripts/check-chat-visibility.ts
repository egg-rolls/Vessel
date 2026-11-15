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
import {
  defaultProjectionTab,
  hasProjectionPanes,
  modelViewTextOf,
  projectedOriginalText,
  projectionBadgeOf,
  projectionMetaFieldsOf,
  readbackActionKeyOf,
  readbackOriginalOf,
  readbackOutcomeOf,
  readbackRequestOf,
  savedBytesOf,
  showsOutputSection,
  summaryLowerBoundCount,
  TRUNCATION_LIMIT_FALLBACK_BYTES,
  truncationLimitLabel,
} from '../apps/web/src/domains/chat/projection';
import type { ChatRenderItem } from '../apps/web/src/domains/chat/tool-cards';
import { toolSummary, valueText } from '../apps/web/src/domains/chat/tool-cards';
import type { TranscriptItem } from '../apps/web/src/domains/chat/transcript-items';
import { buildTranscriptItems } from '../apps/web/src/domains/chat/transcript-items';
import type {
  Message,
  ProjectionSummary,
  ProjectionView,
} from '../apps/web/src/gateway/types/sessions';
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

// ─────────────────────────── 0.54 投影卡 fixture ───────────────────────────

/** 一条投影（缺省是「正文就是原文」的 placeholder）：只补测试关心的字段。 */
function projection(overrides: Partial<ProjectionView> & { tool_call_id: string }): ProjectionView {
  return {
    mode: 'placeholder',
    placeholder_text: `[cleared bash: pnpm build -> exit 1, 3 lines]`,
    placeholder_hash: 'hash-0',
    original_bytes: 2048,
    original_lines: 3,
    original_available: 'inline',
    declaration_id: null,
    ...overrides,
  };
}

/** 一条 assistant 的 tool_calls（历史里调用与结果靠 `tool_call_id` 配对）。 */
function assistantCalls(calls: readonly { id: string; name?: string }[]): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name ?? 'bash', arguments: '{"command":"x"}' },
    })),
  };
}

/** 一条工具结果消息（可带投影）。 */
function toolMessage(toolCallId: string, content: string, view?: ProjectionView): Message {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content,
    ...(view !== undefined ? { projection: view } : {}),
  };
}

/** 从 item 流里按 `tool_call_id` 取那张卡（`undefined` = 没这张卡）。 */
function toolCard(items: readonly TranscriptItem[], callId: string) {
  return items.find(
    (item): item is Extract<TranscriptItem, { kind: 'tool' }> =>
      item.kind === 'tool' && item.callId === callId,
  );
}

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
  // ───────────────── 0.54 投影卡（spec §7.1 第 4 条要求同步 fixture） ─────────────────
  {
    name: 'F13 投影按 tool_call_id 合并（结果消息与调用顺序不一致也对得上）',
    why:
      '窗口可能从 assistant 中间切起：按下标对齐会把 A 卡的占位挂到 B 卡上。' +
      '这里故意让「消息顺序」与「调用顺序」相反，只有按 id 合并才全对',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          assistantCalls([{ id: 'call_a' }, { id: 'call_b' }]),
          // 倒序回结果：第 1 条工具消息属于 call_b，第 2 条属于 call_a。
          toolMessage(
            'call_b',
            'B 的原文',
            projection({ tool_call_id: 'call_b', placeholder_text: '[cleared b]' }),
          ),
          toolMessage(
            'call_a',
            'A 的原文',
            projection({ tool_call_id: 'call_a', placeholder_text: '[cleared a]' }),
          ),
        ],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const a = toolCard(items, 'call_a');
      const b = toolCard(items, 'call_b');
      if (a?.projection === undefined || b?.projection === undefined) return false;
      // 两张卡各拿自己的那份：错位时这里必然交叉。
      if (a.projection.placeholder_text !== '[cleared a]') return false;
      if (b.projection.placeholder_text !== '[cleared b]') return false;
      // 反证（按下标对齐会得到什么）：投影属于 call_b，而卡片按调用顺序先是 call_a。
      const byIndex = items.filter((item) => item.kind === 'tool');
      return (
        byIndex[0]?.kind === 'tool' &&
        byIndex[0].callId === 'call_a' &&
        byIndex[1]?.kind === 'tool' &&
        byIndex[1].callId === 'call_b'
      );
    },
  },
  {
    name: 'F14 投影不借给邻居（同批结果里只有一条被投影，另一条必须空着）',
    why:
      '窗口切掉 owning assistant 时最容易按下标对齐：一借就是「B 的占位挂在 A 的卡上」。' +
      '这里 call_a 没有投影、call_b 有，且两条结果消息的先后与调用顺序相反 —— 只有按 id 合并才都正确',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          assistantCalls([{ id: 'call_a' }, { id: 'call_b' }]),
          toolMessage(
            'call_b',
            'B 的原文',
            projection({
              tool_call_id: 'call_b',
              placeholder_text: '[cleared b]',
            }),
          ),
          toolMessage('call_a', 'A 的原文'),
        ],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const a = toolCard(items, 'call_a');
      const b = toolCard(items, 'call_b');
      return (
        a?.projection === undefined &&
        b?.projection?.tool_call_id === 'call_b' &&
        b.projection.placeholder_text === '[cleared b]' &&
        // 两张卡都还在（没被投影不该改变可见性）。
        items.filter((item) => item.kind === 'tool').length === 2
      );
    },
  },
  {
    name: 'F14b 窗口首条就是被投影的工具结果（owning assistant 在窗口外）→ 卡和投影都在',
    why:
      '满投影落盘后这就是**主路径**：窗口从 assistant 中间切起，首条是工具结果。' +
      '这条卡要是丢，badge 与读回连入口都没有 —— 投影卡等于不存在',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          toolMessage(
            'call_x',
            '[cleared bash: x]',
            projection({
              tool_call_id: 'call_x',
              placeholder_text: '[cleared bash: x]',
              original_available: 'readback',
              original_bytes: null,
              readback: { kind: 'events', tool_call_id: 'call_x', since_seq: 0 },
            }),
          ),
          { role: 'user', content: '接着说' },
        ],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const orphan = toolCard(items, 'call_x');
      // 孤立卡片带着自己的投影，且默认落模型视角（原文只在事件日志里）。
      return (
        orphan?.projection?.tool_call_id === 'call_x' &&
        orphan.projection.original_available === 'readback' &&
        defaultProjectionTab(orphan.projection) === 'model' &&
        orphan.output === '[cleared bash: x]'
      );
    },
  },
  {
    name: 'F15 占位条目的 badge 与默认视角（badge 按 mode 出，默认视角按原文在哪）',
    why:
      'badge 决定「用户能不能一眼看出模型看到的不是这份」；默认视角是用户 2026-11-15 拍板的 A：' +
      '原文在正文里就展开原文，原文只在日志 / 不可恢复时才落模型视角（否则默认给空面板）',
    check: () => {
      const inline = projection({ tool_call_id: 'c1' });
      const truncated = projection({ tool_call_id: 'c2', original_available: 'inline_truncated' });
      const readback = projection({
        tool_call_id: 'c3',
        original_available: 'readback',
        original_bytes: null,
        readback: { kind: 'events', tool_call_id: 'c3', since_seq: 0 },
      });
      const gone = projection({
        tool_call_id: 'c4',
        original_available: 'gone',
        original_bytes: null,
      });
      const externalize = projection({ tool_call_id: 'c5', mode: 'externalize' });
      const badge = (view: ProjectionView) => projectionBadgeOf(view);
      return (
        // badge：placeholder / externalize 出，passthrough / archive_notice 不出（ADR-104 §8.5）。
        badge(inline)?.labelKey === 'chat.projection.badge.placeholder' &&
        badge(readback)?.labelKey === 'chat.projection.badge.placeholder' &&
        badge(gone)?.labelKey === 'chat.projection.badge.placeholder' &&
        badge(externalize)?.labelKey === 'chat.projection.badge.externalize' &&
        badge({ ...inline, mode: 'passthrough' }) === null &&
        badge({ ...inline, mode: 'archive_notice' }) === null &&
        // danger 只给「原文不可恢复」，普通占位不许染红。
        badge(gone)?.danger === true &&
        badge(inline)?.danger === false &&
        // readback / gone 的 badge 要能解释「为什么默认落在模型视角」。
        badge(readback)?.reasonKey !== undefined &&
        badge(inline)?.reasonKey === undefined &&
        // 默认视角（拍板 A）。
        defaultProjectionTab(inline) === 'original' &&
        defaultProjectionTab(truncated) === 'original' &&
        defaultProjectionTab(readback) === 'model' &&
        defaultProjectionTab(gone) === 'model' &&
        // 没有「两层」可看的投影不画切换器。
        hasProjectionPanes(inline) &&
        hasProjectionPanes(externalize) &&
        !hasProjectionPanes({ ...inline, mode: 'passthrough' }) &&
        !hasProjectionPanes({ ...inline, mode: 'archive_notice' })
      );
    },
  },
  {
    name: 'F16 模型视角逐字（placeholder_text 不许 trim / 补空格 / 本地化）',
    why:
      '这个字段是「模型真正看到的那一字节」：卡的全部价值在于用户复制到的东西 === 模型看到的输入。' +
      '任何展示层的加工都会让两者不再相等（占位本身超 8 KiB 时尾部还会被裁）',
    check: () => {
      const verbatim = '[cleared bash:  pnpm  build->exit 1, 3 lines] ';
      const view = projection({ tool_call_id: 'c', placeholder_text: verbatim });
      return (
        modelViewTextOf(view) === verbatim &&
        // 首尾空白 / 中间双空格原样保留。
        modelViewTextOf(view).startsWith('[cleared ') &&
        modelViewTextOf(view).endsWith('] ') &&
        modelViewTextOf(view) === view.placeholder_text
      );
    },
  },
  {
    name: 'F17 readback 读回为空 -> 降级成 gone 文案（不弹错、不错挂别的 id）',
    why:
      '`original_available:"readback"` 只是「请求可得」，读回可能变死链（spec §6.5）。' +
      '此时必须明确降级成「原文已不可恢复」，而不是空面板 / 错误框；也不许把别条调用的结果张冠李戴',
    check: () => {
      const empty = readbackOutcomeOf(readbackOriginalOf([], 'call_a'));
      return (
        // 读回为空 ⇒ gone 文案（这条是「降级」，不是「读了但为空」）。
        empty.kind === 'gone' &&
        empty.labelKey === 'chat.projection.gone' &&
        // 空串同理（0 字节的原文等于没有内容）。
        readbackOutcomeOf('').kind === 'gone' &&
        // 正控：读到了就展示，且只取这条调用自己的结果。
        readbackOriginalOf(
          [{ type: 'tool.call.completed', data: { tool_call_id: 'call_a', result: '原文' } }],
          'call_a',
        ) === '原文' &&
        readbackOriginalOf(
          [{ type: 'tool.call.completed', data: { tool_call_id: 'call_b', result: '别人的' } }],
          'call_a',
        ) === undefined &&
        // 失败调用的原文在 error 里，completed 优先。
        readbackOriginalOf(
          [
            { type: 'tool.call.failed', data: { tool_call_id: 'call_a', error: 'boom' } },
            { type: 'tool.call.completed', data: { tool_call_id: 'call_a', result: 'ok' } },
          ],
          'call_a',
        ) === 'ok' &&
        // 读回参数：readback 用 wire 句柄；inline_truncated 没有句柄但同一个口径读全文；
        // inline（本来就是全文）与 gone（不可恢复）不给按钮。
        readbackRequestOf(
          projection({
            tool_call_id: 'c3',
            original_available: 'readback',
            readback: { kind: 'events', tool_call_id: 'c3', since_seq: 0 },
          }),
        )?.toolCallId === 'c3' &&
        readbackRequestOf(
          projection({ tool_call_id: 'c2', original_available: 'inline_truncated' }),
        )?.sinceSeq === 0 &&
        readbackRequestOf(projection({ tool_call_id: 'c1' })) === undefined &&
        readbackRequestOf(
          projection({ tool_call_id: 'c4', original_available: 'gone', original_bytes: null }),
        ) === undefined &&
        // file / handle 句柄的读回没接线：不猜来源、不给按钮。
        readbackRequestOf(
          projection({
            tool_call_id: 'c6',
            mode: 'externalize',
            original_available: 'readback',
            readback: { kind: 'handle', handle_id: 'h1' },
          }),
        ) === undefined
      );
    },
  },
  {
    name: 'F18 汇总数字口径：净值 clamp 到 ≥0 + 未知体量说成下界',
    why:
      '`bytes_saved` 是净值、可为负（实测 -6 B），展示层不 clamp 就会显示「省了 -6 B」；' +
      '`unknown_original_count > 0` 时它只是下界，不写明就等于把下界当总数',
    check: () => {
      const base: ProjectionSummary = {
        total: 3,
        bytes_saved: 1024,
        modes: { placeholder: 3 },
        unknown_original_count: 0,
      };
      return (
        savedBytesOf(base) === 1024 &&
        // 负数 clamp 到 0（真值口径不变，只是不显示负数）。
        savedBytesOf({ ...base, bytes_saved: -6 }) === 0 &&
        // 有未知体量的条数时必须能算出「下界提示」，没有时不加这句话。
        summaryLowerBoundCount({ ...base, unknown_original_count: 3 }) === 3 &&
        summaryLowerBoundCount(base) === 0
      );
    },
  },
  {
    name: 'F19 输出分区让位给投影面板 ⇒ 不丢信息（逐字 / 复制是原文 / exit code 还在）',
    why:
      '有投影时不再渲染「输出」分区，这是对既有卡片的行为改动。' +
      '必须能证明接管≠丢失：原文面板拿到的是**逐字**的正文（含首尾空白与空行），' +
      '复制出去的就是它，exit code 这类数字没被吞，参数区与工具名也照旧由卡片自己管',
    check: () => {
      const view = projection({ tool_call_id: 'c-inline' });
      // 首行缩进 + 行尾空格 + 空行 + 末尾换行：任何 trim / 重排都会让它变。
      const result = '  exit code 1\n\n第二行尾部有空格   \n';
      const original = projectedOriginalText(view, result);
      const readbackView = projection({
        tool_call_id: 'c-readback',
        original_available: 'readback',
        original_bytes: null,
        readback: { kind: 'events', tool_call_id: 'c-readback', since_seq: 0 },
      });
      return (
        // ① 逐字相等：面板里的正文 === 原「输出」分区本来会显示的正文。
        original === result &&
        valueText(original) === result &&
        // 输出分区确实让位了（没投影时仍然照常渲染）。
        showsOutputSection(view) === false &&
        showsOutputSection(undefined) === true &&
        // ② 复制出去的是**原文**：不是占位、也不是截断版。
        modelViewTextOf(view) !== original &&
        original.includes('exit code 1') &&
        original.endsWith('\n') &&
        // readback 态绝不能把占位当原文端出来（那边没有「原文」可复制）。
        projectedOriginalText(readbackView, '[cleared bash: x]') === undefined &&
        // ③ 工具名 / 参数不归投影管：调用摘要照样算得出来（没被一起吞掉）。
        toolSummary('bash', { command: 'bun run gates' }).includes('bun run gates')
      );
    },
  },
  {
    name: 'F20 「已截到前 N」的 N 来自 wire（truncated.content.limit），不是常量',
    why:
      '这个数字用户会当事实读：服务端把上限从 8 KiB 调到 4 KiB 时界面必须跟着变。' +
      '常量只是 wire 没给时的兜底，且 KiB/字节的换算不许编造小数',
    check: () => {
      const items = buildTranscriptItems({
        messages: [
          assistantCalls([{ id: 'call_t' }]),
          {
            // 上限故意设成 4096：与兜底常量（8 KiB）不同，才验得出「用的是 wire」。
            ...toolMessage(
              'call_t',
              '前半段... [truncated]',
              projection({
                tool_call_id: 'call_t',
                original_available: 'inline_truncated',
                original_bytes: 9000,
              }),
            ),
            truncated: { content: { bytes: 9000, limit: 4096, marker: '... [truncated]' } },
          },
        ],
        messageIndexOffset: 0,
        liveGroups: [],
      });
      const card = toolCard(items, 'call_t');
      return (
        card?.truncatedLimitBytes === 4096 &&
        truncationLimitLabel(4096) === '4 KiB' &&
        truncationLimitLabel(TRUNCATION_LIMIT_FALLBACK_BYTES) === '8 KiB' &&
        // 不是整 KiB 就退回字节数，不四舍五入成假精度。
        truncationLimitLabel(8000) === '8000 B'
      );
    },
  },
  {
    name: 'F21 两处读回文案必须区分（取回尾巴 vs 取回占位之前的原文）',
    why:
      '`inline_truncated` 的读回是取回被上限截掉的**尾巴**（前半段已在卡上）；' +
      '`readback` 的读回是取回**占位之前的原文**。共用一句会让人以为要做同一件事',
    check: () => {
      const truncated = projection({
        tool_call_id: 'c-tail',
        original_available: 'inline_truncated',
        original_bytes: 9000,
      });
      const readback = projection({
        tool_call_id: 'c-ph',
        original_available: 'readback',
        original_bytes: null,
        readback: { kind: 'events', tool_call_id: 'c-ph', since_seq: 0 },
      });
      const gone = projection({
        tool_call_id: 'c-gone',
        original_available: 'gone',
        original_bytes: null,
      });
      return (
        readbackActionKeyOf(truncated) === 'chat.projection.readbackTail' &&
        readbackActionKeyOf(readback) === 'chat.projection.readbackFromLog' &&
        readbackActionKeyOf(truncated) !== readbackActionKeyOf(readback) &&
        // 全文本来就在卡上（inline）/ 不可恢复（gone）：没有按钮。
        readbackActionKeyOf(projection({ tool_call_id: 'c-inline' })) === undefined &&
        readbackActionKeyOf(gone) === undefined
      );
    },
  },
  {
    name: 'F22 元信息：since_event_seq 缺省时那一行根本不出现',
    why:
      '服务端本轮两个分支都不写它（缺省 = 不知道，绝不写 0 冒充）。永远显示「发生 seq: 未知」' +
      '只是一行噪音，用户还会以为这个会话的记录有问题',
    check: () => {
      const withoutSeq = projectionMetaFieldsOf(
        projection({ tool_call_id: 'c1', original_available: 'readback', original_bytes: null }),
        'bash',
      );
      const withSeq = projectionMetaFieldsOf(
        projection({
          tool_call_id: 'c2',
          original_available: 'readback',
          original_bytes: 1024,
          since_event_seq: 42,
        }),
        'bash',
      );
      const labels = (fields: { labelKey: string }[]) => fields.map((field) => field.labelKey);
      return (
        !labels(withoutSeq).includes('chat.projection.meta.sinceSeq') &&
        labels(withSeq).includes('chat.projection.meta.sinceSeq') &&
        // 体量未知时仍是「未知」而不是 0（0 会读成「零字节」）。
        withoutSeq.some(
          (field) => field.labelKey === 'chat.projection.meta.bytes' && field.value === null,
        ) &&
        withSeq.some(
          (field) => field.labelKey === 'chat.projection.meta.bytes' && field.value === '1024',
        ) &&
        // 工具名永远在（至少让人知道是哪一条调用的原文丢了）。
        withoutSeq[0]?.value === 'bash'
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
  console.error(`chat visibility: ${failures.length}/${FIXTURES.length} fixture(s) FAILED`);
  process.exit(1);
}

console.log(`chat visibility: ${FIXTURES.length} fixtures passed`);
