/**
 * 消息内容表面（q-tool-card-slot P2，设计稿 §2.5）：**块区 + 剩余正文**的统一渲染半。
 *
 * 一个切分器、一个块管线、一个内容插槽、三侧同形 —— 本组件是「渲染半」的落点：
 * 消费点先过**唯一** lift 入口 `liftBlocks`（消息侧 / 工具卡插槽伪消息 / live 段同一
 * 管线），把结果喂进来；这里按 role 选正文渲染器（user ⇒ InlineText 纯文本 + 内联
 * chip，assistant ⇒ Markdown），块区一律 MessageBlocks（block-registry 查表）。
 * **不合并 Markdown 与切分器**（两层职责不同：segmentByKnownSchemes 管原子 token
 * 分段，Markdown 管助手正文语法）。
 *
 * 为什么 lift 留在消费点而不在本组件内调用：block-views（注册表适配层）import
 * ToolResultCard，ToolResultCard 若 import 本组件而本组件 import lift-blocks，会形成
 * lift-blocks ↔ block-views 的模块初始化环（lift-blocks 启动注册读 blockViews 常量）。
 * lift 结果作 props 传入 ⇒ 本组件只依赖 block-views / InlineText / Markdown，环断。
 * 管线唯一性不变：所有消费点仍只调 liftBlocks，零第二套解析。
 *
 * 消费点：Transcript 消息体（user 气泡 / assistant 无卡路径）、ToolResultCard 插槽、
 * AssistantText / UserBubble（live 侧，SubagentTranscript 经 RunItems 同路）。
 * 思考卡交错渲染（块 → 思考 → 正文）的历史分支不能整段套本组件，仍手动摆块与正文。
 */
import type { ReactNode } from 'react';
import { Markdown } from '../../components/Markdown';
import type { MessageRole } from '../../gateway/types';
import type { BlockRenderCtx } from './block-registry';
import { MessageBlocks } from './block-views';
import { InlineText } from './InlineText';
import type { LiftBlocksResult } from './lift-blocks';

export function MessageContentSurface({
  lifted,
  messageRole,
  render,
  streaming = false,
  bodyClassName,
  wrapBody,
}: {
  /** liftBlocks 的结果（消费点用同一入口算好；伪消息与真消息同形）。 */
  lifted: LiftBlocksResult;
  /** 正文渲染器档位：user ⇒ InlineText（纯文本气泡），其余 ⇒ Markdown。
   * 不叫 role：JSX 上 role 会被当 ARIA 属性（biome useValidAriaRole）。 */
  messageRole: MessageRole;
  /** 块渲染上下文（quote 跳转等），透传 MessageBlocks。 */
  render?: BlockRenderCtx;
  /** assistant 正文流式口径（未闭合围栏 / 半张表格的保守降级），透传 Markdown。 */
  streaming?: boolean;
  /** assistant 正文 class（如 msg-text）。 */
  bodyClassName?: string;
  /**
   * 正文外包（user 气泡 + 折叠）：块区始终在包外（气泡上方），正文在包内。
   * 缺省 = 不包（插槽 / 助手正文无底色气泡）。
   */
  wrapBody?: (body: ReactNode) => ReactNode;
}) {
  const { blocks, body, inline } = lifted;
  const isUser = messageRole === 'user';
  // 空气泡判据（与 Transcript / UserBubble 既有口径逐字一致）：正文非空 ∨ 有剩余
  // refs（尾部 chip 行也要有承载）。助手侧只看正文（无 refs chip 行）。
  const hasBody = isUser ? body.length > 0 || (inline?.refs.length ?? 0) > 0 : body.length > 0;
  let bodyNode: ReactNode = null;
  if (hasBody) {
    bodyNode = isUser ? (
      <InlineText text={body} match={inline} />
    ) : (
      <Markdown className={bodyClassName} text={body} streaming={streaming} />
    );
    if (wrapBody !== undefined) bodyNode = wrapBody(bodyNode);
  }
  return (
    <>
      <MessageBlocks blocks={blocks} render={render} />
      {bodyNode}
    </>
  );
}
