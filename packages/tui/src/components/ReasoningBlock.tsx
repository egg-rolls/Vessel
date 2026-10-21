/**
 * 思考流展示（0.11.1 / DECISION-022 §2.3）
 * @module @vessel-agent/tui
 *
 * `llm.stream.chunk` 的 `reasoning_delta` 只在实时区以弱化样式显示：
 * - faint + italic，弱于正文；
 * - 纯文本渲染（不解析 Markdown），避免思考内容改变正文排版；
 * - 0.18 起 reasoning 作为独立 `UiItem` 折叠成 1 行，完整内容经 Ctrl+O 取回。
 */

import { Box, Text } from 'ink';
import { t } from '../i18n/index.js';
import { theme } from '../theme.js';
import { sanitizeTerminalText } from '../utils/sanitize-terminal-text.js';

export interface ReasoningView {
  /** 段首标签（i18n） */
  header: string;
  /** 已清洗的思考正文 */
  body: string;
}

/** 纯函数：生成思考段展示内容；组件与测试共用。 */
export function buildReasoningView(text: string): ReasoningView {
  return { header: t('stream.reasoning'), body: sanitizeTerminalText(text) };
}

export function ReasoningBlock({ text }: { text: string }) {
  const view = buildReasoningView(text);
  if (!view.body.trim()) return null;

  return (
    <Box flexDirection="column">
      <Text color={theme.faint} italic>
        {view.header}
      </Text>
      <Text color={theme.faint} italic wrap="wrap">
        {view.body}
      </Text>
    </Box>
  );
}
