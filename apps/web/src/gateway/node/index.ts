/**
 * Node 客户端最终组合：域方法由抽象类链逐层加入。
 *
 * 0.49 G1：目录由 `client/` 迁到 `node/`，显式表达“这是连 node（/v1/rpc、
 * /v1/events）的客户端”；平台客户端在平台客户端目录，两者互不 import。
 */

import { AttachmentsClient } from './attachments';

export class GatewayClient extends AttachmentsClient {}

export type {
  AttachmentListEntry,
  AttachmentListKind,
  AttachmentListParams,
  AttachmentListReason,
  AttachmentListResult,
} from './attachments';
export { ATTACHMENT_LIST_LIMIT } from './attachments';

export type { ConnectionState, EventMeta } from './protocol';
export { GatewayHttpError } from './protocol';
