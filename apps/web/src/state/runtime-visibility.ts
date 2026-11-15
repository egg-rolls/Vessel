/**
 * runtime 上下文消息（role 'user', name 'vessel:*'）是模型侧上下文：消息来源、
 * runtime 提示、预算告警、压缩标记（`vessel:subscription` 是 0.52 起不再生产的老通道）。
 *
 * **拆成两半（0.54，order-bug）**：
 * - 纯函数那一半（kind 词表 / `runtimeMessageKind` / `RuntimeVisibility` /
 *   `isRuntimeMessageVisible` / `runtimeVisibilityFor` …）在 `./runtime-kinds`，
 *   **零 import**；
 * - 本文件只留 React 绑定 `useRuntimeVisibility`（要 `configStore` + `useResource`，
 *   后者用 `window.setInterval` / `document.visibilityState`，只能活在带 DOM lib 的
 *   `apps/web` tsconfig 下）。
 *
 * 0.50：可见性不再是浏览器本地偏好，而是服务端配置 ui.showInternalEvents
 * （默认 false；verbosity: debug 按既有「或」语义一并放开，见 state/visibility.ts）。
 * Web 只保留一个显式入口（Settings → Display → 显示系统信息），写操作与其他
 * display 键一样走 config.set。
 *
 * **两种显示方式（用户裁决，0.51）**：环境信息（kind `notice` = `vessel:notice`）
 * 与底层系统信息是同一份上下文的两种呈现，不再是「显示 / 隐藏」的二选一：
 * - `notice`：**默认可见**，渲染成环境信息卡（scope 色条 + 一行摘要 + 可展开的
 *   details，见 `domains/chat/env-notice.ts`）。开关不再管它——否则用户永远看不到
 *   模型真实的上下文（配置热应用 / 权限 / 工具 / MCP / 更新 / peer 通知、订阅文件变更
 *   都走这条）。
 * - `subscription`：**历史 kind，0.52 起没有生产者**（doc-subscription 改为写
 *   `vessel:notice` + scope `files`）。可见性**不变**：仍跟随 `ui.showInternalEvents`，
 *   老消息按 `ENV_NOTICE_KIND` 之外的兜底路径渲成整段 notice —— 不特判成「文件变更」卡，
 *   也不让它变成裸 JSON。词留着只为让老数据的种类名还可读（调试旧 trace 时仍能看到它
 *   当初是什么）。
 * - 其余 kind（`source` 已被 A2A 卡吸收；`limit` / `compaction` / `other`）：仍跟随
 *   `ui.showInternalEvents`，与改动前一致。理由：`limit` 是 `agent.limit.warning` 的上下文
 *   副本（typed notice 已默认可见，再放一张卡就是同一事实的第二份）；`compaction` 目前
 *   没有生产者（压缩走 `message.compaction` 投影），保持预留。
 * - 底层原始事件行（`runtime.notice` 等）归 `internal` 档（`state/event-visibility.ts`
 *   的三档表）：开关打开时它们**额外**出现，身份是「事件」，与消息卡片互不重叠（一条
 *   消息一条卡，一条事件一行 raw），既不互相对打也不重复渲染同一条。
 *
 * 旧 localStorage 键 vessel.web.runtimeContext 直接丢弃（不做迁移）：旧值是
 * 6 个细粒度布尔，无法无损映射到一个总开关，而默认值本来就是全关。
 *
 * 公开 hook / helper 的签名保持不变，transcript 调用点无需改动：纯的那一半由下面这行
 * 原样再导出，既有的 `from '../../state/runtime-visibility'` 引用一个字都不用改。
 */
import { useCallback, useMemo } from 'react';
import { useConfigStore } from '../stores/configStore';
import {
  isRuntimeMessageVisible,
  type RuntimeMessageKind,
  type RuntimeVisibility,
  runtimeVisibilityFor,
} from './runtime-kinds';
import { resourceData } from './useResource';
import { resolveUiVisibility, showsInternalEvents } from './visibility';

export * from './runtime-kinds';

/**
 * React binding：Settings 用 config.set 写同一个键，会话读同一份 configStore
 * 快照，所以保存后无需刷新即生效；未连上 gateway / 未加载配置时按默认（全隐）处理。
 */
export function useRuntimeVisibility(): {
  visibility: RuntimeVisibility;
  isVisible: (target: RuntimeMessageKind | string) => boolean;
} {
  // 选择器只返回布尔：config 里其他键变化不会让会话时间线重算。
  const showSystem = useConfigStore((state) =>
    showsInternalEvents(resolveUiVisibility(resourceData(state.config))),
  );
  const visibility = useMemo(() => runtimeVisibilityFor(showSystem), [showSystem]);
  const isVisible = useCallback(
    (target: RuntimeMessageKind | string) => isRuntimeMessageVisible(visibility, target),
    [visibility],
  );
  return { visibility, isVisible };
}
