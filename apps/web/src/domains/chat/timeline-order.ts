/**
 * 会话/Team 时间线的**排序决策**（纯函数：无 React、无 DOM、无 window）。
 *
 * 不变量（见 docs/WEB-UI.md 的「时间线渲染顺序」一节）：
 * 1. 历史消息按 timestamp；缺时间戳时沿用前一条（老数据降级，不甩到末尾）。
 * 2. live 节点（一条 run 的正文 + 思考 + 工具卡，整块不可拆）用
 *    max(run 起始 ts, 触发它的 user 消息 ts + 1) —— run.started 早于用户消息落盘
 *    （core 先发事件、后 addContext 打时间戳），只按 run 起始时间排会把本轮输出
 *    顶到用户消息上方。
 * 3. 伪 run 组（session.titled 用常量 session、runtime.notice 用常量 runtime、
 *    成员/插件事件用域 id）永不终态，必须按 item 各自的事件时间逐条落位。
 * 4. 兜底只有一条：**仍在 running** 的 run 才允许回落到「最后一条用户消息 + 1」；
 *    已终态的 run 不兜底（否则历史轮次的失败/取消卡会被拽到当前轮）。
 * 5. 比可见窗口首条消息更早的 live 节点落到末尾（windowStartTs 夹取）。
 * 6. 同 ts 用 seq 回退，再退回插入序（稳定排序）。
 *
 * 这里是唯一实现：组件只负责把数据翻译成入参、把返回的顺序渲染成节点。
 */

/** 参与排序的历史消息。 */
export interface TimelineMessageInput {
  key: string;
  /** user / assistant / tool / system。 */
  role: string;
  content: string;
  /** 模型侧上下文消息（vessel:*）：不是用户输入，不参与 turn 锚点。 */
  runtimeContext: boolean;
  timestamp?: number;
}

/** 伪 run 组里的一条 item。 */
export interface TimelineLiveItemInput {
  key: string;
  ts?: number;
}

/** 参与排序的 live 节点（真实 run / 排队 notice / 伪 run 组）。 */
export interface TimelineLiveInput {
  key: string;
  /** run 起始 ts（run.started）或排队提交时间。 */
  startTs?: number;
  /** 同 ts 的稳定回退（run 首个 wire seq）。 */
  seq?: number;
  /** run 的输入文本：用来找「触发它的那条用户消息」。 */
  input?: string;
  /** 是否仍在运行：**唯一**允许回落到「最后一条用户消息」的条件。 */
  running?: boolean;
  /** 伪 run 组：按 item 各自 ts 逐条落位（整组锚定会让后续事件堆在最早时刻）。 */
  items?: readonly TimelineLiveItemInput[];
}

/** 排序结果：只描述顺序与身份，不含渲染内容。 */
export interface TimelineEntry {
  key: string;
  kind: 'message' | 'live';
  ts?: number;
  seq?: number;
  /** kind === 'message'：在 messages 入参里的下标。 */
  messageIndex?: number;
  /** kind === 'live'：在 live 入参里的下标。 */
  liveIndex?: number;
  /** kind === 'live' 且来自伪 run 组展开时的 item key。 */
  itemKey?: string;
}

export interface TimelineOrderInput {
  messages: readonly TimelineMessageInput[];
  live: readonly TimelineLiveInput[];
  /** 可见窗口首条消息的 ts：比它更早的 live 节点落到末尾。 */
  windowStartTs?: number;
}

/**
 * 稳定排序：ts 主序（缺 ts 排最后），同 ts 先比 seq，再退回插入序。
 *
 * 导出给需要复用同一口径的调用方；时间线本身只经 orderTimelineEntries。
 */
