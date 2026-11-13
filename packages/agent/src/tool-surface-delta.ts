/**
 * 工具面变更 → 环境信息（0.52）。
 *
 * 工具面在运行期会变：`refreshTools` 热刷新（轮边界原地换 body 自己的工具宿主）、成员工具面
 * 跟着权限档 / Team / inbox 开关变化。这些都是**模型应当知道、但 system 前缀表达不了**的
 * 事实 —— 它只存在于请求的 `tools` 参数里，而历史消息里一个字都没有。
 *
 * 做法与 `self-card-delta` 完全同源（用户裁定）：**不重建 body、不改 system 消息**，在该成员
 * 的下一轮 BeforeLlm 追加一条 `vessel:notice` 环境信息，说清「你手上的工具变了，要求 / 新的
 * 清单在这」。scope = `tools`，Web 按同一张环境信息卡渲染，不新造事件、不新造卡片。
 *
 * 去重口径（与 `self-card-delta` / `refs-notice-hook` 同一族）：记住「模型现在相信的工具面」，
 * 注入一次就把它推进到当前集合；下一轮 diff 为空 ⇒ 不再注入。所以**同一变更只报一次**，
 * 而回滚（A→B→A）因为与「相信的集合」不同、照样会报 —— 只按 spawn 快照去重的话，回滚会被
 * 静默吞掉。
 *
 * 为什么不能只报 `tools_count` 的变化：模型需要的是**名字**。少了一个 `bash` 和少了一个
 * `subscribe`，对它的行动方案影响完全不同，报个数字等于什么都没说。
 *
 * @module @vessel-agent/agent
 */

import type { Hook, HookType, Message } from '@vessel-agent/core';
import { ENV_INFO_MESSAGE_NAME, formatEnvInfo, sortedNames } from './env-info-scope.js';

/**
 * `HookType.BeforeLlm` 的字面值（`packages/core/src/types/hook.ts`）。
 *
 * 为什么不用枚举：本模块与 `self-card-delta` 一样要保持**零运行时依赖**，
 * `src/tool-surface-delta.test.ts` 才能在任何一份 checkout 里直接 `bun run`（未装
 * node_modules 时 `@vessel-agent/core` 解析不到）。D5（`scripts/check-deps.ts`）又禁止
 * 非 core 包相对 import core 内部 —— 只剩「值取自字面量、类型由枚举兜住」这一条。
 */
const BEFORE_LLM = 'before_llm' as HookType;

/** 注册名（同一具 body 的插件宿主上幂等注册用）。 */
export const TOOL_SURFACE_DELTA_HOOK = 'tool-surface-delta';

/** 注入消息的 `name`：与其它环境信息同一条通道（Web 按它认 `notice`）。 */
export const TOOL_SURFACE_DELTA_MESSAGE_NAME = ENV_INFO_MESSAGE_NAME;

/** 一次工具面变更（纯数据；空数组 = 那一侧没有变）。 */
export interface ToolSurfaceChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** 名字集合 → 变更（纯函数）。排序保证同一批变更永远拼出同一个字符串。 */
export function diffToolSurface(
  reported: readonly string[],
  current: readonly string[],
): ToolSurfaceChange {
  const before = new Set(reported);
  const after = new Set(current);
  return {
    added: sortedNames(current.filter((name) => !before.has(name))),
    removed: sortedNames(reported.filter((name) => !after.has(name))),
  };
}

export function isEmptyToolSurfaceChange(change: ToolSurfaceChange): boolean {
  return change.added.length === 0 && change.removed.length === 0;
}

/**
 * 一批变更 → 一条环境信息正文。
 *
 * 真实形状（`\n` 是换行）：
 * ```
 * tools: 2 added, 1 removed; the tool list sent in earlier requests of this body is out of date
 *   · + subscribe
 *   · + ask
 *   · - fs_write
 * ```
 * 首行的 scope 词是 Word 侧认卡头的唯一依据；`+ / -` 是给模型看的方向（它据此知道哪些名字
 * **不能**再调、哪些是新的）。超过 10 项时由 `formatEnvInfo` 收口成「and N more」。
 */
export function formatToolSurfaceDelta(change: ToolSurfaceChange): string {
  const added = change.added.length;
  const removed = change.removed.length;
  const parts: string[] = [];
  if (added > 0) parts.push(`${String(added)} added`);
  if (removed > 0) parts.push(`${String(removed)} removed`);
  const summary =
    `${parts.join(', ')}; ` + 'the tool list sent in earlier requests of this body is out of date';
  return formatEnvInfo({
    scope: 'tools',
    summary,
    details: [
      ...change.added.map((name) => `+ ${name}`),
      ...change.removed.map((name) => `- ${name}`),
    ],
    moreLabel: (dropped) => `and ${String(dropped)} more`,
  });
}

export interface ToolSurfaceDeltaHookOptions {
  /**
   * spawn 那一刻 body 的工具面：**模型现在看到的就是它**。
   *
   * 不用宿主当前值当起点（那是「事实」，不是「模型相信的东西」）：spawn 与注册 hook 之间
   * 若已经刷过一次工具，用当前值当起点会把那次变更静默吞掉。
   */
  baseline: readonly string[];
  /**
   * 这一轮的真值（每轮 BeforeLlm 现算一次）。
   *
   * 用函数而不是快照：工具面由 `applyToolsToEntry` 在轮边界原地替换，快照在第一次刷新之后
   * 就过期了。探针抛错按「这一轮不报」处理，绝不让一条提示拖垮一轮 LLM 请求。
   */
  current: () => readonly string[];
}

/**
 * 一具 body 的工具面增量告知 hook（spawn 时注册，与 `createSelfCardDeltaHook` 同位）。
 *
 * 每个 hook 实例 = 一具 body：状态（`reported`）放在闭包里，rotate 换 body 就从新快照重新
 * 开始 —— 新 body 的工具面本来就是重算的，旧 body 的记忆在这里既没用也会误导。
 */
export function createToolSurfaceDeltaHook(options: ToolSurfaceDeltaHookOptions): Hook {
  /** 模型此刻相信的工具面（初始 = spawn 快照）；每注入一次就推进到当前集合。 */
  let reported: readonly string[] = options.baseline;
  return {
    name: TOOL_SURFACE_DELTA_HOOK,
    type: BEFORE_LLM,
    async run(ctx): Promise<void> {
      let current: readonly string[];
      try {
        current = options.current();
      } catch {
        return;
      }
      const change = diffToolSurface(reported, current);
      if (isEmptyToolSurfaceChange(change)) return;
      // 先推进再注入：同一批变更在**同一 run 的后续 LLM 请求**里（tool-calling loop 每轮都
      // 跑一次 BeforeLlm）也会被 diff 挡掉，不需要另存一份「已报签名」。
      reported = sortedNames(current);
      const message: Message = {
        role: 'user',
        name: TOOL_SURFACE_DELTA_MESSAGE_NAME,
        content: formatToolSurfaceDelta(change),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
    },
  };
}
