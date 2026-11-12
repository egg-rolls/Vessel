/**
 * 「rotate 交接」：新身体的启动嘱托在时间线上的身份与解析（纯函数）。
 *
 * 数据仍是那条真正的 user 消息（协议要求：只有 user 消息才能开新一轮 run，而且新身体
 * 这一轮**唯一**的工作指令就是它），但写字的人不是在输入框前坐着的那个：rotate 是上一具
 * 身体（或某个发起方 agent）通过内置 `agent` 工具的 rotate 动作发起的，`startup_prompt`
 * 就是它写的交接书。所以呈现换成一张卡（与「待批答复」卡同一个思路）：
 * - 身份：投递方把它写成 `Message.name = 'rotate:handoff:<epoch>'`
 *   （`packages/agent/src/service.ts` 的 `ROTATE_HANDOFF_INPUT_NAME`，字面量必须一致）；
 *   它不是 `vessel:*` —— 那是模型侧上下文、不算 turn 锚点，这条**就是**该轮的用户输入。
 * - `:epoch` = 新身体的 epoch。为什么塞在 name 里而不是正文：`Message` 只有
 *   role / content / name / timestamp，**name 是唯一能随消息持久化的身份位**，而正文
 *   一个字都不许改；卡片因此刷新后仍能显示「epoch N」，不用数历史里的交接次数去猜。
 *   第三段读不懂（旧数据 / 手改）时按「不带 epoch」处理，卡头少写一段而已。
 *
 * 只认 `rotate:handoff` 前缀（且后面只能是 `:` + 数字 / 什么都没有）：名字格式不对时
 * 返回 undefined，调用方**回退普通消息渲染** —— 宁可少一张卡，也不吞正文。
 *
 * **不覆盖的路径（登记）**：子 agent 面板（`StreamItems.tsx` 的 `RunItems`，
 * `SubagentTranscript` 用它）仍按普通输入渲染。理由：交接嘱托是新身体**自己这一轮**的
 * run 输入，不会出现在任何子 agent 的 run 输入里 —— 那条路径看不到这种消息，
 * 为它加一个分支只会多一份没人走的判定。
 *
 * @module web/domains/chat/rotate-handoff
 */

/**
 * 交接嘱托的消息名前缀（与 `packages/agent` 的 `ROTATE_HANDOFF_INPUT_NAME` 同一字面量）。
 */
export const ROTATE_HANDOFF_MESSAGE_NAME = 'rotate:handoff';

/** 一张「rotate 交接」卡的元数据。 */
export interface RotateHandoff {
  /**
   * 新身体的 epoch（名字第三段）。缺省 = 这段名字没带 / 读不懂 ⇒ 卡头不写 epoch。
   *
   * 只写**已经写进消息里的那个数**：不从「历史里第几次交接」之类的东西反推，
   * 否则卡头会出现一个谁都没见过的 epoch。
   */
  epoch?: number;
}

/**
 * 消息名 → 交接卡数据；不是 rotate 交接返回 undefined。
 *
 * `rotate:handoff`（无 epoch）与 `rotate:handoff:3` 都认；`rotate:handoffx` /
 * `rotate:handoff:abc` 一律不认（不是我们生产的名字，别硬套成一张卡）。
 */
export function rotateHandoffOf(name: string | undefined): RotateHandoff | undefined {
  if (typeof name !== 'string' || !name.startsWith(ROTATE_HANDOFF_MESSAGE_NAME)) return undefined;
  const rest = name.slice(ROTATE_HANDOFF_MESSAGE_NAME.length);
  if (rest.length === 0) return {};
  if (!rest.startsWith(':')) return undefined;
  const raw = rest.slice(1);
  // 只接受十进制整数：`Number('')` / `Number(' 1')` 这类宽松解析会把垃圾读成 epoch。
  if (!/^\d+$/.test(raw)) return undefined;
  const epoch = Number(raw);
  return Number.isSafeInteger(epoch) ? { epoch } : {};
}
