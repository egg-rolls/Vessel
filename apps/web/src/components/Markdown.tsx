// biome-ignore-all lint/suspicious/noArrayIndexKey: parsed markdown is immutable per render; index keys are stable
import { Fragment, memo, type ReactNode, useMemo, useRef } from 'react';
import { t } from '../i18n';
import { useLinkEnhancer } from './link-enhancers';
import {
  type InlineNode,
  isSafeHref,
  type MarkdownBlock,
  parseInline,
  parseMarkdown,
  parseMarkdownStreaming,
  type StreamingParseCache,
} from './markdown-parse';
import { IconButton } from './Tooltip';
import { cn, Icon, useMessageCopy } from './ui';
import { useTypewriterText } from './ui/useTypewriterText';

/**
 * link 渲染三档（file-ref-ux A6/A9）：
 * 1. 命中插件 link 增强器（scheme 声明式注册）⇒ 插件卡片；
 * 2. 通用安全 scheme（http/https/mailto/锚点/相对）⇒ 既有 `<a target=_blank>`；
 * 3. 未知 scheme（含无增强器的 vessel-ref）⇒ 不可点击文本，名称+目标可见
 *    （通用 markdown 兜底，不是引用功能残留；绝不导航）。
 */
function LinkInline({ href, text }: { href: string; text: string }): ReactNode {
  const enhancer = useLinkEnhancer(href);
  if (enhancer !== undefined) {
    const Card = enhancer.component;
    return <Card href={href} text={text} host={enhancer.host} />;
  }
  if (isSafeHref(href)) {
    return (
      <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noreferrer noopener">
        {text}
      </a>
    );
  }
  return (
    <span className="markdown-link-plain">
      {text} ({href})
    </span>
  );
}

function Inline({ nodes }: { nodes: InlineNode[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'code':
        return (
          <code className="rounded-xs bg-sunken px-1 py-px font-mono text-md" key={index}>
            {node.text}
          </code>
        );
      case 'strong':
        return <strong key={index}>{node.text}</strong>;
      case 'em':
        return <em key={index}>{node.text}</em>;
      case 'link':
        return <LinkInline key={index} href={node.href} text={node.text} />;
      default:
        return <Fragment key={index}>{node.text}</Fragment>;
    }
  });
}

/** 流式光标（motion.css `.stream-caret` + 既有 pulse-soft 脉冲）：纯装饰，aria-hidden。
 *  只挂在尾块内联尾部（流式平滑化 D）；收字结束 streaming=false 即不再渲染。 */
function StreamCaret(): ReactNode {
  return <span className="stream-caret pulse-soft" aria-hidden="true" />;
}

/**
 * 块级复制按钮（q-message-toolbar，用户提案）：代码块 / 表格**右上角内嵌**，
 * hover 块时浮现（absolute 在块内部 ⇒ 不溢出、不挤占排版）。
 * - 显隐三条触发与消息工具栏同源：hover 块（命名 group，避免与外层消息 `group`
 *   串台）/ 键盘 focus-within / 触屏常显；过渡只动 opacity，reduced-motion 由
 *   base.css 全局抑制覆盖。
 * - 按钮自带浅底色 + 浅投影：压在代码首行 / 表头右上角时也读得清。
 * - 复制走既有 `useMessageCopy`（clipboard + toast），代码复制原文、表格复制
 *   重建的 markdown（见 tableToMarkdown）。
 */
function BlockCopy({
  text,
  label,
  hoverClass,
}: {
  text: string;
  label: string;
  /** 命名 group 的 hover 显现类（`group-hover/code:opacity-100` 等）。 */
  hoverClass: string;
}) {
  const copy = useMessageCopy();
  return (
    <span
      className={cn(
        'absolute right-1 top-0.5 z-10 opacity-0 transition-opacity duration-150 focus-within:opacity-100 pointer-coarse:opacity-100',
        hoverClass,
      )}
    >
      <IconButton
        label={label}
        className="size-5 rounded-md bg-surface/90 shadow-elev-1 hover:bg-surface"
        onClick={() => copy(text)}
      >
        <Icon name="copy" size={13} />
      </IconButton>
    </span>
  );
}

/**
 * 表格块 → markdown 文本（复制用）：按解析出的 header/rows 重建 `| … |` 行。
 * 单元格里内容级的 `|`（解析时已从 `\|` / 行内 code 还原）重新转义回 `\|`，
 * 粘回 markdown 仍是同一张表；粘进纯文本编辑器也是可读的管道分隔行。
 */
