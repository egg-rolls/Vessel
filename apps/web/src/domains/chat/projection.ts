/**
 * 投影卡（0.54）的**纯逻辑**：badge 词表 / 默认视角 / readback 请求与抽帧 / 汇总数字口径。
 *
 * spec = `docs/specs/projection-card-spec.md`（0.54 投影卡规格；下文 § 编号均指该文档，
 * 早期 design 稿已退场，以 specs 定稿为准）。
 *
 * 为什么单独一个 `.ts`（无 React、无 DOM）：判定口径是纯函数，便于复用与评审核对
 * （原 fixture 对拍脚本已按宪法删除）。渲染层只负责把结果摆进 DOM。
 *
 * 三条纪律写在这里、由门禁钉住，别在组件里各写一份：
 * 1. **合并按 `tool_call_id`**（见 `projectionIndexByCallId`），不按数组下标；
 * 2. 模型视角的文本 = wire 上的 `placeholder_text` **逐字**（见 `modelViewTextOf`）；
 * 3. 体量 / 行数**只读 wire**，绝不从正文 parse（正文超 8 KiB 时尾部会被裁，数字会错）。
 */

import type { ProjectionSummary, ProjectionView } from '../../gateway/types';
import { valueText } from './tool-cards';

/** 双层卡的两个视角（spec §3.3）：`original` = 原文，`model` = 模型看到的。 */
export type ProjectionTab = 'original' | 'model';

/** 投影 badge 的展示形状；`null` = 这张投影不出 badge（词表见 spec §3.2）。 */
export interface ProjectionBadgeSpec {
  /** badge 文案（`chat.projection.badge.*`）。 */
  labelKey: string;
  /** 长解释走元素 `title`（不做弹出层、不靠 hover 才可见）。 */
  hintKey: string;
  /** 「为什么默认落到模型视角」的补充解释（`readback` / `gone` 才有）。 */
  reasonKey?: string;
  /** `gone`（原文不可恢复）用 danger tone。 */
  danger: boolean;
}

/** badge 词表：`archive_notice` / `passthrough` **不出 badge**（ADR-104 §8.5 不进 C1h 披露）。 */
const BADGE_KEYS: Partial<Record<ProjectionView['mode'], { labelKey: string; hintKey: string }>> = {
  placeholder: {
    labelKey: 'chat.projection.badge.placeholder',
    hintKey: 'chat.projection.badge.placeholderHint',
  },
  externalize: {
    labelKey: 'chat.projection.badge.externalize',
    hintKey: 'chat.projection.badge.externalizeHint',
  },
};

/** 默认落到模型视角的原因（原文面板本来就是空的，spec §3.6 例外）。 */
const REASON_KEYS: Partial<Record<ProjectionView['original_available'], string>> = {
  readback: 'chat.projection.badge.reason.readback',
  gone: 'chat.projection.badge.reason.gone',
};

/**
 * badge 规格（常驻可见、纯文本、不是按钮）。
 *
 * 注意 `passthrough` **不会**走到这里（服务端对这种条目压根不发 `projection`），
 * 但词表仍然显式返回 `null`：哪天有人从别处造出这个 mode，也不该冒出 badge。
 */
export function projectionBadgeOf(view: ProjectionView): ProjectionBadgeSpec | null {
  const keys = BADGE_KEYS[view.mode];
  if (keys === undefined) return null;
  const reasonKey = REASON_KEYS[view.original_available];
  return {
    labelKey: keys.labelKey,
    hintKey: keys.hintKey,
    ...(reasonKey !== undefined ? { reasonKey } : {}),
    danger: view.original_available === 'gone',
  };
}

/** 这张投影有没有「两层」可展示。`archive_notice`（卡就是消息）/ `passthrough` 没有。 */
export function hasProjectionPanes(view: ProjectionView): boolean {
  return BADGE_KEYS[view.mode] !== undefined;
}

/**
 * 元信息的一行：`labelKey` 是 i18n key，`value === null` = 服务端不知道（渲染成「未知」）。
 *
 * 单独抽出来是为了让「`since_event_seq` 缺省时这一行根本不出现」变成可断言的事实，
 * 而不是 JSX 里的一处 `?? '未知'`（永远显示「未知」只是噪音）。
 */
export interface ProjectionMetaField {
  labelKey: string;
  value: string | null;
  /** `bytes` = 数值（渲染时带上 B 单位）；`text` = 原样输出。 */
  unit: 'bytes' | 'text';
}

