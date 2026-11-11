// biome-ignore-all lint/suspicious/noArrayIndexKey: parsed markdown is immutable per render; index keys are stable
import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type InlineNode, type MarkdownBlock, parseInline, parseMarkdown } from './markdown-parse';

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
        return (
          <a
            key={index}
            href={node.href}
            target={node.href.startsWith('#') ? undefined : '_blank'}
            rel="noreferrer noopener"
          >
            {node.text}
          </a>
        );
      default:
        return <Fragment key={index}>{node.text}</Fragment>;
    }
  });
}

function Block({ block }: { block: MarkdownBlock }): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${Math.min(6, Math.max(1, block.level))}` as 'h1';
      return <Tag>{renderText(block.text)}</Tag>;
    }
    case 'code':
      return (
        <div className="relative mb-2.5 overflow-hidden rounded-sm bg-sunken">
          {block.lang && (
            <span className="block bg-deep px-2.5 py-1 font-mono text-2xs uppercase tracking-wider text-muted">
              {block.lang}
            </span>
          )}
          <pre className="m-0 max-h-95 overflow-auto px-3 py-2.5 font-mono text-sm leading-normal whitespace-pre">
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case 'list':
      return block.ordered ? (
        <ol className="pl-5">
          {block.items.map((item, index) => (
            <li className="my-0.75" key={index}>
              {renderText(item)}
            </li>
          ))}
        </ol>
      ) : (
        <ul className="pl-5">
          {block.items.map((item, index) => (
            <li className="my-0.75" key={index}>
              {renderText(item)}
            </li>
          ))}
        </ul>
      );
    case 'blockquote':
      return <blockquote className="py-0.5 pl-2.5 text-muted">{renderText(block.text)}</blockquote>;
    case 'table':
      return (
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
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr className="my-3 h-px border-0 bg-line" />;
    default:
      return <p>{renderText(block.text)}</p>;
  }
}

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
 * 1. **成本**：每帧全量 parse + 重建元素，长会话（几千字）很贵。分档节流见
 *    `useStreamingText`（<2k 逐帧 / 2k–20k 120ms / >20k 200ms）；逐帧档与非流式走
 *    **渲染期直通**（不落状态、不给陈旧帧）。节流命中时 `MarkdownBlocks` 的 props
 *    原样相等 → memo 直接跳过整棵子树，省的是 parse + 元素重建 + reconciliation
 *    （不只是省一次 setState）。
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
  const settled = useStreamingText(text, streaming);
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
  const blocks = useMemo(() => parseMarkdown(text, { streaming }), [text, streaming]);
  return (
    <div className={`markdown${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
});

/** 短消息逐帧（0ms）：单帧成本可忽略，逐字出现才有「正在生成」的感觉。 */
const STREAM_EVERY_FRAME_BELOW = 2_000;
/** 2k–20k：120ms（≈8fps）。 */
const STREAM_FAST_MS = 120;
/** 20k 以上：200ms（≈5fps）；越长的文本单帧越贵，档位越稀。 */
const STREAM_SLOW_FROM = 20_000;
const STREAM_SLOW_MS = 200;

function streamInterval(length: number): number {
  if (length < STREAM_EVERY_FRAME_BELOW) return 0;
  if (length < STREAM_SLOW_FROM) return STREAM_FAST_MS;
  return STREAM_SLOW_MS;
}

/**
 * 流式文本节流：返回「这一帧该渲染的文本」。
 *
 * 语义是**落后不丢字**：只提交前缀（文本永远在尾部追加），因此延迟表现为尾部稍晚
 * 出现，而不是内容跳动；没有补帧队列，一个待执行计时器就够 —— 它落地时取最新值。
 *
 * 非流式（`streaming=false`：历史、落盘态、取消后的终态）不节流，并且**渲染期**
 * 直接返回 `text`（effect 在 paint 之后才跑，只靠 effect 补齐会让终态先闪一帧旧文本）。
 *
 * 已知代价（无法在组件内部消除，说清楚免得以后当成 bug 查）：吸附滚动
 * （`useStickyBottom`）的跟随触发器是上游的 `followKey`（事件版本 / 渲染项数），
 * 而节流把「DOM 长高」推迟到计时器落地：连续流式时下一批事件会把视图再贴一次底，
 * 但**流停下来的那一次**提交之后没有任何新事件，多出来的 1–2 行可能停在视口下方，
 * 直到下一个事件（下一批 chunk / `run.completed` 的终态刷新）才贴底。量级与既有的
 * ~100ms 跟随节流同阶；如果以后觉得扎眼，正确做法是让跟随也认「可见文本长度」，
 * 而不是把这里的节流去掉。
 */
function useStreamingText(text: string, streaming: boolean): string {
  const [settled, setSettled] = useState(text);
  const committedRef = useRef(text);
  const latestRef = useRef(text);
  const timerRef = useRef<number | undefined>(undefined);
  const committedAtRef = useRef(0);
  // 逐帧档（短文本）与非流式都不需要节流：渲染期直接返回最新文本，一个陈旧帧都不给。
  const passThrough = !streaming || streamInterval(text.length) === 0;

  const commit = useCallback((next: string) => {
    committedAtRef.current = Date.now();
    if (next === committedRef.current) return;
    committedRef.current = next;
    setSettled(next);
  }, []);

  useEffect(() => {
    latestRef.current = text;
    const stopTimer = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
    if (passThrough) {
      // 渲染期已经是最新文本；这里只把提交基线跟上，好让「跨进节流档」之后
      // 的第一次提交按真实时间算（否则会立刻超时提交，等于没节流）。
      stopTimer();
      commit(text);
      return;
    }
    const interval = streamInterval(text.length);
    const elapsed = Date.now() - committedAtRef.current;
    if (elapsed >= interval) {
      stopTimer();
      commit(text);
      return;
    }
    // 已有一帧在排队：它会取 latestRef 里的最新文本，不需要再排一个。
    if (timerRef.current !== undefined) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      commit(latestRef.current);
    }, interval - elapsed);
  }, [text, passThrough, commit]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return passThrough ? text : settled;
}
