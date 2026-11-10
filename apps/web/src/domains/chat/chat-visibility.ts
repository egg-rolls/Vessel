/**
 * 会话时间线里「一条 item / 一条 tool 消息该不该渲染」的判定（纯函数，无 React/DOM）。
 *
 * 存在的理由：live（事件流实时展开）与 history（sessions.get 已落盘消息）长期
 * 各写一套可见性规则，于是同一张工具卡会出现「运行中看不见、run 落盘后突然出现」。
 * 现在两边都只调用这里的判定，档位语义只有一份。
 *
 * 档位语义：
 * - minimal：只留正文、上下文 notice、**失败**（工具失败 / 错误事件行）；
 * - normal：全部 item（含运行中的工具卡与思考）；
 * - debug：等同 normal（额外调试信息由渲染层自己加）。
 *
 * 不变量：**运行中与已终态走同一判定**。options.running 只作为调用侧的一致性输入传入，
 * 判定结果必须与终态相同（scripts/check-chat-visibility.ts 有专门 fixture 对拍），
 * 否则又会出现「跑的时候藏、跑完冒出来」。
 */

import { isErrorEventType } from '../../state/error-visibility';
import type { Verbosity } from '../../state/visibility';
import type { ChatRenderItem } from './tool-cards';

/** 工具卡状态（与 ToolCardView 的 status 一致）。 */
export type ToolVisibilityStatus = 'running' | 'done' | 'error';

/**
 * 一张工具卡在给定档位是否可见。
 *
 * minimal 只保留失败卡（失败永不静默）；normal / debug 全部保留（含 running）。
 * 与  无关：运行中的卡与终态卡必须同时可见或同时隐藏。
 */
export function toolVisible(status: ToolVisibilityStatus, verbosity: Verbosity): boolean {
  return verbosity !== 'minimal' || status === 'error';
}

/**
 * history 侧（role === 'tool' 的已落盘消息）是否可见 —— 与 live 共用同一判定。
 *
 * 落盘的 tool 消息不带状态（成功与失败都只是一条 message），因此调用方传 done；
 * 失败信息另外由失败 run 的 notice 承担，不会在这里被永久藏掉。
 */
export function historyToolVisible(status: ToolVisibilityStatus, verbosity: Verbosity): boolean {
  return toolVisible(status, verbosity);
}

/** 一条原始事件行在给定档位是否可见：minimal 只留错误 / 失败行（失败永不静默）。 */
export function eventRowVisible(type: string, verbosity: Verbosity): boolean {
  return verbosity !== 'minimal' || isErrorEventType(type);
}

/** minimal 档下「在飞工具」的一行紧凑状态（只带工具名，不含参数 / 输出）。 */
export interface RunningToolHint {
  key: string;
  name: string;
}

/**
 * minimal 档的一行状态：minimal 会把工具卡整体隐藏，没有这行会让人以为 run 卡住。
 *
 * 只在三个条件同时成立时返回：
 * - verbosity 为 minimal（normal / debug 有完整卡片，不需要这一行）；
 * - run 仍在跑（options.running；已终态就不再显示活动提示）；
 * - 该 run 里**最后一条工具项**的 status 仍是 running（工具结束即消失；
 *   顺序调用下它就是正在跑的那个）。
 *
 * 不使用新开关：它只是 minimal 档对「隐藏了工具卡」的一行补偿。
 */
export function runningToolHint(
  items: readonly ChatRenderItem[],
  options: { verbosity: Verbosity; running?: boolean },
): RunningToolHint | undefined {
  if (options.verbosity !== 'minimal') return undefined;
  if (options.running !== true) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || item.kind !== 'tool') continue;
    return item.status === 'running' ? { key: item.key, name: item.name } : undefined;
  }
  return undefined;
}

/**
 * 思考块可见性：live 与历史共用同一档位（minimal 隐藏，normal / debug 显示）。
 * live 侧由 `filterTimelineItems` 内联判定，历史侧（Transcript）直接调这里 ——
 * 两处不能各写一份，否则「跑的时候能看到、结束后消失」又会回来。
 */
export function reasoningVisible(verbosity: Verbosity): boolean {
  return verbosity !== 'minimal';
}

/**
 * live 的渲染项过滤：foldToolItems(group.items) 的结果 → 实际渲染项。
 *
 * options.running 传入 run 是否仍在跑，仅用于调用侧一致性（见文件头不变量），
 * 不参与判定。
 */
export function filterTimelineItems(
  items: readonly ChatRenderItem[],
  options: { verbosity: Verbosity; running?: boolean },
): ChatRenderItem[] {
  const verbosity = options.verbosity;
  if (verbosity !== 'minimal') return items.slice();
  return items.filter((item) => {
    if (item.kind === 'text' || item.kind === 'notice') return true;
    if (item.kind === 'reasoning') return reasoningVisible(verbosity);
    if (item.kind === 'tool') return toolVisible(item.status, verbosity);
    return eventRowVisible(item.event.type, verbosity);
  });
}
