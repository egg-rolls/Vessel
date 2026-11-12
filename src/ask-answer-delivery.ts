/**
 * async `ask` 的答案投放（0.52 切片）。
 *
 * 语义（用户裁决）：async 提问**投放即成功**，本次 run 不等待；答案到达后作为一条
 * **user 角色**消息进入提问成员的 inbox（`delivery: 'input'` —— resume / 起新 run 都
 * 需要一条 user 消息才能开跑），并起一次**新 run**：原来的 run 早就正常结束了。
 *
 * 为什么在 app 层：招式只有一条，就是 `AgentService.admit` —— 和「人在会话里发一句话」
 * 完全同一条准入链（inbox → mailbox → scheduler）。serve 不得依赖 `@vessel-agent/agent`，
 * 所以实现放在装配层，由 gateway 的 `askAnswerDelivery` 端口注入。
 *
 * **同批合并**（用户反馈：「我是一起批复发过来的，结果拆分为了两个消息发回给你」）：
 * 待批页一次提交会给同簇的每个 request 各发一次 `ask.respond`，但那是**一次人类动作**。
 * 带 `batch_id` 的应答在这里按 (agent, session, batch_id) 做 250ms 短窗口合并，
 * 窗口内的答案合成**一条** user 消息 + **一次** run；没有 `batch_id` 的调用保持原样
 * （一次一条）。窗口放在进程内是安全的：同一批请求总落在同一个 gateway 进程，
 * 且待批页把这批 RPC 并发发出（不是串行 await），到达间隔是毫秒级。
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
 *
 * 0.52 起工具名是 `ask`（原名 `ask_user`）：写侧只用新前缀，但**历史消息**的正文
 * 仍以旧前缀开头，所以读侧（`apps/web/src/domains/chat/ask-answer.ts`）双认两个。
 */
export const ASK_ANSWER_TAG_PREFIX = '[ask answer ';

/** 答案正文（模型看到的 user 消息原文）。 */
export function formatAskAnswerContent(answers: unknown[], requestId: string): string {
  return `${ASK_ANSWER_TAG_PREFIX}${requestId}] ${formatAnswersForModel(answers)}`;
}

/**
 * 同批答案的正文：一条消息里带整批（同一次提交）的答案，requestId 逗号分隔。
 *
 * 每题一行、行内自带原问题摘要（见 `formatAnswersForModel`），所以模型一次读到的
 * N 条答案仍能各自对上是哪个 `ask` 请求。只有一道题时退回单条格式（字节不变）。
 */
export function formatAskAnswerBatchContent(
  items: ReadonlyArray<{ requestId: string; answers: unknown[] }>,
): string {
  if (items.length === 1) {
    const only = items[0];
    if (only !== undefined) return formatAskAnswerContent(only.answers, only.requestId);
  }
  const answers = items.flatMap((item) => item.answers);
  const ids = items.map((item) => item.requestId).join(',');
  return `${ASK_ANSWER_TAG_PREFIX}${ids}] ${formatAnswersForModel(answers, {
    requestCount: items.length,
  })}`;
}

/**
 * 同批合并窗口（ms）：第一条答案到达后等这么久，把窗口内同批的其它答案收进同一条消息。
 *
 * 250ms 足够覆盖「待批页并发发出的几个 `ask.respond`」的到达抖动（本机 / 回环是毫秒级，
 * 局域网也在几十毫秒内），又短到人类察觉不到答案延迟。窗口之后才到的答案只会退化成
 * 今天的表现（自己一条消息），不丢答案。
 */
export const ASK_ANSWER_BATCH_WINDOW_MS = 250;

/** 投放端口：`batchId` = 这次答案属于待批页的哪一次提交（缺省 = 单条投放，旧行为）。 */
export type AskAnswerDelivery = (
  record: StoredInteraction,
  context?: { batchId?: string },
) => Promise<boolean>;

interface BatchGroup {
  /** 去重后的记录（同一 requestId 只算一次：重投 / 重复应答不重复计入）。 */
  records: StoredInteraction[];
  /** 每个调用方各拿一个结果（`admit` 只发一次，结果广播给全部等待者）。 */
  resolvers: Array<(delivered: boolean) => void>;
}

