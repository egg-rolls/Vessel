/**
 * `ui.showArchived` 的 React 绑定（0.51）。
 *
 * 为什么单独一个文件：读取侧要 React + configStore（`archive-visibility.ts` 保持纯，
 * 供门禁探针 import）。为什么调 `useConfigStoreApi()`：Teams / Agents 页原先不拉
 * config，开关会被永远读成默认 false；这一个调用让三个列表页共享同一份 config.get
 * 快照，设置页保存后（它写 configStore）列表不刷新即按新开关重算。
 */
import { useConfigStore } from '../stores/configStore';
import { useConfigStoreApi } from '../stores/useConfigStoreApi';
import { resolveShowArchived } from './archive-visibility';
import { resourceData } from './useResource';

export function useShowArchived(): boolean {
  // 只为触发 config.get（已加载过就不再发请求），值本身从 store 选择器读。
  useConfigStoreApi();
  // 选择器只返回布尔：config 里别的键变化不会让列表重算。
  return useConfigStore((state) => resolveShowArchived(resourceData(state.config)));
}
