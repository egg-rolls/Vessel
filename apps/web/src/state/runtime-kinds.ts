/**
 * runtime 上下文消息（role 'user', name 'vessel:*'）的**纯函数那一半**：kind 词表、
 * 前缀口径、kind → 可见性查表。
 *
 * 为什么单独成文件（0.54，order-bug）：这些函数被纯计算与门禁脚本
 * （`scripts/check-order-clump.ts`、`domains/chat/transcript-items.ts` 的调用点）用到，
 * 而根 `tsconfig.json` 的 `lib` 只有 `["ES2022"]`（**没有 DOM**）。React 绑定那一半
 * （`./runtime-visibility` 的 `useRuntimeVisibility`）链条上会拉到 `./useResource`
 * （用 `window.setInterval` / `document.visibilityState`），一旦被脚本 import 就把 DOM
 * 代码第一次拖进根 typecheck 的图。所以：**本文件不许 import react / zustand / store /
 * useResource / 任何 .tsx**；React 侧只允许反过来依赖本文件。
 *
 * kind 语义（用户裁决，0.51，细节见 `./runtime-visibility` 与 `domains/chat/env-notice.ts`）：
 * - `notice`：**默认可见**，渲染成环境信息卡（`ENV_MESSAGE_KINDS`）；
 * - `source`：**默认可见**，同样渲染成环境信息卡（scope「来源」，用户裁定 q-from-card：
 *   投射来源 principal/node/team，原文保留可查；被 agent 卡吸收的折叠路径不变）；
 * - `subscription`：历史 kind，0.52 起没有生产者，可见性仍跟随 `ui.showInternalEvents`；
 * - 其余 kind（`limit` / `compaction` / `other`）同样跟随总开关。
 */

export const RUNTIME_MESSAGE_KINDS = [
  'source',
  'notice',
  'subscription',
  'limit',
  'compaction',
  'other',
] as const;

export type RuntimeMessageKind = (typeof RUNTIME_MESSAGE_KINDS)[number];

/** kind → 是否可见；形状保持不变，调用点仍按 kind 查表。 */
export type RuntimeVisibility = Record<RuntimeMessageKind, boolean>;

export function isRuntimeMessageKind(value: string): value is RuntimeMessageKind {
  return (RUNTIME_MESSAGE_KINDS as readonly string[]).includes(value);
}

/**
 * 「环境信息」种类：默认以**卡片**出现，不跟随 `ui.showInternalEvents`。
 *
 * 词表与 `domains/chat/env-notice.ts` 的 `ENV_NOTICE_KIND` / `ENV_SOURCE_KIND` 是同一件事
 * （那边是渲染侧解析的权威：`notice` 走 `envNoticeCard`，`source` 走 `sourceNoticeCard`，
 * 统一入口 `runtimeEnvCard`）。这里放开两个：
 * - `vessel:notice` 是模型上下文里「给用户看的环境事实」——热应用结果（config / permission /
 *   tools / mcp / update / peer）、inbox 条数提示、成员身份变更、订阅文件变更（scope `files`）
 *   都写在这条消息里；
 * - `vessel:source` 是投射来源（`<from location="principal@node:team" />`）：用户裁定它按
 *   环境信息卡（scope「来源」）呈现，不再跟随总开关藏起来。被 agent 卡吸收的折叠路径
 *   （单一表示）不受影响。
 * 老通道 `vessel:subscription` **不**在这里（历史消息仍跟随总开关）。
 */
export const ENV_MESSAGE_KINDS: readonly RuntimeMessageKind[] = ['notice', 'source'];

/** 这个 kind 是否属于「环境信息」（默认可见、渲染成卡片）。 */
export function isEnvMessageKind(kind: RuntimeMessageKind): boolean {
  return ENV_MESSAGE_KINDS.includes(kind);
}

/**
 * 总开关 → 六类 kind 的可见性。
 *
 * 环境信息（`ENV_MESSAGE_KINDS`）**恒为 true**：它的暴露方式是卡片，不是「打开系统
 * 信息」；开关只决定其余 kind 与底层原始事件行。其余 kind 仍然全显 / 全隐。
 */
export function runtimeVisibilityFor(showSystem: boolean): RuntimeVisibility {
  const shown = showSystem === true;
  return Object.fromEntries(
    RUNTIME_MESSAGE_KINDS.map((kind) => [kind, shown || isEnvMessageKind(kind)]),
  ) as RuntimeVisibility;
}

const PREFIX = 'vessel:';

/** 'vessel:source' → 'source'；未知 vessel:* → 'other'；其它 → undefined。 */
export function runtimeMessageKind(message: { name?: string }): RuntimeMessageKind | undefined {
  const name = message.name;
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) return undefined;
  const suffix = name.slice(PREFIX.length);
  return isRuntimeMessageKind(suffix) ? suffix : 'other';
}

export function targetKind(target: RuntimeMessageKind | string): RuntimeMessageKind | undefined {
  if (isRuntimeMessageKind(target)) return target;
  return runtimeMessageKind({ name: target });
}

/** Unknown / non-runtime messages are always visible; runtime kinds follow the setting. */
export function isRuntimeMessageVisible(
  visibility: RuntimeVisibility,
  target: RuntimeMessageKind | string,
): boolean {
  const kind = targetKind(target);
  return kind === undefined || visibility[kind];
}
