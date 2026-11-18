/**
 * plugin-embed 契约 §8：插件级渲染错误边界（class 组件）。
 *
 * 渲染错误 → 插件级 ErrorState（插件名 + 错误摘要 + 重试 + 「改用隔离模式」），
 * 上报日志，不影响宿主其它部分。key 由调用方给 `pluginId:hash[:attempt]`：
 * 哈希变化（热更新）或重试都会重挂载并重置 state。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '../../components/States';
import { Button } from '../../components/ui';
import { t } from '../../i18n';

export interface PluginErrorBoundaryProps {
  pluginId: string;
  pluginName: string;
  /** 重试：调用方 bump attempt → key 变化 → 重置 state 重挂载。 */
  onRetry: () => void;
  /** 改用隔离模式：调用方本地切换渲染 PluginFrame。 */
  onIsolate: () => void;
  children: ReactNode;
}

interface PluginErrorBoundaryState {
  error: Error | null;
}

export class PluginErrorBoundary extends Component<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
  override state: PluginErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PluginErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 诊断走浏览器 console（与宿主 event-store 同一模式），不阻断渲染。
    console.error(
      `[vessel-plugin:${this.props.pluginId}] render error`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <ErrorState
        title={t('plugins.embed.errorTitle')}
        message={t('plugins.embed.errorBody', {
          plugin: this.props.pluginName,
          error: error.message,
        })}
        onRetry={this.props.onRetry}
        action={<Button onClick={this.props.onIsolate}>{t('plugins.embed.useIsolated')}</Button>}
      />
    );
  }
}