function tableToMarkdown(header: string[], rows: string[][]): string {
  const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|');
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  const separator = `| ${header.map(() => '---').join(' | ')} |`;
  return [line(header), separator, ...rows.map(line)].join('\n');
}

/** memo：增量解析下前缀块对象引用稳定（parseMarkdownStreaming 缓存复用），
 *  逐帧 reveal 时前缀块整棵子树跳过重渲染 —— 每帧只渲染真正变化的尾块。 */
const Block = memo(function Block({
  block,
  caret = false,
}: {
  block: MarkdownBlock;
  caret?: boolean;
}): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${Math.min(6, Math.max(1, block.level))}` as 'h1';
      return (
        <Tag>
          {renderText(block.text)}
          {caret && <StreamCaret />}
        </Tag>
      );
    }
    case 'code':
      return (
        <div className="group/code relative mb-2.5 overflow-hidden rounded-sm bg-sunken">
          {block.lang && (
            <span className="block bg-deep px-2.5 py-1 font-mono text-2xs uppercase tracking-wider text-muted">
              {block.lang}
            </span>
          )}
          <pre className="m-0 max-h-95 overflow-auto px-3 py-2.5 font-mono text-sm leading-normal whitespace-pre">
            <code>
              {block.text}
              {caret && <StreamCaret />}
            </code>
          </pre>
          {/* 复制按钮在块内部右上角（有语言头时落在语言头右端）：absolute 不挤占排版，
              pre 自己滚动时按钮不跟着滚（它是 pre 的兄弟节点）。复制的是代码原文。 */}
          <BlockCopy
            text={block.text}
            label={t('chat.code.copy')}
            hoverClass="group-hover/code:opacity-100"
          />
        </div>
      );
    case 'list': {
      // 嵌套子块渲染在 <li> 内部：子列表是独立 <ol>/<ul>，编号/ bullet 由浏览器
      // 按各自的列表重新开始（顶层 loose list 也已在 parser 里合并成单个列表）。
      const Tag = (block.ordered ? 'ol' : 'ul') as 'ol';
      return (
        <Tag className="pl-5" {...(block.start !== undefined ? { start: block.start } : {})}>
          {block.items.map((item, index) => (
            <li className="my-0.75" key={index}>
              {renderText(item.text)}
              {item.children?.map((child, childIndex) => (
                <Block key={childIndex} block={child} />
              ))}
              {caret && index === block.items.length - 1 && <StreamCaret />}
            </li>
          ))}
        </Tag>
      );
    }
    case 'blockquote':
      return (
        <blockquote className="py-0.5 pl-2.5 text-muted">
          {renderText(block.text)}
          {caret && <StreamCaret />}
        </blockquote>
      );
    case 'table':
      return (
        // 外层壳负责「右上角内嵌复制按钮」的定位（relative + 命名 group）：宽度跟表格
        // （w-fit）但不超过列宽（max-w-full）；滚动层在里层，按钮是滚动层的兄弟节点 ⇒
        // 横向滚动表格时按钮钉在右上角不跟着滚，也不溢出（q-message-toolbar）。
        <div className="group/table relative w-fit max-w-full">
          <div className="max-w-full overflow-x-auto">
            <table className="border-collapse text-md">
              <thead>
                <tr>
                  {block.header.map((cell, index) => (
                    <th
                      className="bg-sunken px-2.25 py-1.25 text-left align-top font-semibold text-faint"
                      key={index}
                    >
                      {renderText(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr className="hover:bg-hover" key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td className="px-2.25 py-1.25 text-left align-top" key={cellIndex}>
                        {renderText(cell)}
                        {caret &&
                          rowIndex === block.rows.length - 1 &&
                          cellIndex === row.length - 1 && <StreamCaret />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <BlockCopy
            text={tableToMarkdown(block.header, block.rows)}
            label={t('chat.table.copy')}
            hoverClass="group-hover/table:opacity-100"
          />
        </div>
      );
    case 'hr':
      return <hr className="my-3 h-px border-0 bg-line" />;
    default:
      return (
        <p>
          {renderText(block.text)}
          {caret && <StreamCaret />}
        </p>
      );
  }
});

/** 文本 → 内联节点；`\n` 渲染为换行。 */
function renderText(text: string): ReactNode {
  const lines = text.split('\n');
  return lines.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      <Inline nodes={parseInline(line)} />
    </Fragment>
  ));
}

/**
 * 轻量 Markdown 渲染器：只输出 React 元素，不使用 dangerouslySetInnerHTML。
 * `className` 用于在既有容器（msg-text / text-block）上追加 markdown 样式。
 *
 * ## 流式渲染（`streaming`）
 *
 * 同一段正文在**流式期间与落盘后**用同一个组件、同一套 class 渲染，因此 run 结束那一
 * 刻只是 `streaming` 从 true 翻成 false：DOM 结构不变（都是
 * `div.markdown.msg-text > 块元素`），不重排、不闪烁。之前流式走纯文本
 * （`div.msg-text.live-text`）落盘才换成 Markdown，用户看到的就是「整段从头变成
 * 排版好的样子」。ADR-061 在 TUI 里修的是同一个 bug（流式 Markdown → 归档回退成源码）。
 *
 * 两处代价与对应的处理：
 *
 * 1. **成本**：逐帧 reveal 若每帧全量 parse，长会话（几千字）很贵。配套两件事
 *    （流式平滑化 A，用户裁定参考豆包破例修订 motion.css「禁逐 delta setState」契约）：
 *    - `useTypewriterText`：上游 50ms 合批的前缀进缓冲，rAF 按积压自适应速率匀速
 *      吐字（**不是**逐 delta setState —— 渲染节拍与到达节拍解耦）；
 *    - `parseMarkdownStreaming` 增量解析：追加只改尾块 ⇒ 每帧只重解析尾块，前缀块
 *      对象引用复用 + `memo(Block)` 跳过整棵子树。每帧成本 O(尾块) 而非 O(全文)。
 *    非流式不节流、渲染期直通（历史 / 落盘态一帧陈旧文本都不给）。
 * 2. **不完整语法**：`parseMarkdown(text, { streaming })` 容忍未闭合围栏 /
 *    强调 / 链接（正文一行不丢、不抛错）；吃在正文末尾的**半张表格**先按纯文本
 *    渲染，闭合后一次变成 <table>（见 markdown-parse.ts 的注释）。
 */
export function Markdown({
  text,
  className,
  streaming = false,
}: {
  text: string;
  className?: string;
  /**
   * 这段文本仍在流式增长。只影响节流与「未闭合块的保守降级」，
   * **不**改变渲染路径 —— 历史渲染不传，行为与之前完全一致。
   */
  streaming?: boolean;
}) {
  const settled = useTypewriterText(text, streaming);
  return <MarkdownBlocks text={settled} className={className} streaming={streaming} />;
}

/**
 * 渲染层：入参是「已提交的文本」，所以节流期间 props 完全不变。
 *
 * 拆成两个组件就是为了让 memo 真的能命中：如果把节流钩子和解析放在同一个组件里，
 * 每个 chunk 都会因为 `text` 变化而重跑一遍（memo 失效），等于没节流。
 */
const MarkdownBlocks = memo(function MarkdownBlocks({
  text,
  className,
  streaming,
}: {
  text: string;
  className?: string;
  streaming: boolean;
}) {
  // 流式增量解析缓存（每实例一份）：追加只改末两块 ⇒ 只重解析末两块，前缀块引用复用。
  const cacheRef = useRef<StreamingParseCache | null>(null);
  const blocks = useMemo(() => {
    if (!streaming) {
      cacheRef.current = null;
      return parseMarkdown(text);
    }
    const result = parseMarkdownStreaming(text, cacheRef.current);
    cacheRef.current = result.cache;
    return result.blocks;
  }, [text, streaming]);
  return (
    <div className={`markdown${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => (
        // 流式光标只给尾块（D）：内联尾部挂载，收字（streaming=false）即移除。
        <Block key={index} block={block} caret={streaming && index === blocks.length - 1} />
      ))}
    </div>
  );
});

/* 旧的分档节流（useStreamingText：<2k 逐帧 / 2k–20k 120ms / >20k 200ms）已由
 * 「useTypewriterText 缓冲 reveal + parseMarkdownStreaming 增量解析」取代（A）。
 *
 * 已知代价（沿袭旧节流，说清楚免得以后当成 bug 查）：吸附滚动（useStickyBottom）
 * 的跟随触发器是上游 followKey（事件版本 / 渲染项数），而 reveal 把「DOM 长高」
 * 推迟到 rAF 落地：连续流式时下一批事件会把视图再贴一次底，但流停下来的那一次
 * 提交之后没有新事件，尾部几行可能短暂停在视口下方，直到终态刷新才贴底。
 * 正确做法是让跟随也认「可见文本长度」（probe 报告提案 E，未立项），不是去掉 reveal。 */
