import { type SetStateAction, useCallback, useState } from 'react';
import type { Route } from '../../app/router';
import { useToast } from '../../components/ToastProvider';
import type { GatewayClient } from '../../gateway/client';
import type { NodeView } from '../../gateway/NodeProvider';
import type { TeamControl } from '../../gateway/team-control';
import type { MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import {
  chatDraftKey,
  MAX_COMPOSER_REFS,
  useComposerDraftStore,
  useComposerDraftText,
  useComposerRefs,
} from '../../stores/composerDraftStore';
import type { SessionLoadOptions } from '../../stores/sessionStore';
import { ATTACH_PATH_MAX } from './attach-paths';
import { errorMessage } from './errors';
import { type StartInNewAgentResult, startInNewAgent } from './new-session';
import { pendingSends } from './pending-sends';
import { refsErrorText } from './refs-error';

/** 两组引用是否同序同内容（只有 `path` / `kind` 参与比较，展示值不参与）。 */
function sameRefs(left: readonly MessageRef[], right: readonly MessageRef[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((ref, index) => {
    const other = right[index];
    return other !== undefined && other.path === ref.path && other.kind === ref.kind;
  });
}

export interface UseChatSubmitOptions {
  client: GatewayClient;
  connected: boolean;
  selectedId: string | null;
  epoch: number;
  navigate: (route: Route) => void;
  loadSessions: (client: GatewayClient, options?: SessionLoadOptions) => Promise<void>;
  loadRoster: (
    nodes: readonly NodeView[],
    teamControl: (node: NodeView) => TeamControl,
  ) => Promise<void>;
  nodes: readonly NodeView[];
  teamControl: (node: NodeView) => TeamControl;
  pendingNewSessions: { current: Set<string> };
}

/**
 * 提交 / 中断：输入框状态、发送受理、取消与终态清理。
 *
 * **排队态不在这里**（0.53）：待处理条带直接读 `agents.inbox`（服务端持久真相），
 * 客户端内存里不再有 `queuedRuns`、不再轮询 `runs.get` 拿队列位置 —— 刷新 / 切会话
 * 都不会丢，也不需要「事件流接管后移除占位卡片」这类对账。这里只保留一个受理序号
 * （`sendTick`，发送即贴底用）与「已排队」toast。
 */
export function useChatSubmit({
  client,
  connected,
  selectedId,
  epoch,
  navigate,
  loadSessions,
  loadRoster,
  nodes,
  teamControl,
  pendingNewSessions,
}: UseChatSubmitOptions) {
  const toast = useToast();
  /** 草稿按会话分槽（`chat:new` = 草稿态）：切到别的会话再回来，正文还在。 */
  const draftKey = chatDraftKey(selectedId);
  const input = useComposerDraftText(draftKey);
  /** 待发送的附件引用（只有路径；与草稿同槽、同生命周期）。 */
  const refs = useComposerRefs(draftKey);
  const setRefs = useComposerDraftStore((state) => state.setRefs);
  const writeDraft = useComposerDraftStore((state) => state.setText);
  // 读和写共用 `chatDraftKey`：key 只由「当前会话」决定，不再看 `window.location.hash`。
  // 早先写入按实时 hash 定位（为了 edit / 重发回填），于是 `navigate()` 与 `hashchange`
  // 之间那一拍写下的字会落到另一个槽，用户看到的输入框与真实存的槽不是同一个。
  // 需要「写到即将切换过去的会话」的调用方（sessions.create 的 edit / 重发）显式用
  // `setInputForSession`，key 依旧只由 `chatDraftKey` 决定。
  const setInputForSession = useCallback(
    (sessionId: string | null, value: SetStateAction<string>) => {
      writeDraft(chatDraftKey(sessionId), value);
    },
    [writeDraft],
  );
  const setInput = useCallback(
    (value: SetStateAction<string>) => writeDraft(draftKey, value),
    [writeDraft, draftKey],
  );
  const [submitting, setSubmitting] = useState(false);
  /**
   * 「发送即贴底」序号：每受理一次发送自增（含 queued / held 的排队情况），
   * 页面把它传给 `useStickyBottom({ sendTick })` → 立即贴底并继续跟随。
   * 只是一个计数器，不参与提交语义。
   */
  const [sendTick, setSendTick] = useState(0);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [cancelledJobs, setCancelledJobs] = useState<Set<string>>(new Set());

  /**
   * 提交一段文本（发送与重试共用）：草稿态建新 agent，已有会话按 session 投递。
   * `sessionIdOverride` 用于 edit / retry：新 session 已由 `sessions.create` 建好，
   * 但当前路由还没切过去，不能依赖 `selectedId`。
   * 返回是否成功发起，供调用方决定是否给出「已重新发起」之类反馈。
   */
  const submitText = async (
    raw: string,
    sessionIdOverride?: string,
    refsOverride?: readonly MessageRef[],
    pendingId?: string,
  ): Promise<boolean> => {
    const text = raw.trim();
    if (!text || submitting || !connected) return false;
    // 引用在 await 之前快照：发送期间用户可能又加了一条，那一条不该被这次发送带走。
    const submittedRefs = refsOverride ?? [];
    const submitRefs = submittedRefs.length > 0 ? submittedRefs : undefined;
    // 源槽在 await 之前取：发送期间用户可能已经切走会话。
    // key 与读取同源（`chatDraftKey`）：普通发送 = 当前会话；edit / 重试的正文是
    // `setInputForSession(nextSessionId, …)` 回填到目标会话槽的，清空的也是那一槽。
    const sourceKey = chatDraftKey(sessionIdOverride ?? selectedId);
    // 0.28（CONTRACT §3）：草稿态 = 一个新 agent。先 `agents.create`（只给客户端生成的
    // 唯一名）拿 `{id, session_id}`，再 `runs.start{agent_id}`；`runs.start` 失败时
    // best-effort 回收，不留空 agent。选中已有会话时按 session 投递，行为不变。
    const targetSessionId = sessionIdOverride ?? selectedId;
    setSubmitting(true);
    // 受理即贴底：不等 runs.start 往返、也不等新内容落地（排队 / held 同样贴底）。
    // 受理后的失败只会留下「已在底部」这个无害状态，不需要回滚。
    setSendTick((value) => value + 1);
    // 0.56 乐观渲染：**点击的这一帧**就把灰态气泡画出来。
    //
    // 在此之前 chat 只有「等服务端回显」一条路，而回显排在 body spawn 与
    // `loadStoredHistory` 之后 —— 重启后那两段加起来是秒级到几十秒，用户看到的就是
    // 「输入框清空了、消息列表里什么都没有」。这条 pending 与 `runs.start` **同时**发出，
    // 不等它返回；返回后再把 `run_id` 挂上来（回显的首选合并键，见 pending-sends.ts）。
    //
    // 重试走 `pendingId`：复用同一个 id，不新开第二条气泡（`reuseId`）。
    const pendingKey = pendingSends.create({
      sessionId: targetSessionId ?? null,
      text,
      ...(submitRefs !== undefined ? { refs: submitRefs } : {}),
      ...(pendingId !== undefined ? { reuseId: pendingId } : {}),
    });
    try {
      let nextSessionId: string | undefined;
      let run: StartInNewAgentResult['run'];
      if (targetSessionId) {
        run = await client.submitRun(text, targetSessionId, undefined, submitRefs);
        nextSessionId = targetSessionId;
      } else {
        const started = await startInNewAgent(
          {
            createAgent: (agentInput) => client.createAgent(agentInput),
            closeAgent: (agentId) => client.closeAgent(agentId),
          },
          (agentInput, sessionId, agentId) =>
            client.submitRun(agentInput, sessionId, agentId, submitRefs),
          text,
          submitRefs,
        );
        run = started.run;
        nextSessionId = started.sessionId;
      }
      if (!nextSessionId) {
        // 契约要求 runs.start 回填 session_id；缺失时停下，不本地兜底。
        throw new Error('runs.start returned no session_id');
      }
      // 灰气泡的归属与合并键：草稿态到这里才知道 session id；run id 是首选合并键
      // （正文会被 guardrail 改写，不能当身份）。queued 的 run 前面还有一整轮在跑，
      // 回显本来就该晚 —— store 不让它参与 15 s 超时判定。
      pendingSends.attachSession(pendingKey, nextSessionId);
      // 0.57：`deferred` = 服务端收下了但这一轮不会起跑（draining / body 换代 / 硬错误闸），
      // **没有 run_id**（以前那个号永不执行）。挂上去只会让气泡等一个不会来的事件，
      // 所以这里分开走：记原因 + 消息 id，等「同会话 + 同一句正文」的 run.started 认领。
      if (run.status === 'deferred') {
        pendingSends.attachDeferred(pendingKey, {
          ...(run.reason !== undefined ? { reason: run.reason } : {}),
          ...(run.retry_after_ms !== undefined ? { retryAfterMs: run.retry_after_ms } : {}),
          ...(run.message_id !== undefined ? { messageId: run.message_id } : {}),
        });
      } else if (run.run_id !== undefined) {
        pendingSends.attachRun(pendingKey, run.run_id, run.status);
      } else {
        // 契约要求非 deferred 必须带 run_id；缺失时不本地编造，留在 `sending`
        //（15 s 没有回显就走失败出口，用户至少能重试 / 删除）。
      }
      // 新会话可能尚未落盘：标记后 detail 404 可容忍（会话出现在列表即失效）。
      if (!targetSessionId) pendingNewSessions.current.add(nextSessionId);
      // 只在源草稿仍是被提交的文本时清空：重试不应吞掉用户新写的草稿。
      writeDraft(sourceKey, (current) => (current.trim() === text ? '' : current));
      // 引用：只有「发送期间没被改动」才清空（发送成功后清，契约 §2.4）。
      // 用户在等待期间新加的那条不能被这次发送顺手抹掉；正文同理，所以只动 refs。
      if (submittedRefs.length > 0) {
        const current = useComposerDraftStore.getState().drafts[sourceKey]?.refs ?? [];
        if (sameRefs(current, submittedRefs)) setRefs(sourceKey, []);
      }
      if (!targetSessionId) navigate({ domain: 'chat', sessionId: nextSessionId });
      // 排队态不在客户端记账：条带读 `agents.inbox`（按 session_id 过滤），这里只给反馈。
      if (run.status === 'queued') toast.info(t('chat.toast.queued'));
      // deferred：收下了、还没有 run。给一句「不是失败」的提示 —— 消息已经在服务端队列里，
      // 用户在这里该做的是等（或去条带撤回），不是重发。
      if (run.status === 'deferred') toast.info(t('chat.toast.deferred'));
      void loadSessions(client, { epoch, force: true });
      // 新会话建了新 agent：roster（会话行的 agent 地址）要立刻反映它。
      if (!targetSessionId) void loadRoster(nodes, teamControl);
      return true;
    } catch (error) {
      // 引用被准入闸门拒掉时给一句人话（服务端 message 是英文稳定码）；
      // 其它错误保持原样展示。
      const refsRejection = submittedRefs.length > 0 ? refsErrorText(error) : null;
      toast.error(refsRejection ?? errorMessage(error));
      // 0.56（用户口径）：**发不出去就回流到待处理条带**，不回输入框。
      //
      // 0.52 的 F5 曾经在这里把正文塞回草稿槽（当时的问题是「消息被吞」）。现在的规矩变了：
      // 失败的那条在条带上带着「重试 / 编辑」出现 —— 内容仍是那条消息本身，人不会看不见它。
      // 同时**不能留着输入框里那份**：手上有草稿的人会看到同一段字出现在两个地方（输入框 +
      // 条带），而这正是本需求要根除的重复。「编辑」那颗键才是把正文送回输入框的入口。
      //
      // 清空仍然只清「还是被提交的那段字」的槽（与成功路径同一条守卫）：等待期间新写的
      // 草稿不是这条失败消息的一部分，不能顺手抹掉。
      writeDraft(sourceKey, (current) => (current.trim() === text ? '' : current));
      pendingSends.markFailed(pendingKey, refsRejection ?? errorMessage(error));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const handleSend = async () => {
    await submitText(input, undefined, refs);
  };

  /**
   * 加一条引用（供工具栏 / 文件选择用）。
   *
   * 这里只做**形状**拦截：绝对路径、长度、条数上限（只防手误）。路径边界
   *（`allowed_roots` / deny 目录）**不在这里判，也不在 `runs.start` 判**：引用
   * 是用户表达意图，拦在加引用时会把意图丢掉；权限校验发生在模型读文件那一刻
   *（`read` / `media` 的 `evaluatePath`）。`runs.start` 仍可能返回形状类的
   * `invalid_params` + `reason`，由 `refsErrorText` 变成人话。
   */
  const addRef = useCallback(
    (ref: MessageRef): boolean => {
      const where = chatDraftKey(selectedId);
      if (ref.path.length > ATTACH_PATH_MAX) {
        toast.error(t('chat.refs.reject.tooLong', { max: ATTACH_PATH_MAX }));
        return false;
      }
      if (!/^(?:[\\/]|[A-Za-z]:[\\/])/.test(ref.path)) {
        toast.error(t('chat.refs.reject.absolute', { path: ref.path }));
        return false;
      }
      const added = useComposerDraftStore.getState().addRef(where, ref);
      if (!added) toast.error(t('chat.refs.reject.tooMany', { max: MAX_COMPOSER_REFS }));
      return added;
    },
    [selectedId, toast],
  );

  /** 删一条引用：下标即 refs 里的位置（同一路径两次引用各删各的）。 */
  const removeRef = useCallback(
    (index: number) => {
      useComposerDraftStore.getState().removeRef(chatDraftKey(selectedId), index);
    },
    [selectedId],
  );

  /** 重试：把用户内容提交到指定 session（默认当前会话）。 */
  const handleRetry = async (text: string, sessionId?: string) => {
    await submitText(text, sessionId);
  };

  /**
   * 重试一条**未发送**的本地气泡（0.56 乐观渲染）：复用同一个 pending id。
   *
   * 为什么不是「再开一条 pending」：气泡是「那一句话」的替身，不是一次发送尝试的替身。
   * 重试要让它原地回到 `sending`（`usePendingSends` 已经先复位了状态），而不是在旁边
   * 再长出一条 —— 否则一次断网连点三次会出现三个一模一样的灰气泡。
   */
  const handleRetryPending = async (pending: {
    id: string;
    text: string;
    sessionId: string | null;
    refs?: readonly MessageRef[];
  }) => {
    // 断线时不要留下一个「看起来在飞、其实什么都没发」的灰气泡：`submitText` 在
    // `!connected` 时直接早退（不抛错），所以这里自己把它钉成失败态（仍可再重试）。
    if (!connected) {
      pendingSends.markFailed(pending.id, 'offline');
      return;
    }
    await submitText(pending.text, pending.sessionId ?? undefined, pending.refs, pending.id);
  };

  // 引用保持稳定：memo(RunItems) 依赖这几个回调，避免每个 token 让全部实时项重渲染。
  const handleCancel = useCallback(
    async (group: { runId: string }) => {
      // 取消只认真实 run id。`jobId` 是事件帧的 run_id，成员事件上它是成员 id，
      // 对新会话恰好等于 session id —— 用它取消会得到 not_found（F2）。
      const runId = group.runId;
      if (!runId) return;
      setCancelling((prev) => new Set(prev).add(runId));
      try {
        const result = await client.cancelRun(runId);
        if (result.cancelled) {
          setCancelledJobs((prev) => new Set(prev).add(runId));
          toast.success(t('chat.toast.cancelRequested'));
        }
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(runId);
          return next;
        });
      }
    },
    [client, toast],
  );

  return {
    input,
    setInput,
    /** 回填到指定会话的草稿槽（sessions.create 的 edit / 重发在 navigate 之后立刻用）。 */
    setInputForSession,
    submitting,
    /** 待发送的附件引用（只有路径；按会话键存，与草稿同族）。 */
    refs,
    /** 加 / 删一条引用（加的时候只拦形状，边界由 `runs.start` 闸门判）。 */
    addRef,
    removeRef,
    /** 发送受理序号（每次受理自增）：交给 `useStickyBottom({ sendTick })` 做发送即贴底。 */
    sendTick,
    cancelling,
    cancelledJobs,
    handleSend,
    handleRetry,
    /** 重试一条未发送的本地气泡（同一条 pending，不新开）。 */
    handleRetryPending,
    handleCancel,
  };
}
