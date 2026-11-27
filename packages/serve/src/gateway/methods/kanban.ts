/**
 * kanban.* 方法（q-kanban-view：任务看板查看器）。
 *
 * 读面 `kanban.get`：读装配层注入的 board.json（缺省 <cwd>/docs/dev/kanban/board.json），
 * 宽进严出归一化（坏任务不拖垮整板，降级记 warnings）；支持 if_mtime_ms/if_size_bytes
 * 条件轮询（双命中只 stat 不读文件，一次 RPC ≈ 一次 stat）。
 *
 * 轻量读面（q-tooling）：`kanban.list` 每卡一行摘要（progress 首句截断），支持
 * column/owner/status 过滤（status 是 column 的别名——板内状态即列）；`kanban.view`
 * 单卡全字段详情（含全量 progress 与未知键）。两者与 get 同一份归一化/边界实现，
 * 供 agent 经 vessel op=rpc 轻量扫板，不必 read 原始 JSON。
 *
 * 写面 `kanban.archive`：**只有用户验收勾选才触发**（Web UI KanbanView 勾选框 →
 * 确认 → 本方法），把 task 从 board.tasks 移除并追加进同目录 archive.json
 * （append-only，条目 = 原始 task 全字段 + archivedAt + cycle?）。绝不自动归档。
 *
 * 写序 = 先 archive 后 board：中途失败最坏留「两侧都有」的重复（可恢复），
 * 不丢任务；id 已在 archive 时跳过追加只删板（重试自愈）。进程内 mutex 串行化
 * 读改写；跨进程并发（维护者同时编辑 board）无文件锁，写前重读最小化窗口。
 *
 * 未注入 boardPath 时方法仍进 manifest，handler 返回 `not_found`（teams.* 先例）。
 * 错误码复用冻结集：not_found（文件/任务缺）、invalid_params、quota_exceeded
 * （超 2 MiB）、conflict（archive 损坏，fail-closed 不覆盖）、internal（parse/IO）。
 *
 * @module @vessel-agent/serve
 */

import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@vessel-agent/core';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { optionalStringParam, stringParam } from './common.js';

export interface KanbanMethodsDeps {
  /**
   * board.json 绝对路径（装配层解析 config kanban.board_path → 缺省
   * <cwd>/docs/dev/kanban/board.json）。未注入 = `kanban.*` 返回 `not_found`。
   * archive.json 恒取板同目录（不读文件内指针，杜绝不可信路径）。
   */
  boardPath?: string;
}

/** 归一化后的任务（RPC 返回形状；字段与 board.json 逐字同名）。 */
interface KanbanTask {
  id: string;
  title: string;
  column: string;
  owner?: string;
  branch?: string;
  progress?: string;
}

/** 归一化后的板（UI 按 columns 序分列；未知 column 的任务归「未分类」兜底列）。 */
interface KanbanBoard {
  board: string;
  updated?: string;
  note?: string;
  columns: string[];
  tasks: KanbanTask[];
  warnings: string[];
}

/** 单文件读取上限（防误配大文件打爆内存；q-kanban 设计 §4.4）。 */
const MAX_BOARD_BYTES = 2 * 1024 * 1024;
/** 任务数软上限（超出截断 + warning）。 */
const MAX_TASKS = 2000;

const kanbanTaskSchema = {
  type: 'object',
  required: ['id', 'title', 'column'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    column: { type: 'string' },
    owner: { type: 'string' },
    branch: { type: 'string' },
    progress: { type: 'string' },
  },
};

