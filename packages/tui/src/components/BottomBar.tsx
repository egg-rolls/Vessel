/**
 * 运行态下栏（0.13）：权限档位 / bash / 子 agent / session 入口 / tenant / queue。
 * @module @vessel-agent/tui
 *
 * 单行、与上栏同宽（`viewWidth`）；字段与丢弃顺序由 `formatBottomBar` 纯函数决定。
 * 独占 overlay 打开时由调用方隐藏（净增行数预算见 `BOTTOM_BAR_ROWS`）。
 */

import { Text, useStdout } from 'ink';
import { t } from '../i18n/index.js';
import { type BottomBarData, formatBottomBar, toneColor } from '../repl/status-format.js';
import { viewWidth } from '../views/layout.js';
import { PanelFrame } from './PanelFrame.js';

export interface BottomBarProps extends BottomBarData {
  /** 终端列数；缺省读 stdout */
  columns?: number;
}

export function BottomBar(props: BottomBarProps) {
  const { stdout } = useStdout();
  const columns = props.columns ?? stdout.columns ?? 80;
  const segments = formatBottomBar(props, columns);
  if (segments.length === 0) return null;

  let keyOffset = 0;
  const keyed = segments.map((segment) => {
    const key = `${keyOffset}-${segment.tone}`;
    keyOffset += segment.text.length;
    return { segment, key };
  });

  return (
    <PanelFrame width={viewWidth(columns)} hints={t('repl.bottomBarHints')}>
      <Text wrap="truncate-end">
        {keyed.map(({ segment, key }) => (
          <Text key={key} color={toneColor(segment.tone)}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </PanelFrame>
  );
}