export function compareTimelineEntries(
  a: { ts?: number | undefined; seq?: number | undefined },
  b: { ts?: number | undefined; seq?: number | undefined },
  aIndex: number,
  bIndex: number,
): number {
  const at = a.ts;
  const bt = b.ts;
  if (at !== undefined && bt !== undefined && at !== bt) return at - bt;
  if (at === undefined && bt !== undefined) return 1;
  if (at !== undefined && bt === undefined) return -1;
  const aseq = a.seq;
  const bseq = b.seq;
  if (aseq !== undefined && bseq !== undefined && aseq !== bseq) return aseq - bseq;
  return aIndex - bIndex;
}

/** 窗口夹取：比窗口首条更早的节点不给 ts（排序时落到末尾）。 */
function clampToWindow(
  ts: number | undefined,
  windowStartTs: number | undefined,
): number | undefined {
  if (ts === undefined || windowStartTs === undefined || ts >= windowStartTs) return ts;
  return undefined;
}

/** 历史消息 → 排序条目（缺时间戳沿用前一条）。 */
function messageEntries(messages: readonly TimelineMessageInput[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let carry: number | undefined;
  messages.forEach((message, index) => {
    if (message.timestamp !== undefined) carry = message.timestamp;
    entries.push({
      key: message.key,
      kind: 'message',
      ts: message.timestamp ?? carry,
      messageIndex: index,
    });
  });
  return entries;
}

/** live 入参 → turn 锚点表（真实用户消息，按出现顺序）。 */
function userAnchorsOf(
  messages: readonly TimelineMessageInput[],
): { content: string; ts: number }[] {
  const anchors: { content: string; ts: number }[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.runtimeContext) continue;
    if (message.timestamp === undefined) continue;
    anchors.push({ content: message.content.trim(), ts: message.timestamp });
  }
  return anchors;
}

/**
 * live 节点的 turn 下限：触发它的 user 消息 ts + 1。
 *
 * ① 按 input 找内容相同的最后一条真实用户消息（同文多轮取最新）；
 * ② 匹配不上（guardrail 改写过正文）时，**只有 running 的 run** 才回落到
 *    「最后一条用户消息 + 1」；已终态 run 返回 undefined（保留自己的 run 起始时间）。
 */
function turnFloorFor(
  input: string | undefined,
  running: boolean | undefined,
  anchors: readonly { content: string; ts: number }[],
): number | undefined {
  const text = input?.trim();
  if (text !== undefined && text.length > 0) {
    for (let index = anchors.length - 1; index >= 0; index -= 1) {
      const anchor = anchors[index];
      if (anchor !== undefined && anchor.content === text) return anchor.ts + 1;
    }
  }
  if (running !== true) return undefined;
  const lastUser = anchors.length > 0 ? anchors[anchors.length - 1] : undefined;
  return lastUser === undefined ? undefined : lastUser.ts + 1;
}

/**
 * 历史消息 + live 节点 → 按时间线合并后的条目序列。
 *
 * 返回值只描述顺序；渲染由调用方按键映射（同一条 run 的所有 item 永远在同一个
 * 条目里，不会被拆散）。
 */
export function orderTimelineEntries({
  messages,
  live,
  windowStartTs,
}: TimelineOrderInput): TimelineEntry[] {
  const entries = messageEntries(messages);
  const anchors = userAnchorsOf(messages);

  live.forEach((node, liveIndex) => {
    const items = node.items;
    if (items !== undefined) {
      // 伪 run 组：一条 item 一个条目，各按自己的事件时间落位。
      for (const item of items) {
        entries.push({
          key: `${node.key}#${item.key}`,
          kind: 'live',
          ts: clampToWindow(item.ts, windowStartTs),
          seq: node.seq,
          liveIndex,
          itemKey: item.key,
        });
      }
      return;
    }
    const floor = turnFloorFor(node.input, node.running, anchors);
    const base = floor === undefined ? node.startTs : Math.max(node.startTs ?? floor, floor);
    entries.push({
      key: node.key,
      kind: 'live',
      ts: clampToWindow(base, windowStartTs),
      seq: node.seq,
      liveIndex,
    });
  });

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareTimelineEntries(a.entry, b.entry, a.index, b.index))
    .map(({ entry }) => entry);
}
