/**
 * 附件引用的形状归一（0.52）：`AgentService.dispatch` 与 `TeamService.post` 共用一份。
 *
 * 只认 `{kind, path}` 形状，逐条丢弃其余，条数封顶。
 *
 * 这里**不做**权限判定，也不该做：引用是「用户想让我读这个」，加进来时就拒会把
 * 意图丢掉。路径边界统一在**读文件那一刻**校验（`read` / `media` 的
 * `evaluatePath`，与普通文件工具同一套）。保留这一层是为了内部调用方（dispatch /
 * Team @）也不把半成品形状带进上下文 —— wire 侧的严格校验在 serve 的 handler 里。
 *
 * @module @vessel-agent/agent
 */

import { MESSAGE_REF_PATH_MAX, MESSAGE_REFS_MAX, type MessageRef } from '@vessel-agent/core';

const REF_KINDS: ReadonlySet<string> = new Set(['file', 'image', 'document']);

export function normalizeRefs(value: unknown): MessageRef[] {
  if (!Array.isArray(value)) return [];
  const refs: MessageRef[] = [];
  for (const entry of value) {
    if (refs.length >= MESSAGE_REFS_MAX) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    const path = record.path;
    if (typeof kind !== 'string' || !REF_KINDS.has(kind)) continue;
    // 只传路径：必须是绝对路径（`/…` 或盘符 / UNC），不收 URL、不收相对路径。
    if (typeof path !== 'string' || path.length === 0 || path.length > MESSAGE_REF_PATH_MAX) {
      continue;
    }
    if (!/^(?:[\\/]|[A-Za-z]:[\\/]|\\\\|~[\\/])/.test(path)) continue;
    const ref: MessageRef = { kind: kind as MessageRef['kind'], path };
    if (typeof record.name === 'string' && record.name.length > 0) ref.name = record.name;
    if (typeof record.mime === 'string' && record.mime.length > 0) ref.mime = record.mime;
    if (typeof record.bytes === 'number' && Number.isFinite(record.bytes) && record.bytes >= 0) {
      ref.bytes = Math.floor(record.bytes);
    }
    refs.push(ref);
  }
  return refs;
}
