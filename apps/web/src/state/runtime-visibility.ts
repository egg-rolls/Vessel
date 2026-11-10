/**
 * Runtime context messages (role 'user', name 'vessel:*') are model-only
 * context: message sources, runtime notices, subscription notices, budget
 * warnings, compaction markers. They are hidden from transcripts by default.
 *
 * 0.50：可见性不再是浏览器本地偏好，而是服务端配置 ui.showInternalEvents
 * （默认 false；verbosity: debug 按既有「或」语义一并放开，见 state/visibility.ts）。
 * 六类 kind 统一跟随这一个开关：Web 只保留一个显式入口
 * （Settings → Display → 显示系统信息），不再提供细粒度开关，因此也没有第二个
 * 写入路径——写操作与其他 display 键一样走 config.set。
 *
 * 旧 localStorage 键 vessel.web.runtimeContext 直接丢弃（不做迁移）：旧值是
 * 6 个细粒度布尔，无法无损映射到一个总开关，而默认值本来就是全关。
 *
 * 公开 hook / helper 的签名保持不变，transcript 调用点无需改动。
 */
import { useCallback, useMemo } from 'react';
import { useConfigStore } from '../stores/configStore';
import { resourceData } from './useResource';
import { resolveUiVisibility, showsInternalEvents } from './visibility';

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

/** 总开关 → 六类 kind：要么全显，要么全隐（不再按 kind 分档）。 */
export function runtimeVisibilityFor(showSystem: boolean): RuntimeVisibility {
  const shown = showSystem === true;
  return Object.fromEntries(
    RUNTIME_MESSAGE_KINDS.map((kind) => [kind, shown]),
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

function targetKind(target: RuntimeMessageKind | string): RuntimeMessageKind | undefined {
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
