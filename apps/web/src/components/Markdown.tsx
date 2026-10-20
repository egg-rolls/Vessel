// biome-ignore-all lint/suspicious/noArrayIndexKey: parsed markdown is immutable per render; index keys are stable
import { Fragment, type ReactNode, useMemo } from 'react';
import { type InlineNode, type MarkdownBlock, parseInline, parseMarkdown } from './markdown-parse';

function Inline({ nodes }: { nodes: InlineNode[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'code':
        return (
          <code className="md-inline-code" key={index}>
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
      return <Tag className="md-heading">{renderText(block.text)}</Tag>;
    }
    case 'code':
      return (
        <div className="md-code-block">
          {block.lang && <span className="md-code-lang">{block.lang}</span>}
          <pre className="md-code">
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case 'list':
      return block.ordered ? (
        <ol className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>{renderText(item)}</li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>{renderText(item)}</li>
          ))}
        </ul>
      );
    case 'blockquote':
      return <blockquote className="md-quote">{renderText(block.text)}</blockquote>;
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index}>{renderText(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderText(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr className="md-hr" />;
    default:
      return <p className="md-paragraph">{renderText(block.text)}</p>;
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
