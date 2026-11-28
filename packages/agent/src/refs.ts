/**
 * 附件引用的形状归一（0.52）：`AgentService.dispatch` 与 `TeamService.post` 共用一份。
 *
 * 只认 `{kind, path}` 形状，逐条丢弃其余，条数封顶。
 * file-ref-ux A1：`inline?` 同形透传（只写 true 键；缺省 = 不内联）。
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
    // 0.56：内容地址原样保留（64 位小写十六进制）。丢了它 = 重放/恢复后 blob 寻址退化成
    // path = 每次请求重新读文件 = 前缀守卫报 prompt.prefix_changed（design §10 风险 3）。
    if (typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256)) {
      ref.sha256 = record.sha256;
    }
    if (typeof record.bytes === 'number' && Number.isFinite(record.bytes) && record.bytes >= 0) {
      ref.bytes = Math.floor(record.bytes);
    }
    // file-ref-ux A1：逐条内联开关同形透传。只写 `true` 键（false ≡ 缺省 = 不内联，
    // 旧生产者形状逐字节不变）；入池闸在装配层按它判定，这里不做语义判定。
    if (record.inline === true) ref.inline = true;
    refs.push(ref);
  }
  return refs;
}