const kanbanBoardSchema = {
  type: 'object',
  required: ['board', 'columns', 'tasks', 'warnings'],
  properties: {
    board: { type: 'string' },
    updated: { type: 'string' },
    note: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    tasks: { type: 'array', items: kanbanTaskSchema },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

function requireBoardPath(boardPath: string | undefined): string {
  if (boardPath === undefined || boardPath === '') {
    throw new RpcError('not_found', 'Kanban board path is not configured');
  }
  return boardPath;
}

function optionalNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcError('invalid_params', `${key} must be a finite number`);
  }
  return value;
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** stat 板文件；ENOENT / 非文件 → not_found，其余 fs 错误 → internal。 */
async function statBoard(boardPath: string): Promise<Stats> {
  let st: Stats;
  try {
    st = await stat(boardPath);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      throw new RpcError('not_found', `kanban board not found: ${boardPath}`);
    }
    throw new RpcError('internal', `kanban board stat failed (${boardPath}): ${messageOf(error)}`);
  }
  if (!st.isFile()) {
    throw new RpcError('not_found', `kanban board is not a file: ${boardPath}`);
  }
  return st;
}

async function readBoardText(boardPath: string): Promise<string> {
  try {
    return await readFile(boardPath, 'utf8');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      throw new RpcError('not_found', `kanban board not found: ${boardPath}`);
    }
    throw new RpcError('internal', `kanban board read failed (${boardPath}): ${messageOf(error)}`);
  }
}

/**
 * 板级 fail-closed：parse 失败 / 顶层不是对象 / 缺 board 标题 / tasks 不是数组
 * → internal（带路径与原因）。其余降级进 warnings，不丢合法任务。
 */
