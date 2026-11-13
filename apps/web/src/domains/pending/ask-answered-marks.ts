/**
 * 本端「刚刚提交过」的题号 —— 提交动作发出就先记下，服务端的逐题进度
 * （answeredQuestionIds）回来之前也认这几题已经答过。
 *
 * 为什么要这一层：提交成功后 hook 只是发起一次 hydrate（不等返回），
 * pending 里那条请求的 answeredQuestionIds 要等一次 RPC 才更新。中间这段窗口用户
 * 完全来得及再点一次提交 —— 用户实测的「提交之后卡片依然显示那个已经回答的问题，
 * 导致能回答两次」就是这段窗口。服务端幂等是最后一道闸（重复提交只当 skipped），
 * 但界面不该主动递刀。
 *
 * 自愈：标记带一个短 TTL。提交真的失败（传输层抖动）时，服务端进度永远不会覆盖它，
 * TTL 到了自动解锁，不会把一道没答过的题永久锁死；提交成功时服务端进度很快覆盖，
 * 标记随之变成冗余并被回收。
 *
 * @module web/domains/pending/ask-answered-marks
 */

/** 标记的存活时间：够挡住手快连点，又短到失败时不会真把题锁住。 */
export const ASK_ANSWERED_MARK_TTL_MS = 4000;

interface Mark {
  readonly ids: Set<string>;
  readonly timer: ReturnType<typeof setTimeout>;
}

const MARKS = new Map<string, Mark>();

function drop(requestId: string): void {
  const mark = MARKS.get(requestId);
  if (mark === undefined) return;
  clearTimeout(mark.timer);
  MARKS.delete(requestId);
}

/** 提交动作发出时调用：这几题从现在起视为已答（不进载荷、界面上锁）。 */
export function markAskAnswered(
  requestId: string,
  questionIds: readonly string[],
  ttlMs: number = ASK_ANSWERED_MARK_TTL_MS,
): void {
  const ids = questionIds.filter((id) => id.length > 0);
  if (ids.length === 0) return;
  drop(requestId);
  const merged = new Set(ids);
  const timer = setTimeout(() => {
    // 只有没被覆盖的标记才会活到这一刻（服务端进度覆盖后会走 reconcile 提前回收）。
    MARKS.delete(requestId);
  }, ttlMs);
  // Node / 浏览器都可能让定时器持有句柄：别让它阻止进程退出（测试里尤其明显）。
  (timer as unknown as { unref?: () => void }).unref?.();
  MARKS.set(requestId, { ids: merged, timer });
}

/** 本端刚提交过的题号（渲染判定用）。 */
export function askAnsweredMarksOf(requestId: string): readonly string[] {
  return [...(MARKS.get(requestId)?.ids ?? [])];
}

/**
 * 服务端进度已经覆盖的标记可以收工了；顺带把整条请求的标记丢掉（请求已落定）。
 */
export function reconcileAskAnsweredMarks(
  requestId: string,
  serverAnsweredIds: readonly string[] | undefined,
): void {
  const mark = MARKS.get(requestId);
  if (mark === undefined) return;
  if (serverAnsweredIds === undefined) return;
  for (const id of serverAnsweredIds) mark.ids.delete(id);
  if (mark.ids.size === 0) drop(requestId);
}

/** 清掉标记（测试 / 请求已经不用再管了）。 */
export function clearAskAnsweredMarks(requestId?: string): void {
  if (requestId === undefined) {
    for (const id of [...MARKS.keys()]) drop(id);
    return;
  }
  drop(requestId);
}
