/**
 * kanban.* RPC wire 形状（与服务端 packages/serve/src/gateway/methods/kanban.ts 同源）。
 *
 * wire 字段 snake_case（canonical 约定）；板内任务字段与 board.json 逐字同名。
 */

export interface KanbanTask {
  id: string;
  title: string;
  column: string;
  owner?: string;
  branch?: string;
  progress?: string;
}

export interface KanbanBoard {
  board: string;
  updated?: string;
  note?: string;
  columns: string[];
  tasks: KanbanTask[];
  /** 服务端归一化降级说明（坏任务跳过 / 列推导 / 未知列等）。 */
  warnings: string[];
}

export type KanbanGetResult =
  | { unchanged: true; mtime_ms: number; size_bytes: number }
  | { unchanged: false; board: KanbanBoard; path: string; mtime_ms: number; size_bytes: number };

export interface KanbanArchiveResult {
  ok: boolean;
  id: string;
  archived_at: string;
  board: KanbanBoard;
  mtime_ms: number;
  size_bytes: number;
}

/** 本地视图数据：板 + 来源路径 + 轮询水位（mtime/size 双条件）。 */
export interface KanbanBoardData {
  board: KanbanBoard;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}
