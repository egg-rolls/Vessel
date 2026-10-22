import type { Route } from './router';

/**
 * 切换租户时必须丢弃的 UI 状态（纯数据，便于回归测试）。
 *
 * 事件缓冲由 ConnectionProvider 重置；业务 resource 由 AppShell 的 main key
 * 重新挂载；这里列出外壳层需要显式清空的项。
 */
export interface TenantResetPlan {
  route: Route;
  clearPaletteEntities: boolean;
  closePalette: boolean;
  closeSessionsDrawer: boolean;
  clearPendingAction: boolean;
}

export function tenantResetPlan(): TenantResetPlan {
  return {
    // 回到 Chat 空态：会话/运行的选择都在 route 里，一并清空。
    route: { domain: 'chat' },
    clearPaletteEntities: true,
    closePalette: true,
    closeSessionsDrawer: true,
    clearPendingAction: true,
  };
}
