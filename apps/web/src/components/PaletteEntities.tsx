import { createContext, type ReactNode, useContext, useEffect } from 'react';
import type { PaletteItem } from '../state/palette';

type Register = (source: string, items: readonly PaletteItem[]) => void;

const PaletteEntitiesContext = createContext<Register | null>(null);

/** AppShell 持有实体结果；域视图按来源注册，离开视图后保留最近一次结果。 */
export function PaletteEntitiesProvider({
  register,
  children,
}: {
  register: Register;
  children: ReactNode;
}) {
  return (
    <PaletteEntitiesContext.Provider value={register}>{children}</PaletteEntitiesContext.Provider>
  );
}

/**
 * 注册实体项（调用方必须 memoize items）。
 * 默认卸载时不清空，保证从其他域打开命令面板时仍能搜索最近实体；
 * 依赖当前视图内部状态的动作（如会话改名）应传 clearOnUnmount，避免留下无效动作。
 */
export function usePaletteEntities(
  source: string,
  items: readonly PaletteItem[],
  options: { clearOnUnmount?: boolean } = {},
): void {
  const register = useContext(PaletteEntitiesContext);
  const clearOnUnmount = options.clearOnUnmount === true;
  useEffect(() => {
    register?.(source, items);
    return () => {
      if (clearOnUnmount) register?.(source, []);
    };
  }, [register, source, items, clearOnUnmount]);
}
