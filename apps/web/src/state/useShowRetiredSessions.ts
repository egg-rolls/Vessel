/**
 * `ui.showRetiredSessions` 的 React 绑定（q-retired-session-toggle）。
 *
 * 分工照 `useShowArchived.ts`：读取侧要 React + configStore，纯读取口径在
 * `retired-visibility.ts`。`useConfigStoreApi()` 触发 config.get（已加载过就不再发
 * 请求），设置页保存后写同一份 configStore，会话列表不刷新即按新开关重算。
 */
import { useConfigStore } from '../stores/configStore';
import { useConfigStoreApi } from '../stores/useConfigStoreApi';
import { resolveShowRetiredSessions } from './retired-visibility';
import { resourceData } from './useResource';

export function useShowRetiredSessions(): boolean {
  useConfigStoreApi();
  // 选择器只返回布尔：config 里别的键变化不会让列表重算。
  return useConfigStore((state) => resolveShowRetiredSessions(resourceData(state.config)));
}