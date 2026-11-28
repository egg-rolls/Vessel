/**
 * kanban feature（q-kanban-view / q-kanban-proxy，R-6 事故模式）：任务看板读面 +
 * 用户验收归档写面（kanban.*）的 deps 与热应用。
 *
 * P2 迁移（ADR-107 第一批）：原 cli 网络面与 bootstrap 本地面各持一份可变
 * kanbanDeps，cli applyKanban 热应用双写两份。现单点声明**一个**可变对象：
 * dispatcher.kanban 与 result.kanbanDeps 同一引用，两表面共消费——热应用原地
 * 改这一份即两路同时活生效（handler 每次调用读 deps.boardPath）。
 *
 * 惰性纪律（ADR-107 决策 4）：可变对象原地改 = 本仓晚绑定先例（kanbanDeps 模式）
 * 的接口化；解析走共享 resolveKanbanBoardPath（~ 展开、相对进程 cwd → 缺省板，
 * R-6 起启动装配与热应用共用的唯一真相）。
 *
 * hotApply = config 子应用器（applyKanban，gateway-reload-wiring config scope
 * 内部按 kanban 块变化触发，不新增 reload scope）；差异行格式逐字保留。
 */

import { resolveKanbanBoardPath } from '../../runtime/bootstrap-connect';
import type { AssemblyFeature } from '../feature';

export const kanbanFeature: AssemblyFeature = {
  id: 'kanban',
  phase: 'dispatcher',
  register(ctx) {
    // 可变对象：同一引用进收集结果 dispatcher.kanban 与 result.kanbanDeps。
    const kanbanDeps: { boardPath: string } = {
      boardPath: resolveKanbanBoardPath(ctx.config.kanban),
    };
    return {
      dispatcher: { kanban: kanbanDeps },
      // BootstrapResult 透传（消灭 return 三件套手加；与 dispatcher 同一对象）。
      result: { kanbanDeps },
      hotApply: {
        config: 'applyKanban',
        // q-kanban-proxy：重解析 boardPath 原地更新（下一次 kanban.get/archive
        // 即用新板）。解析结果未变（如仅 trim 差异）不产差异行，避免无意义 notice。
        apply: (next) => {
          const from = kanbanDeps.boardPath;
          const to = resolveKanbanBoardPath(next.kanban);
          kanbanDeps.boardPath = to;
          return from === to ? [] : [`kanban: board path ${from} → ${to} (hot-applied)`];
        },
      },
    };
  },
};
