/**
 * 状态栏组件
 * 显示 provider、model、session、plugins 信息
 *
 * 终端宽度不固定：单行三组 Box 在 80 列下会换行并撑坏边框。
 * 这里改为按宽度分级 + 单行截断，宽度足够时才显示完整信息。
 */

import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import { displayWidth, truncateToWidth } from '../utils/text-layout.js';

export interface StatusBarProps {
  provider: {
    name: string;
    model: string;
    baseUrl: string;
  };
  session: string;
  plugins: string[];
  /** 0.5：当前 tenant；未注入时不显示（0.4 调用方零改动） */
  tenant?: string;
}

/**
 * 纯函数：按终端列数生成单行状态栏。
 * 优先级：session > provider/model > tenant > plugins。
 * 宽度不足时依次丢掉 plugins、tenant、model，最后截断 session。
 */
export function formatStatusLine(props: StatusBarProps, columns: number): string {
  // 边框 2 列 + paddingX 2 列，再留 2 列余量，避免 Ink 把右边框挤到下一行。
  const max = Math.max(20, Math.floor(columns) - 6);
  const provider = `Vessel · ${props.provider.name}`;
  const model = props.provider.model ? ` | ${props.provider.model}` : '';
  const tenant = props.tenant ? ` · tenant: ${props.tenant}` : '';
  const session = props.session ? ` · session: ${props.session}` : '';
  const plugins = props.plugins.length > 0 ? ` · plugins: ${props.plugins.length}` : '';

  const candidates = [
    `${provider}${model}${tenant}${session}${plugins}`,
    `${provider}${model}${tenant}${session}`,
    `${provider}${model}${session}`,
    `${provider}${tenant}${session}`,
    `${provider}${session}`,
  ];
  for (const candidate of candidates) {
    if (displayWidth(candidate) <= max) return candidate;
  }

  // 保留 session，把 model 截断到剩余空间。
  const compact = `${provider} | ${props.provider.model}${session}`;
  const modelBudget = max - displayWidth(compact) + displayWidth(model);
  if (props.provider.model && modelBudget >= 8) {
    return `${provider} | ${truncateToWidth(props.provider.model, modelBudget)}${session}`;
  }

  // 最后保底：provider + 截断后的 session。
  const prefix = `${provider} · session: `;
  const sessionBudget = max - displayWidth(prefix);
  if (sessionBudget > 4) {
    return `${prefix}${truncateToWidth(props.session, sessionBudget)}`;
  }
  return truncateToWidth(provider, max);
}

export function StatusBar({ provider, session, plugins, tenant }: StatusBarProps) {
  const { stdout } = useStdout();
  const columns = stdout.columns ?? 80;
  const line = formatStatusLine(
    { provider, session, plugins, ...(tenant ? { tenant } : {}) },
    columns,
  );

  // 无边框单行：规避 Windows/80 列下右边框换行，同时更接近 Web 的留白感。
  return (
    <Box paddingX={2} width="100%" overflow="hidden" flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={theme.brand} bold>
          Vessel
        </Text>
        <Text color={theme.muted}>{line.slice('Vessel'.length)}</Text>
      </Text>
    </Box>
  );
}
