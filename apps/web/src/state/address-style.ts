/**
 * 地址显示风格的 React 绑定（q-addr-display）。
 *
 * 与 `runtime-visibility.ts` 同一个分工：纯函数（formatAddress / 兜底链）在
 * `@vessel-agent/agent/address-display`（零 import leaf，按源码 alias 消费），
 * 本文件只做「读 configStore 快照 → 归一化档位」这一层。
 *
 * 读的是服务端配置 `ui.addressStyle`（Settings → Display 写同一份 config.set），
 * 保存后无需刷新即生效；未连上 gateway / 未配置时按缺省 name（注册表 fallback）。
 * 选择器只取 config data 引用（快照对象，引用稳定）：无关 store 切片变化不重渲染。
 */
import { type AddressStyle, normalizeAddressStyle } from '@vessel-agent/agent/address-display';
import { useConfigStore } from '../stores/configStore';
import { readDisplayValue } from './display-settings';
import { resourceData } from './useResource';

export type { AddressStyle };

/** 当前地址显示风格；非法 / 未配置一律归一化回 name（用户裁定缺省）。 */
export function useAddressStyle(): AddressStyle {
  const data = useConfigStore((state) => resourceData(state.config));
  return normalizeAddressStyle(readDisplayValue(data, 'ui.addressStyle'));
}
