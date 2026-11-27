/**
 * 请求期图片被丢弃时的模型侧事实注记（q-vision-image-budget-fix ③）。
 * @module @vessel-agent/core/vision
 *
 * 为什么需要这张卡：工具附图的注入文案（loop `toolImageAttachmentNote`）只说「已附到
 * 这条消息上，模型有视觉能力时内联」，而 `budget` 等请求期丢弃发生在**那之后**——模型
 * 看不到任何「图没发出去」的信号，容易照着乐观回执声称看到了图（probe 实锤：长会话
 * 第 7 张图被 budget 丢弃，模型仍按「已作为附件加入上下文」作答）。投递事实事件
 * （`image.sent` / `context.image_dropped`）只到 GUI / 日志，不进模型上下文。
 *
 * 这张卡把「哪几张图、因为什么没内联」以既有 env 卡通道（`vessel:notice`，追加不改写）
 * 讲给模型与用户：首行 scope `context`，明细行 `  · `，与 `context-notice.ts` /
 * agent `formatEnvInfo` 同一线格式（对拍义务同 `renderToolSurfaceNotice`：core 不能
 * import agent，字面量复用）。
 *
 * 确定性：同一份 drops 永远拼出同一字符串（无时间 / 随机字段）；时间戳与 message_id
 * 由 `appendNotice` 统一盖，不在文案里。
 */

import type { DroppedImage } from '../types/vision.js';
import { imageDropLabel } from './plan.js';

/** 明细行前缀；与 agent `ENV_INFO_DETAIL_MARK` / Web 明细标记逐字相同（两空格 + `·`）。 */
const DETAIL_MARK = '  · ';

/**
 * 图片明细行上限。8 图 + 1 行「and N more」+ 1 行指引 = 10 = agent `ENV_INFO_DETAILS_MAX`
 * / Web `ENV_NOTICE_DETAILS_MAX` 的渲染上限，长清单在生产者侧收口。
 */
const IMAGE_LINES_MAX = 8;

/** 行为指引：不许声称看到了图；需要内容时改走工具读图（不点名具体插件，core 不绑工具名）。 */
const GUIDANCE =
  'do not claim to have seen these images; tell the user they were not delivered, ' +
  'and read the image via available tools (OCR / describe) if you need its content';

/**
 * 把「本次请求新丢弃的已入池图片」渲染成一张事实注记卡。
 *
 * 调用方（EU `chatWithOverflowRetry`）只传**首次报告**的丢弃（与 `context.image_dropped`
 * 事件同一套 session+sha8+reason 去重），且只传带 sha256 的（已入池、工具回执声称附上了
 * 的）——`not_ingested` 的图 loop 根本不会 surfaced，没有乐观回执，不需要这张卡；
 * `vision_disabled` / `no_vision` 也不传（那两条路尾注回落老文案，kill switch 行为不变）。
 */
export function renderImageDropNotice(drops: readonly DroppedImage[]): string {
  const noun = drops.length === 1 ? 'image' : 'images';
  const head =
    `context: ${String(drops.length)} ${noun} attached to this conversation were NOT inlined ` +
    'in this request; you cannot see them';
  const lines = drops
    .slice(0, IMAGE_LINES_MAX)
    .map((drop) => `${DETAIL_MARK}${drop.path} — ${imageDropLabel(drop.reason)}`);
  if (drops.length > IMAGE_LINES_MAX) {
    lines.push(`${DETAIL_MARK}and ${String(drops.length - IMAGE_LINES_MAX)} more`);
  }
  lines.push(`${DETAIL_MARK}${GUIDANCE}`);
  return [head, ...lines].join('\n');
}