function parseBoardRaw(text: string, sourcePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RpcError(
      'internal',
      `kanban board parse failed (${sourcePath}): ${messageOf(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RpcError('internal', `kanban board top-level must be an object (${sourcePath})`);
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.board !== 'string' || raw.board === '') {
    throw new RpcError('internal', `kanban board missing "board" title (${sourcePath})`);
  }
  if (!Array.isArray(raw.tasks)) {
    throw new RpcError('internal', `kanban board "tasks" must be an array (${sourcePath})`);
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 宽进严出归一化（q-kanban 设计 §4.4）：列级/任务级/字段级降级都记 warnings。 */
function normalizeBoard(raw: Record<string, unknown>): KanbanBoard {
  const warnings: string[] = [];
  const rawTasks = raw.tasks as unknown[];

  // 列：显式 columns 去重保序；缺省/空 → 从 tasks 的 column 值推导（出现顺序）。
  const columns: string[] = [];
  if (Array.isArray(raw.columns)) {
    for (const column of raw.columns) {
      if (typeof column === 'string' && column !== '' && !columns.includes(column)) {
        columns.push(column);
      }
    }
  }
  if (columns.length === 0) {
    for (const item of rawTasks) {
      if (!isRecord(item)) continue;
      const column = item.column;
      if (typeof column === 'string' && column !== '' && !columns.includes(column)) {
        columns.push(column);
      }
    }
    if (columns.length > 0) {
      warnings.push('columns missing/empty; derived from tasks');
    }
  }

  const tasks: KanbanTask[] = [];
  const seen = new Set<string>();
  const unknownColumns = new Set<string>();
  for (let i = 0; i < rawTasks.length; i++) {
    if (tasks.length >= MAX_TASKS) {
      warnings.push(`tasks truncated at ${MAX_TASKS}`);
      break;
    }
    const item = rawTasks[i];
    if (!isRecord(item)) {
      warnings.push(`tasks[${i}]: not an object, skipped`);
      continue;
    }
    const { id, title, column } = item;
    if (typeof id !== 'string' || id === '') {
      warnings.push(`tasks[${i}]: missing id, skipped`);
      continue;
    }
    if (typeof title !== 'string' || title === '') {
      warnings.push(`tasks[${i}]: missing title, skipped`);
      continue;
    }
    if (typeof column !== 'string' || column === '') {
      warnings.push(`tasks[${i}]: missing column, skipped`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`tasks[${i}]: duplicate id "${id}", skipped`);
      continue;
    }
    seen.add(id);
    const task: KanbanTask = { id, title, column };
    for (const key of ['owner', 'branch', 'progress'] as const) {
      const value = item[key];
      if (value === undefined) continue;
      if (typeof value === 'string') {
        task[key] = value;
      } else {
        warnings.push(`tasks[${i}].${key}: not a string, dropped`);
      }
    }
    if (!columns.includes(column)) unknownColumns.add(column);
    tasks.push(task);
  }
  for (const column of unknownColumns) {
    warnings.push(`column "${column}" not in columns; tasks shown under uncategorized`);
  }

  const board: KanbanBoard = { board: raw.board as string, columns, tasks, warnings };
  if (typeof raw.updated === 'string') board.updated = raw.updated;
  if (typeof raw.note === 'string') board.note = raw.note;
  return board;
}

// ── 轻量读面（q-tooling：kanban.list / kanban.view）─────────────────────

/** list 摘要里 progress 首句的长度上限（一卡一行，扫板不灌窗口）。 */
const PROGRESS_EXCERPT_MAX = 80;

/**
 * progress → 首句摘要：先取首行，再在第一个句读（。！？!?；;）处收口，
 * 超过上限硬截断加省略号。空/缺省 → undefined（结果里不带该键）。
 */
function progressExcerpt(progress: string | undefined): string | undefined {
  if (progress === undefined || progress === '') return undefined;
  const firstLine = progress.split(/\r?\n/, 1)[0] ?? '';
  const sentence = firstLine.split(/(?<=[。！？!?；;])/u, 1)[0] ?? firstLine;
  const text = sentence === '' ? firstLine : sentence;
  return text.length <= PROGRESS_EXCERPT_MAX ? text : `${text.slice(0, PROGRESS_EXCERPT_MAX - 1)}…`;
}

/** list 行 schema：每卡一行摘要（progress 只带首句截断）。 */
const kanbanListRowSchema = {
  type: 'object',
  required: ['id', 'title', 'column'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    column: { type: 'string' },
    owner: { type: 'string' },
    branch: { type: 'string' },
    progress_excerpt: { type: 'string' },
  },
};

/** 读板公共路径：stat → 大小闸 → 读文本 → parse → 归一化（get/list/view 同一份）。 */
async function loadBoard(
  boardPath: string,
): Promise<{ board: KanbanBoard; raw: Record<string, unknown>; st: Stats }> {
  const st = await statBoard(boardPath);
  if (st.size > MAX_BOARD_BYTES) {
    throw new RpcError(
      'quota_exceeded',
      `kanban board too large: ${st.size} bytes (limit ${MAX_BOARD_BYTES})`,
    );
  }
  const raw = parseBoardRaw(await readBoardText(boardPath), boardPath);
  return { board: normalizeBoard(raw), raw, st };
}

/** 进程内读改写串行化（值为永不 reject 的 tail；atomicWrite 只按路径排队，不够）。 */
let archiveChain: Promise<void> = Promise.resolve();
function withArchiveLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = archiveChain.then(fn, fn);
  archiveChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** 归档条目 id 命中（append-only 自愈：重复归档请求不追加第二条）。 */
function entryHasId(entry: unknown, id: string): boolean {
  return isRecord(entry) && entry.id === id;
}

export function createKanbanMethods(deps: KanbanMethodsDeps): RpcMethodDefinition[] {
  return [
    {
      name: 'kanban.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          if_mtime_ms: { type: 'number' },
          if_size_bytes: { type: 'integer', minimum: 0 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['unchanged', 'mtime_ms', 'size_bytes'],
        properties: {
          unchanged: { type: 'boolean' },
          mtime_ms: { type: 'number' },
          size_bytes: { type: 'integer', minimum: 0 },
          board: kanbanBoardSchema,
          path: { type: 'string' },
        },
      },
      handler: async (params) => {
        const boardPath = requireBoardPath(deps.boardPath);
        const ifMtimeMs = optionalNumberParam(params, 'if_mtime_ms');
        const ifSizeBytes = optionalNumberParam(params, 'if_size_bytes');
        const st = await statBoard(boardPath);
        // 条件轮询：双命中只 stat 不读文件（手动刷新不带条件，必达）。
        if (
          ifMtimeMs !== undefined &&
          ifSizeBytes !== undefined &&
          st.mtimeMs === ifMtimeMs &&
          st.size === ifSizeBytes
        ) {
          return { unchanged: true, mtime_ms: st.mtimeMs, size_bytes: st.size };
        }
        const loaded = await loadBoard(boardPath);
        return {
          unchanged: false,
          board: loaded.board,
          path: boardPath,
          mtime_ms: loaded.st.mtimeMs,
          size_bytes: loaded.st.size,
        };
      },
    },
    {
      name: 'kanban.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          column: { type: 'string', minLength: 1 },
          owner: { type: 'string', minLength: 1 },
          status: { type: 'string', minLength: 1 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['tasks', 'total', 'matched', 'counts', 'mtime_ms', 'size_bytes', 'warnings'],
        properties: {
          tasks: { type: 'array', items: kanbanListRowSchema },
          total: { type: 'integer', minimum: 0 },
          matched: { type: 'integer', minimum: 0 },
          counts: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
          mtime_ms: { type: 'number' },
          size_bytes: { type: 'integer', minimum: 0 },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      handler: async (params) => {
        const boardPath = requireBoardPath(deps.boardPath);
        const column = optionalStringParam(params, 'column');
        const owner = optionalStringParam(params, 'owner');
        // status 是 column 的别名（板内状态即列）；两者同传且不同值 = 矛盾参数。
        const status = optionalStringParam(params, 'status');
        if (column !== undefined && status !== undefined && column !== status) {
          throw new RpcError('invalid_params', 'column and status must agree when both are given');
        }
        const wantColumn = column ?? status;
        const { board, st } = await loadBoard(boardPath);
        const counts: Record<string, number> = {};
        for (const task of board.tasks) {
          counts[task.column] = (counts[task.column] ?? 0) + 1;
        }
        const rows = board.tasks
          .filter(
            (task) =>
              (wantColumn === undefined || task.column === wantColumn) &&
              (owner === undefined || task.owner === owner),
          )
          .map((task) => {
            const row: Record<string, unknown> = {
              id: task.id,
              title: task.title,
              column: task.column,
            };
            if (task.owner !== undefined) row.owner = task.owner;
            if (task.branch !== undefined) row.branch = task.branch;
            const excerpt = progressExcerpt(task.progress);
            if (excerpt !== undefined) row.progress_excerpt = excerpt;
            return row;
          });
        return {
          tasks: rows,
          total: board.tasks.length,
          matched: rows.length,
          counts,
          mtime_ms: st.mtimeMs,
          size_bytes: st.size,
          warnings: board.warnings,
        };
      },
    },
    {
      name: 'kanban.view',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['task', 'board', 'mtime_ms', 'size_bytes'],
        properties: {
          // 原始 task 全字段（含全量 progress 与未知键）；id/title/column 已由归一化校验。
          task: { type: 'object', required: ['id', 'title', 'column'] },
          board: {
            type: 'object',
            required: ['board'],
            properties: {
              board: { type: 'string' },
              updated: { type: 'string' },
            },
          },
          mtime_ms: { type: 'number' },
          size_bytes: { type: 'integer', minimum: 0 },
        },
      },
      handler: async (params) => {
        const boardPath = requireBoardPath(deps.boardPath);
        const id = stringParam(params, 'id');
        const { board, raw, st } = await loadBoard(boardPath);
        // 归一化判存在（重复 id 取首条，与 get/archive 同口径），返回原始全字段。
        if (!board.tasks.some((task) => task.id === id)) {
          throw new RpcError('not_found', `kanban task not on board: ${id}`);
        }
        const rawTask = (raw.tasks as unknown[]).find((item) => entryHasId(item, id));
        const meta: Record<string, unknown> = { board: board.board };
        if (board.updated !== undefined) meta.updated = board.updated;
        return {
          task: isRecord(rawTask) ? rawTask : { id },
          board: meta,
          mtime_ms: st.mtimeMs,
          size_bytes: st.size,
        };
      },
    },
    {
      name: 'kanban.archive',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1 },
          cycle: { type: 'string', minLength: 1 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['ok', 'id', 'archived_at', 'board', 'mtime_ms', 'size_bytes'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          archived_at: { type: 'string' },
          board: kanbanBoardSchema,
          mtime_ms: { type: 'number' },
          size_bytes: { type: 'integer', minimum: 0 },
        },
      },
      handler: async (params) => {
        const boardPath = requireBoardPath(deps.boardPath);
        const id = stringParam(params, 'id');
        const cycle = optionalStringParam(params, 'cycle');
        return withArchiveLock(async () => {
          const archivePath = path.join(path.dirname(boardPath), 'archive.json');
          // 写前重读（最小化与维护者并发编辑的窗口）。
          const raw = parseBoardRaw(await readBoardText(boardPath), boardPath);
          const board = normalizeBoard(raw);
          const task = board.tasks.find((item) => item.id === id);
          if (!task) {
            throw new RpcError('not_found', `kanban task not on board: ${id}`);
          }
          const rawTasks = raw.tasks as unknown[];
          const rawTask = rawTasks.find((item) => entryHasId(item, id));

          // 归档文档：存在则必须可解析且 entries 是数组（损坏 fail-closed，绝不覆盖）；
          // 不存在则新建（archive/note/entries 形状与现有 archive.json 约定一致）。
          let archiveDoc: Record<string, unknown>;
          let entries: unknown[];
          let archiveText: string | undefined;
          try {
            archiveText = await readFile(archivePath, 'utf8');
          } catch (error) {
            if (errnoOf(error) !== 'ENOENT') {
              throw new RpcError(
                'conflict',
                `kanban archive read failed (${archivePath}): ${messageOf(error)}`,
              );
            }
          }
          if (archiveText === undefined) {
            entries = [];
            archiveDoc = {
              archive: `${board.board} · 归档`,
              note: 'append-only。由 kanban.archive（用户验收勾选）追加；entries=Task+archivedAt+cycle。',
              entries,
            };
          } else {
            let parsed: unknown;
            try {
              parsed = JSON.parse(archiveText);
            } catch (error) {
              throw new RpcError(
                'conflict',
                `kanban archive parse failed (${archivePath}): ${messageOf(error)}`,
              );
            }
            if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
              throw new RpcError(
                'conflict',
                `kanban archive must be an object with an entries array (${archivePath})`,
              );
            }
            archiveDoc = parsed;
            entries = parsed.entries;
          }

          const archivedAt = new Date().toISOString();
          // append-only：只追加不改写历史条目；id 已在归档 → 跳过追加（重试自愈）。
          if (!entries.some((entry) => entryHasId(entry, id))) {
            entries.push({
              ...(isRecord(rawTask) ? rawTask : task),
              archivedAt,
              ...(cycle !== undefined ? { cycle } : {}),
            });
          }
          // 板：只删该 task + 刷新 updated，其余键（含未知键）原样保留。
          const newRaw: Record<string, unknown> = {
            ...raw,
            tasks: rawTasks.filter((item) => !entryHasId(item, id)),
            updated: archivedAt,
          };
          // 写序：先 archive 后 board（中途失败留重复可恢复，不丢任务）。
          await atomicWrite(archivePath, `${JSON.stringify(archiveDoc, null, 2)}\n`);
          await atomicWrite(boardPath, `${JSON.stringify(newRaw, null, 2)}\n`);
          const st = await statBoard(boardPath);
          return {
            ok: true,
            id,
            archived_at: archivedAt,
            board: normalizeBoard(newRaw),
            mtime_ms: st.mtimeMs,
            size_bytes: st.size,
          };
        });
      },
    },
  ];
}