/**
 * 合并 key：同成员 + 同会话 + 同一次提交。
 *
 * session 也是 key 的一部分 —— 待批页的一个簇可能跨会话，答案必须落回各自会话，
 * 所以只有「同成员 + 同会话 + 同一次提交」才允许合并。缺 agent_id 时无法合并。
 */
function batchKey(record: StoredInteraction, batchId: string): string | undefined {
  const agentId = record.agent_id;
  if (agentId === undefined || agentId === '') return undefined;
  return `${agentId}\u0000${record.session_id ?? ''}\u0000${batchId}`;
}

/**
 * 构造注入网关的投放实现。
 *
 * 失败（成员已关闭 / 准入被拒 / 调度拒绝）一律返回 false、只写 stderr：
 * 答案已经落盘（`interactions` 记录是事实源），RPC 不能因此失败，也不重试 ——
 * 人类在待批页还能看到并重试。
 *
 * 合并窗口内的每个调用都拿到同一个结果 promise：`admit` 只发一次（一条消息 + 一次
 * run），批次里的每个 `ask.respond` 各自等到同一个 `delivered` 布尔值；同一 requestId
 * 在窗口内被重投也不重复计入答案行（幂等）。
 */
export function createAskAnswerDelivery(service: AgentService): AskAnswerDelivery {
  const groups = new Map<string, BatchGroup>();

  const deliver = async (records: ReadonlyArray<StoredInteraction>): Promise<boolean> => {
    const first = records[0];
    if (first === undefined) return false;
    const agentId = first.agent_id;
    if (agentId === undefined || agentId === '') return false;
    try {
      const content =
        records.length === 1
          ? formatAskAnswerContent(first.answer?.answers ?? [], first.requestId)
          : formatAskAnswerBatchContent(
              records.map((record) => ({
                requestId: record.requestId,
                answers: record.answer?.answers ?? [],
              })),
            );
      await service.admit({
        content,
        agent_id: agentId,
        ...(first.session_id !== undefined ? { session_id: first.session_id } : {}),
        // 0.52：答案是「成员自己提的问题」的答复，不受可见性闸门约束，
        // 并让执行内核把它标成 ask:answer（Web 渲染成待批答复卡）。
        origin: 'ask_answer',
      });
      return true;
    } catch (error) {
      console.error(
        `[vessel] async ask answer for ${records
          .map((record) => record.requestId)
          .join(',')} could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };

  const flush = async (key: string): Promise<void> => {
    const group = groups.get(key);
    if (group === undefined) return;
    groups.delete(key);
    // 任何意外都收敛成 false：等待者必须拿到结果（否则 RPC 会挂死）。
    let delivered = false;
    try {
      delivered = await deliver(group.records);
    } catch (error) {
      console.error(
        `[vessel] async ask answer batch ${key} could not be delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    for (const resolve of group.resolvers) resolve(delivered);
  };

  return async (record: StoredInteraction, context?: { batchId?: string }): Promise<boolean> => {
    const batchId = context?.batchId;
    // 拒绝回答（answers 为空）是「人类不答」，跟别的答案混一条会把拒绝稀释成正常答案。
    const isolated = (record.answer?.answers ?? []).length === 0;
    const key =
      batchId === undefined || batchId === '' || isolated ? undefined : batchKey(record, batchId);
    if (key === undefined) return deliver([record]);
    const pending = groups.get(key);
    if (pending !== undefined) {
      // 同一 requestId 重投不重复计入答案行，但仍要给它一个结果。
      if (!pending.records.some((item) => item.requestId === record.requestId)) {
        pending.records.push(record);
      }
      return new Promise<boolean>((resolve) => {
        pending.resolvers.push(resolve);
      });
    }
    return new Promise<boolean>((resolve) => {
      // 刻意不 unref：合并窗口到点必须真的投放，进程不能因为「没有别的 handle」就
      // 提前退出把答案留在队列里（最多多活 250ms）。
      setTimeout(() => {
        void flush(key);
      }, ASK_ANSWER_BATCH_WINDOW_MS);
      groups.set(key, { records: [record], resolvers: [resolve] });
    });
  };
}
