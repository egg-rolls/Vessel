/**
 * attachments.* 方法（0.52）：节点侧**只读**目录浏览。
 *
 * 为什么由节点侧列目录：`refs[].path` 的语义是「将要消费它的那台机器上的绝对路径」
 * （边界按该 node 的 `allowed_roots` 判，多模态解析器插件的 `media` 工具也在 node 上读）。
 * 谁消费谁产出 —— 浏览器 / 手机 / 另一台机器只需要展示 node 回来的字符串，
 * `/mnt/d/...` 与 `D:\...` 不需要人工映射，远程也不必猜路径。网关侧 GUI 对话框做不到这件事
 * （daemon / 远程 node / 容器里没有桌面会话）。
 *
 * 边界实现**不在 serve**：与 `runs.start` 的 `checkRefs` 同一条口径，装配层注入
 * `AttachmentLister`（复用 basic-tools 的 `buildPathBoundary` / `evaluatePath` /
 * `canonicalPath`）。serve 只负责形状、权限与折错误。
 *
 * 只读三件事：列**单层**名字、返回真实路径、可选 `bytes` / `mtime_ms`。
 * 不返回文件内容、不递归、不 watch、不写、不支持远程 URL；`attachments.read` 不存在
 * 且不该存在（内容只能经 `media` 工具按需读，多一个读接口就多一条绕过边界的路）。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';

/**
 * 折进结果体的稳定码，与 `runs.start` 的 `refs` 拒绝**同一组**（不新造一套）：
 *
 * - `refs_invalid`：`dir` 不合法 —— 解析后不是目录 / 读不了；
 * - `refs_denied`：命中 deny 目录（内置 denylist，或配置 `deny_paths`）；
 * - `refs_outside_roots`：越出允许根（配置 `allowed_roots`，缺省是 node 侧的安全默认根）。
 *
 * 与 `runs.start` 的差别只有一处：这里不抛 `invalid_params`，而是折成
 * `entries: []` + `reason`（列目录失败不该变成 500，前端给一句人话即可）。
 */
export type AttachmentListReason = 'refs_invalid' | 'refs_denied' | 'refs_outside_roots';

/** 单层条目。`path` 是 node 上的**真实路径**（符号链接已按 realpath 解析）。 */
export interface AttachmentListEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  /** 文件字节数（只对 `kind: 'file'`）。 */
  bytes?: number;
  /** mtime（毫秒；取不到时缺省）。 */
  mtime_ms?: number;
}

/** `attachments.list` 的结果体。`dir` 省略 = 只返回 `roots`。 */
export interface AttachmentListResult {
  /** 允许浏览的根（node 上的真实路径）；未配 `allowed_roots` 时是安全默认根。 */
  roots: string[];
  dir?: string;
  /** 上级目录；已经在某个允许根上时不返回（没有可退的上级）。 */
  parent?: string;
  entries: AttachmentListEntry[];
  /** 条目数达到 `limit` 且还有更多（前端提示「已截断」）。 */
  truncated: boolean;
  reason?: AttachmentListReason;
}

/** 归一后的入参（`limit` 已夹进 [1, 500]）。 */
export interface AttachmentListRequest {
  /** 绝对路径；缺省 = 只要 `roots`。 */
  dir?: string;
  include_hidden: boolean;
  limit: number;
}

/**
 * 目录列举器（装配层注入）。
 *
 * 边界判定与默认根都归装配层：serve 拿不到配置，也不该认识 `allowed_roots`。
 */
export type AttachmentLister = (request: AttachmentListRequest) => Promise<AttachmentListResult>;

/** `limit` 缺省 200：一次列出足够一屏半以上，又不至于让前端一次渲染几百行。 */
export const ATTACHMENT_LIST_DEFAULT_LIMIT = 200;

/** `limit` 上限 500：更大的目录请缩小 `dir`（单层 + 有界是这一面安全性的前提）。 */
export const ATTACHMENT_LIST_MAX_LIMIT = 500;

export interface AttachmentMethodsDeps {
  /**
   * 缺省（装配层没注入，例如只有方法表的本地 dispatcher）= 没有可浏览的根，
   * 返回 `entries: []` + `reason: 'refs_outside_roots'`（fail-closed，不猜路径）。
   */
  list?: AttachmentLister;
}

/** 取 `limit`：schema 已卡住 1..500，这里再夹一次（防直接调用 handler 的代码）。 */
function readLimit(value: unknown): number {
  if (value === undefined) return ATTACHMENT_LIST_DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RpcError('invalid_params', 'limit must be a positive integer');
  }
  return Math.min(value, ATTACHMENT_LIST_MAX_LIMIT);
}

/** 取 `dir`：空白串等价于省略（「只返回 roots」）。 */
function readDir(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RpcError('invalid_params', 'dir must be a string');
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createAttachmentMethods(deps: AttachmentMethodsDeps): RpcMethodDefinition[] {
  const { list } = deps;
  return [
    {
      name: 'attachments.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          include_hidden: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: ATTACHMENT_LIST_MAX_LIMIT },
        },
      },
      result_schema: {
        type: 'object',
        required: ['roots', 'entries', 'truncated'],
        properties: {
          roots: { type: 'array', items: { type: 'string' } },
          dir: { type: 'string' },
          parent: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'path', 'kind'],
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                kind: { type: 'string', enum: ['file', 'dir'] },
                bytes: { type: 'integer', minimum: 0 },
                mtime_ms: { type: 'integer', minimum: 0 },
              },
            },
          },
          truncated: { type: 'boolean' },
          reason: {
            type: 'string',
            enum: ['refs_invalid', 'refs_denied', 'refs_outside_roots'],
          },
        },
      },
      handler: async (params) => {
        const dir = readDir(params.dir);
        const request: AttachmentListRequest = {
          include_hidden: params.include_hidden === true,
          limit: readLimit(params.limit),
          ...(dir !== undefined ? { dir } : {}),
        };
        if (list === undefined) {
          return { roots: [], entries: [], truncated: false, reason: 'refs_outside_roots' };
        }
        return list(request);
      },
    },
  ];
}
