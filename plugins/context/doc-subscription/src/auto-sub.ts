/**
 * @vessel-agent/doc-subscription - edit/write 自动订阅（蜂群 Phase 1 第二重保险）
 * @module @vessel-agent/doc-subscription/auto-sub
 *
 * AfterTool hook（host 侧）：edit/write 尝试后把所改文件自动加入**调用者 session** 的订阅。
 * 他人再改该文件 → 自己下个 run 边界收到 files 卡 → inspect diff → 适配（研究草案 §3.5）。
 *
 * - **attempt-based**：业务错误（edit 未匹配 / write EEXIST）也订阅——尝试改 X = 关心 X；
 *   AfterTool 不带结果文本（tool-calling-loop.ts:667-672），无法区分业务成功，既有面零新管道。
 * - **subscribe:false opt-out**（用户已批）：自信一次成型可跳过订阅省 token。
 * - **基线抑制**：订阅时把当前观察记为 notified_rev，自己刚做的改动不出卡，
 *   只有他人再改（rev 不同）才通知（autoSubscribePath，tool.ts）。
 * - **覆盖两条执行路**：hook 在 host 侧跑，与 handler 在 in-process 还是 engine worker 无关。
 * - **best-effort**：任何失败静默，不得打断工具流。
 * - 已知局限：相对路径按 config.cwd 解析（AfterTool 无成员 cwd）；成员 cwd 相对路径可能漏订。
 * - 感知只在 run 边界（BeforeLlm 注入，append-only 铁律）；本 hook 不注入任何消息。
 */

import type { Hook, HookContext } from '@vessel-agent/core';
import { autoSubscribePath, type SubscribeToolDeps } from './tool.js';

/** 注册名（幂等注册用） */
export const AUTO_SUBSCRIBE_HOOK = 'doc-subscription-auto';

/** 创建 edit/write 自动订阅 hook（AfterTool，host 侧） */
export function createAutoSubscribeHook(deps: SubscribeToolDeps): Hook {
  return {
    name: AUTO_SUBSCRIBE_HOOK,
    // 与 BeforeLlm hook 同口径：字面量 + Hook['type'] 保类型一致，不做 core 运行时值导入
    type: 'after_tool' as Hook['type'],
    run: async (ctx: HookContext): Promise<void> => {
      if (ctx.tool !== 'edit' && ctx.tool !== 'write') return;
      const input = ctx.input;
      if (typeof input !== 'object' || input === null) return;
      const record = input as Record<string, unknown>;
      if (record.subscribe === false) return;
      const rawPath = typeof record.path === 'string' ? record.path : '';
      if (rawPath.trim() === '') return;
      try {
        await autoSubscribePath(deps, ctx.session_id ?? 'default', rawPath);
      } catch {
        // best-effort：自动订阅失败不得影响工具流
      }
    },
  };
}
