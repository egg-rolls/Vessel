/**
 * @vessel-agent/doc-subscription - edit/write/read 自动订阅（蜂群 Phase 1 第二重保险 + line-level 阅读订阅）
 * @module @vessel-agent/doc-subscription/auto-sub
 *
 * AfterTool hook（host 侧）：edit/write 尝试后把所改文件自动加入**调用者 session** 的订阅；
 * read 成功后把所读行范围记为 read 引用（line-level）。他人再改该文件 → 自己下个 run 边界
 * 收到 files 卡（read 订阅可带范围 diff 明细行）→ inspect diff → 适配（研究草案 §3.5）。
 *
 * - **attempt-based**（edit/write）：业务错误（edit 未匹配 / write EEXIST）也订阅——尝试改 X = 关心 X；
 *   AfterTool 不带结果文本（tool-calling-loop.ts:667-672），无法区分业务成功，既有面零新管道。
 * - **read 分支自然成功近似**：clamp/offset/limit 校验天然滤掉失败 read（readSubscribePath，tool.ts），
 *   ≈ 仅成功订阅，零新回执管道。
 * - **subscribe:false opt-out**（edit/write/read，用户已批）：自信一次成型 / 一次性查看可跳过订阅省 token。
 * - **基线抑制**：订阅时把当前观察记为 notified_rev，自己刚做的改动不出卡，
 *   只有他人再改（rev 不同）才通知（autoSubscribePath / readSubscribePath，tool.ts）。
 * - **覆盖两条执行路**：hook 在 host 侧跑，与 handler 在 in-process 还是 engine worker 无关。
 * - **best-effort**：任何失败静默，不得打断工具流。
 * - 相对路径按成员实际 cwd 归一化（HookContext.cwd，P1 修洞1）；装配未填时回退 config.cwd（现状）。
 * - 感知只在 run 边界（BeforeLlm 注入，append-only 铁律）；本 hook 不注入任何消息。
 */

import type { Hook, HookContext } from '@vessel-agent/core';
import { autoSubscribePath, readSubscribePath, type SubscribeToolDeps } from './tool.js';

/** 注册名（幂等注册用） */
export const AUTO_SUBSCRIBE_HOOK = 'doc-subscription-auto';

/** 创建 edit/write/read 自动订阅 hook（AfterTool，host 侧；同一注册不新增 hook） */
export function createAutoSubscribeHook(deps: SubscribeToolDeps): Hook {
  return {
    name: AUTO_SUBSCRIBE_HOOK,
    // 与 BeforeLlm hook 同口径：字面量 + Hook['type'] 保类型一致，不做 core 运行时值导入
    type: 'after_tool' as Hook['type'],
    run: async (ctx: HookContext): Promise<void> => {
      const input = ctx.input;
      if (typeof input !== 'object' || input === null) return;
      const record = input as Record<string, unknown>;
      // opt-out 对 edit/write/read 同口径（用户已批）：缺省自动订阅，显式 false 跳过。
      if (record.subscribe === false) return;
      if (ctx.tool === 'read') {
        try {
          await readSubscribePath(deps, ctx.session_id ?? 'default', record, ctx.cwd, ctx.agent_id);
        } catch {
          // best-effort：自动订阅失败不得影响工具流
        }
        return;
      }
      if (ctx.tool !== 'edit' && ctx.tool !== 'write') return;
      const rawPath = typeof record.path === 'string' ? record.path : '';
      if (rawPath.trim() === '') return;
      try {
        await autoSubscribePath(deps, ctx.session_id ?? 'default', rawPath, {
          tool: ctx.tool,
          member_id: ctx.agent_id,
          cwd: ctx.cwd,
        });
      } catch {
        // best-effort：自动订阅失败不得影响工具流
      }
    },
  };
}
