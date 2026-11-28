/**
 * 退休会话的可见性（q-retired-session-toggle，用户裁定：默认不显示在会话卡片列表）。
 *
 * 退休会话 = rotate 之前的旧身体会话。两个判据来源（与 SessionList 第二行灰色子标题
 * 同一套事实，不另造口径）：
 * 1. 会话自带归属 `session.agent.primary === false`（0.52 additive，主路径）；
 * 2. roster `body_history` 反查（旧 gateway 回落；`sessionAgentRetiredLabels` 的键集，
 *    它已排除 live body —— 迟到的 body_history 不许把现役会话标成退休）。
 *
 * 隐藏**不是**删除：数据层（sessionStore）不动，detail / 直接 URL / 命令面板照常；
 * 搜索是显式找回意图，调用方在搜索态绕过过滤（见 useChatSessions）。
 * `ui.showRetiredSessions` 打开后列表原样回来，灰色子标题现状保留。
 *
 * 本文件只放纯函数与结构类型（分工同 `state/archive-visibility.ts`）：不 import
 * React / configStore / gateway，Node 侧探针可直接 import。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `ui.showRetiredSessions`（YAML `show_retired_sessions`）：缺失 / 非法一律 false = 隐藏。
 *
 * 兼容 `{config:{ui}}`、已解包的 config 对象与 snake_case，与
 * `archive-visibility.resolveShowArchived` 同一读取口径（同一个 config.get 快照）。
 */
export function resolveShowRetiredSessions(source: unknown): boolean {
  if (!isRecord(source)) return false;
  const config = isRecord(source.config) ? source.config : source;
  const ui = isRecord(config.ui) ? config.ui : undefined;
  const value = ui?.showRetiredSessions ?? ui?.show_retired_sessions;
  return value === true;
}

/** 过滤判据用得上的最小会话形状（SessionInfo 的结构子集）。 */
export interface RetiredSessionLike {
  session_id: string;
  agent?: { primary?: boolean };
}

/**
 * 是否退休会话。`retiredIds` 是 roster 反查档（`sessionAgentRetiredLabels` 的键集，
 * Map / Set 都收）；反查不到且自带归属缺省（旧 gateway / 别的节点）⇒ 不判退休，
 * 宁可多显示也不误藏用户历史（与 closedAgentSessions「反查不到就不标」同纪律）。
 */
export function isRetiredSession(
  session: RetiredSessionLike,
  retiredIds: { has(sessionId: string): boolean },
): boolean {
  // 自带归属是权威：现役 body 不许被滞后的 roster body_history 误藏
  // （与 sessionAgentRetiredLabels「live body 优先」同纪律）。
  if (session.agent?.primary === true) return false;
  return session.agent?.primary === false || retiredIds.has(session.session_id);
}

/** 过滤退休会话（开关打开时原顺序不动，只复制，不改入参）。 */
export function filterRetiredSessions<T extends RetiredSessionLike>(
  sessions: readonly T[],
  showRetiredSessions: boolean,
  retiredIds: { has(sessionId: string): boolean },
): T[] {
  return showRetiredSessions
    ? [...sessions]
    : sessions.filter((session) => !isRetiredSession(session, retiredIds));
}