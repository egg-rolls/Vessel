/**
 * 附件域方法：`attachments.list`（0.52，节点侧只读目录浏览）。
 *
 * 浏览器拿不到宿主机绝对路径（`File.path` 是 Electron 私有字段，规范里没有），
 * 所以路径由**消费它的那台机器**产出：这个方法是 node 上的一次单层 `readdir`，
 * 只有名字 / 真实路径 / 大小 / mtime，没有内容、没有递归、没有上传。
 *
 * 旧 gateway 没有这个方法（`not_found`）：面板把错误原样展示，粘贴路径那条路仍可用。
 */
import { IntegrationsClient } from './integrations';

/** 目录条目种类；只有这两类会被列出来（套接字 / 设备不出现）。 */
export type AttachmentListKind = 'file' | 'dir';

/** 单层条目；`path` 是 node 上的真实路径（符号链接已解析）。 */
export interface AttachmentListEntry {
  name: string;
  path: string;
  kind: AttachmentListKind;
  /** 文件字节数（只对文件）。 */
  bytes?: number;
  mtime_ms?: number;
}

/**
 * 折在结果体里的稳定码，与 `runs.start` 的 `refs` 拒绝同一组：
 * `refs_invalid`（路径不可用）/ `refs_denied`（deny 目录）/ `refs_outside_roots`（越界）。
 */
export type AttachmentListReason = 'refs_invalid' | 'refs_denied' | 'refs_outside_roots';

export interface AttachmentListResult {
  /** 允许浏览的根；`dir` 省略时只有它。 */
  roots: string[];
  dir?: string;
  /** 上级目录；已在允许根上时缺省。 */
  parent?: string;
  entries: AttachmentListEntry[];
  /** 还有更多条目没返回（达到 `limit`）。 */
  truncated: boolean;
  reason?: AttachmentListReason;
}

export interface AttachmentListParams {
  /** 绝对路径；省略 = 只取 `roots`。相对路径按 node 侧 cwd 解析。 */
  dir?: string;
  /** 列出点开头 / 隐藏项（缺省 false）。 */
  include_hidden?: boolean;
  /** 条数上限（缺省 200、上限 500）；再多请缩小 `dir`。 */
  limit?: number;
}

/** 服务端缺省值（面板与 RPC 用同一组数字）。 */
export const ATTACHMENT_LIST_LIMIT = 200;

/**
 * 附件域客户端方法。
 *
 * `AttachmentsClient` 由 `GatewayClient` 的继承链接进来（见 `index.ts`）；
 * 方法只做一层 `rpc` 包装，不缓存、不自动重试 —— 目录是会变的，读到旧列表比读不到更糟。
 */
export abstract class AttachmentsClient extends IntegrationsClient {
  /** 列 node 上的单层目录（只读）。 */
  listAttachments(params: AttachmentListParams = {}): Promise<AttachmentListResult> {
    return this.rpc<AttachmentListResult>('attachments.list', params);
  }
}
