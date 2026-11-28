/**
 * 消息块类型注册表（块 P0 渲染统一，architecture-block-bootstrap-design §2.3/§2.6）。
 *
 * **形态照抄 `components/link-enhancers.ts`**（外部 Map + version + useSyncExternalStore）：
 * 注册/注销即热更新，组件订阅 version 重渲染；不另造第二套注册机制。
 *
 * 一张表收编所有「消息正文里的结构化块」：
 * - 宿主原生 type（quote / session-ref / image / file / notice）启动即注册（见 lift-blocks.ts）；
 * - 插件贡献 type 经 composer-extensions 既有桥映射为 `x:<pluginId>:<scheme>` 进同一张表
 *   （inline 表面；正文内渲染仍走 link-enhancers 查表，这里只登记治理身份，不重复渲染）。
 *
 * 未知 type 一律原文渲染：lift 不认识的正文留在 body，消费点照常走 Markdown/纯文本。
 * 纯注册机制，无 React 组件依赖；lift 管线与宿主注册在 lift-blocks.ts。
 */

import type { Message } from '../../gateway/types';
import { type ComponentType, useSyncExternalStore } from 'react';

/** 块的渲染表面档位：静态卡（CardShell）/ 正文内 inline / 气泡附属轻量块。 */
export type BlockSurface = 'card' | 'inline' | 'light';

/** lift 的输入：整条消息 + 当前剩余正文（前序块可能已剥掉外层信封）。 */
export interface LiftInput {
  message: Message;
  /** 当前待解析正文（初始 = message.content；quote 剥信封后传给后续 lift）。 */
  body: string;
}

/** lift 的上下文：只给解析要用的事实，不给渲染回调。 */
export interface LiftCtx {
  /**
   * 历史窗口（无 id 旧 quote 信封按 snippet 回查定位用；与 Transcript 的
   * quoteTargets 同一来源）。流式消费点没有窗口 ⇒ 缺省，旧信封只渲染不跳转。
   */
  messages?: readonly Message[];
}

/** 一个被提升出来的块：payload 给组件；body 覆写 = 该块消费掉的正文之外的剩余。 */
export interface LiftedBlock<P = unknown> {
  type: string;
  payload: P;
  /**
   * 该块消费正文后剩余的 body（quote/session-ref 剥信封、image/notice 整条成卡 ⇒ ''）。
   * 缺省 = 不动正文（file refs chip：结构化字段，不占正文）。
   */
  body?: string;
}

/** 块组件的渲染上下文：消费点注入的交互（跳转等），组件不自己取 store。 */
export interface BlockRenderCtx {
  /** quote 跳转到原消息（定位不到时消费点不传 ⇒ 块只渲染不跳）。 */
  onJumpQuote?: (messageId: string) => void;
  className?: string;
}

export interface BlockProps<P = unknown> {
  payload: P;
  render: BlockRenderCtx;
}

/** 一个块类型的完整声明。 */
export interface BlockTypeSpec<P = unknown> {
  /** 宿主原生名（quote…）或插件命名空间 `x:<pluginId>:<scheme>`。 */
  type: string;
  surface: BlockSurface;
  /**
   * 从消息/剩余正文里认出本类型的块；认不出返回 []（正文原样留给后续/原文渲染）。
   * **流式硬约束**：信封未收全必须返回 []（不提升半截信封，否则流式闪烁回归）。
   */
  lift: (input: LiftInput, ctx: LiftCtx) => readonly LiftedBlock<P>[];
  component: ComponentType<BlockProps<P>>;
  /** 组装回 wire 文本（只有文本信封类有；refs 类结构化字段不需要）。签名各异，表内擦除。 */
  // biome-ignore lint/suspicious/noExplicitAny: 与 specs Map 同一判据：出入口由调用方保证
  compose?: (...args: any[]) => string;
  /** 渲染/lift 顺序（小者在前）：quote 最前 → session-ref → image/notice → file → body。 */
  order: number;
  /** 注册来源（宿主 = 'host'；插件 = pluginId），注销按它整组撤。 */
  owner: string;
}

// 外部 store：与 link-enhancers 同形（Map + version + listeners）。
// biome-ignore lint/suspicious/noExplicitAny: 异构 payload 的类型擦除只发生在表内，出入口都有泛型约束
const specs = new Map<string, BlockTypeSpec<any>>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** 注册（同 type 后注册者胜，与 link-enhancers 同口径）。 */
export function registerBlockType<P>(spec: BlockTypeSpec<P>): void {
  specs.set(spec.type, spec);
  notify();
}

/** 按来源整组注销（插件禁用/热更新即撤；宿主原生不注销）。 */
export function unregisterBlockTypes(owner: string): void {
  let changed = false;
  for (const [type, spec] of [...specs]) {
    if (spec.owner === owner) {
      specs.delete(type);
      changed = true;
    }
  }
  if (changed) notify();
}

/** 查一个 type（不订阅；lift 管线用）。未知 ⇒ undefined ⇒ 原文渲染。 */
export function getBlockType(type: string): BlockTypeSpec | undefined {
  return specs.get(type);
}

/** 全部已注册 type，按 order 升序（同 order 按注册序，Map 保序）。 */
export function blockTypesInOrder(): readonly BlockTypeSpec[] {
  return [...specs.values()].sort((a, b) => a.order - b.order);
}

/** 订阅注册变化后查一个 type（渲染消费点用；形态同 useLinkEnhancer）。 */
export function useBlockType(type: string): BlockTypeSpec | undefined {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return specs.get(type);
}
