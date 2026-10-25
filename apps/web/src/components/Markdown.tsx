// biome-ignore-all lint/suspicious/noArrayIndexKey: parsed markdown is immutable per render; index keys are stable
import { Fragment, type ReactNode, useMemo } from 'react';
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
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={`markdown${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