/** 原文不在消息里时给的最低限度交代：哪条工具、多大、什么时候发生的。 */
export function projectionMetaFieldsOf(
  view: ProjectionView,
  toolName: string,
): ProjectionMetaField[] {
  const fields: ProjectionMetaField[] = [
    { labelKey: 'chat.projection.meta.tool', value: toolName, unit: 'text' },
    {
      labelKey: 'chat.projection.meta.bytes',
      value: view.original_bytes === null ? null : String(view.original_bytes),
      unit: 'bytes',
    },
  ];
  // 「发生 seq」只在**有值**时给：缺省 = 不知道（服务端不写 0 冒充「从日志头起」），
  // 而一行永远显示「未知」的元信息只是噪音。
  if (view.since_event_seq !== undefined) {
    fields.push({
      labelKey: 'chat.projection.meta.sinceSeq',
      value: String(view.since_event_seq),
      unit: 'text',
    });
  }
  return fields;
}

/**
 * 「原文视角」面板里的文本；`undefined` = 原文不在消息里（`readback` / `gone`）。
 *
 * **逐字**等于消息正文（= 原「输出」分区的内容）：投影卡接管输出展示后，这条等式就是
 * 「没有信息丢失」的判据 —— 不许 trim、不许补空格、不许把占位/截断版当成原文。
 * 归一化只做一件事：空正文当作「没有原文」（渲染层不画空面板）。
 */
export function projectedOriginalText(view: ProjectionView, result: unknown): string | undefined {
  if (view.original_available !== 'inline' && view.original_available !== 'inline_truncated') {
    return undefined;
  }
  const text = valueText(result);
  return text.length > 0 ? text : undefined;
}

/**
 * 「输出」分区还要不要渲染：**有投影时由双层面板接管**。
 *
 * 两个理由：① `inline` 时两处文本逐字相同，同一张卡显示两遍像 bug；
 * ② `readback` 时消息正文已经是占位符，把它当「输出」摆在「原文不在消息里」旁边会误导。
 * 这个判断单独一个函数是为了让门禁能钉住「接管 ≠ 丢失」（见 `projectedOriginalText`）。
 */
export function showsOutputSection(view: ProjectionView | undefined): boolean {
  return view === undefined;
}

/**
 * 截断上限的**兜底**常量：只在 wire 没给 `truncated.content.limit` 时才用它。
 *
 * 正常情况下这个数字必须来自 wire（`truncatedLimitLabel` 的入参）：界面上「已截到前 N」
 * 是用户会当事实读的数字，服务端改上限时它得跟着变。兜底是末路，不是默认值。
 */
export const TRUNCATION_LIMIT_FALLBACK_BYTES = 8 * 1024;

/** 上限的人话：整 KiB 用 `KiB`，否则退回字节（不编造小数）。 */
export function truncationLimitLabel(limitBytes: number): string {
  if (limitBytes > 0 && limitBytes % 1024 === 0) return `${limitBytes / 1024} KiB`;
  return `${limitBytes} B`;
}

/**
 * 读回按钮的文案 key。**两处语义不同，不许共用一句**：
 * - `inline_truncated`：取回**被上限截掉的尾巴**（正文前半段已经在卡上）；
 * - `readback`：取回**占位之前的那份原文**（消息里只剩占位）。
 */
export function readbackActionKeyOf(view: ProjectionView): string | undefined {
  if (readbackRequestOf(view) === undefined) return undefined;
  return view.original_available === 'inline_truncated'
    ? 'chat.projection.readbackTail'
    : 'chat.projection.readbackFromLog';
}

/**
 * 默认视角（spec §3.6，用户 2026-11-15 拍板 = A）：
 * - `inline` / `inline_truncated`：正文就是原文 ⇒ **默认原文视角**，模型视角一键可达；
 * - `readback` / `gone`：原文面板里没内容 ⇒ **自动落模型视角**（否则默认给人一个空面板）。
 *
 * 例外只由数据决定，不由「有没有压缩过」猜（spec §7.1 第一条）。
 */
export function defaultProjectionTab(view: ProjectionView): ProjectionTab {
  return view.original_available === 'inline' || view.original_available === 'inline_truncated'
    ? 'original'
    : 'model';
}

/**
 * 模型视角面板的文本 = `placeholder_text` **逐字**。
 *
 * 单独包一层是为了让门禁能钉住：这里的任何加工（trim / 补空格 / 重排换行 / 本地化）
 * 都会让「用户复制到的东西」≠「模型看到的字节」，而那张卡的全部价值就在于两者相等。
 */
export function modelViewTextOf(view: ProjectionView): string {
  return view.placeholder_text;
}

/** `sessions.events` 的读回参数（`since_seq` **排他**；`0` = 从日志头按 id 找）。 */
export interface ProjectionReadbackRequest {
  toolCallId: string;
  sinceSeq: number;
}

/**
 * 这条投影该怎么读回原文；`undefined` = 这张卡不提供读回。
 *
 * - `kind:'events'`：直接用 wire 给的句柄（服务端说从哪个 seq 之后找）；
 * - `kind:'file'` / `kind:'handle'`：读回动作还没接线 ⇒ **不猜来源**、不给按钮；
 * - `inline_truncated`：wire 不给句柄（原文就在消息里，只是被裁到前 8 KiB），按同一个
 *   `sessions.events` 口径读回全文 —— 事件日志里那条 `tool.call.completed` 才是完整原文；
 * - `inline`（本来就是全文）与 `gone`（不可恢复）：都没有可读的东西。
 */
