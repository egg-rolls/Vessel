import { createContext, type ReactNode, useContext, useEffect } from 'react';
import type { PaletteItem } from '../state/palette';

type Register = (items: readonly PaletteItem[]) => void;

const PaletteEntitiesContext = createContext<Register | null>(null);

/** AppShell 持有实体结果；域视图通过 sink 注册，不把业务数据提升到外壳。 */
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

/** 注册实体项（调用方必须 memoize items）；卸载时清空。 */
export function usePaletteEntities(items: readonly PaletteItem[]): void {
  const register = useContext(PaletteEntitiesContext);
  useEffect(() => {
    if (!register) return;
    register(items);
    return () => register([]);
  }, [register, items]);
}
