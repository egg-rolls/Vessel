/**
 * async `ask_user` 的答案投放（0.52 切片）。
 *
 * 语义（用户裁决）：async 提问**投放即成功**，本次 run 不等待；答案到达后作为一条
 * **user 角色**消息进入提问成员的 inbox（`delivery: 'input'` —— resume / 起新 run 都
 * 需要一条 user 消息才能开跑），并起一次**新 run**：原来的 run 早就正常结束了。
 *
 * 为什么在 app 层：招式只有一条，就是 `AgentService.admit` —— 和「人在会话里发一句话」
 * 完全同一条准入链（inbox → mailbox → scheduler）。serve 不得依赖 `@vessel-agent/agent`，
 * 所以实现放在装配层，由 gateway 的 `askAnswerDelivery` 端口注入。
 *
 * @module vessel/ask-answer-delivery
 */

import type { AgentService } from '@vessel-agent/agent';
import type { StoredInteraction } from '../packages/serve/src/index';
import { formatAnswersForModel } from './ask-channel';

/**
 * 答案消息的正文前缀：让模型一眼看出「这是人对我那个待批提问的回答」。
 *
 * 机器可读的一半是 requestId（Web 用它把卡片和待批记录对上），人类可读的一半就是
 * `formatAnswersForModel` 那段原文 —— 同一个 formatter，注入 resume 与「投放新 run」
 * 两条路不产生第二套答案文本格式。
 */
export const ASK_ANSWER_TAG_PREFIX = '[ask_user answer ';

/** 答案正文（模型看到的 user 消息原文）。 */
export function formatAskAnswerContent(answers: unknown[], requestId: string): string {
  return `${ASK_ANSWER_TAG_PREFIX}${requestId}] ${formatAnswersForModel(answers)}`;
}

/**
 * 构造注入网关的投放实现。
 *
 * 失败（成员已关闭 / 准入被拒 / 调度拒绝）一律返回 false、只写 stderr：
 * 答案已经落盘（`interactions` 记录是事实源），RPC 不能因此失败，也不重试 ——
 * 人类在待批页还能看到并重试。
 */
export function createAskAnswerDelivery(
  service: AgentService,
): (record: StoredInteraction) => Promise<boolean> {
  return async (record: StoredInteraction): Promise<boolean> => {
    const agentId = record.agent_id;
    if (agentId === undefined || agentId === '') return false;
    const content = formatAskAnswerContent(record.answer?.answers ?? [], record.requestId);
    try {
      await service.admit({
        content,
        agent_id: agentId,
        ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
        // 0.52：答案是「成员自己提的问题」的答复，不受可见性闸门约束，
        // 并让执行内核把它标成 ask:answer（Web 渲染成待批答复卡）。
        origin: 'ask_answer',
      });
      return true;
    } catch (error) {
      console.error(
        `[vessel] async ask answer for ${record.requestId} could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };
}