export function readbackRequestOf(view: ProjectionView): ProjectionReadbackRequest | undefined {
  const handle = view.readback;
  if (handle !== undefined) {
    return handle.kind === 'events'
      ? { toolCallId: handle.tool_call_id, sinceSeq: handle.since_seq }
      : undefined;
  }
  if (view.original_available === 'inline_truncated') {
    return { toolCallId: view.tool_call_id, sinceSeq: 0 };
  }
  return undefined;
}

/** `sessions.events` 一页里我们要认的最小形状（其余字段不参与判定）。 */
export interface ProjectionReadbackEvent {
  type: string;
  data?: unknown;
}

function readbackRecord(event: ProjectionReadbackEvent): Record<string, unknown> | undefined {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return undefined;
  return data as Record<string, unknown>;
}

/**
 * 从 `sessions.events` 的一页里取**原文正文**：只认这条调用自己的结果，别的都不猜。
 *
 * `tool.call.completed` 的 `data.result` 就是落盘的那份工具输出（`project-messages` 用它
 * 还原 `role:'tool'` 消息）；失败调用的原文在 `tool.call.failed` 的 `data.error` 里。
 * 同一页里既有 completed 又有 failed 时以 completed 为准（它就是消息里那条结果）。
 */
export function readbackOriginalOf(
  events: readonly ProjectionReadbackEvent[],
  toolCallId: string,
): string | undefined {
  let failed: string | undefined;
  for (const event of events) {
    const record = readbackRecord(event);
    if (record === undefined || record.tool_call_id !== toolCallId) continue;
    if (event.type === 'tool.call.completed' && typeof record.result === 'string') {
      return record.result;
    }
    if (
      event.type === 'tool.call.failed' &&
      failed === undefined &&
      typeof record.error === 'string'
    ) {
      failed = record.error;
    }
  }
  return failed;
}

/**
 * 读回结果 → 展示态。**读回为空（或读失败）一律降级成 `gone` 的文案**
 * （「原文已不可恢复」）：不弹错误框、不显示 stack、不假装「加载中」转到天荒地老。
 *
 * 服务端本轮不产出 `gone`（判它要扫事件日志），所以这条降级路径是 `readback` 唯一的
 * 「读不回来」出口 —— spec §1.7、§6 第 5 条都要求它是**明确的界面变化**，不是静默空白。
 */
export type ProjectionReadbackOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'gone'; labelKey: string };

export function readbackOutcomeOf(text: string | undefined): ProjectionReadbackOutcome {
  return typeof text === 'string' && text.length > 0
    ? { kind: 'text', text }
    : { kind: 'gone', labelKey: 'chat.projection.gone' };
}

/**
 * 「省了多少」：服务端给的是**净值**（可为负，实测 -6 B），展示层自己 clamp 到 ≥0。
 *
 * clamp 之后只意味着「这一项没省下可读的字节数」，不改变 `bytes_saved` 的真值口径；
 * 别把负数翻译成任何别的意思（spec §1.7.1 第 3 条）。
 */
export function savedBytesOf(summary: ProjectionSummary): number {
  return Math.max(0, Math.trunc(summary.bytes_saved));
}

/**
 * 累计数字是不是**下界**：`unknown_original_count > 0` 时必须写明「有 N 条原文体量未知」，
 * 否则用户会把下界当总数（spec §1.7.1 第 2 条）。
 */
export function summaryLowerBoundCount(summary: ProjectionSummary): number {
  return summary.unknown_original_count > 0 ? summary.unknown_original_count : 0;
}

/**
 * 投影按 `tool_call_id` 建索引（**不按数组下标**）。
 *
 * 为什么这是硬性纪律：消息窗口可能从 assistant 中间切起 —— 窗口首条是某条工具结果
 * （它的 owning assistant 在窗口外），这时「第 i 条消息的 projection 挂到第 i 张卡」
 * 会把 A 卡的占位挂到 B 卡上。工具卡的身份只有 `tool_call_id` 一个。
 *
 * 同一个 id 出现多次（窗口重叠 / 分页重叠）时保留**先到**的那份：服务端按 tool 消息
 * 派发一份，重复只可能是同一条消息被送了两遍，先到的不会更假。
 */
export function projectionIndexByCallId(
  messages: readonly { projection?: ProjectionView }[],
): Map<string, ProjectionView> {
  const byCallId = new Map<string, ProjectionView>();
  for (const message of messages) {
    const projection = message.projection;
    if (projection === undefined) continue;
    const id = projection.tool_call_id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (byCallId.has(id)) continue;
    byCallId.set(id, projection);
  }
  return byCallId;
}
