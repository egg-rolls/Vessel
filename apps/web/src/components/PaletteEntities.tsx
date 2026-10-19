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
 * 卸载时不清空，保证从其他域打开命令面板时仍能搜索最近实体。
 */
export function usePaletteEntities(source: string, items: readonly PaletteItem[]): void {
  const register = useContext(PaletteEntitiesContext);
  useEffect(() => {
    register?.(source, items);
  }, [register, source, items]);
}
