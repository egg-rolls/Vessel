/**
 * 粘贴路径的形状校验（S2b 自宿主 attach-paths.ts 迁入，口径逐字保留）。
 *
 * 只做**形状**判定（绝对路径 / 长度 / 条数），与宿主 addRef 一致；路径边界
 * （allowed_roots / deny 目录）只有服务端知道，判定发生在 runs.start 准入闸门，
 * 本文件不重复一份策略。浏览 / 粘贴产物 = addRef + insertAtomic（token 同形）。
 */

/** 单条消息引用上限（与宿主草稿 store MAX_COMPOSER_REFS 同值）。 */
export const MAX_REFS = 32;

/** 单条引用路径字符上限（与 core MESSAGE_REF_PATH_MAX / addRef 同口径）。 */
export const ATTACH_PATH_MAX = 4096;

/** 绝对路径判据（与 addRef 同一份正则）：`/x`、`\x`、`C:\x`、`C:/x`。 */
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/;

export type AttachPathIssueReason = 'absolute' | 'tooLong' | 'tooMany';

export interface AttachPathIssue {
  /** 输入框里的行号（1 起；空行也占一行）。 */
  line: number;
  path: string;
  reason: AttachPathIssueReason;
}

export interface AttachPathRow {
  line: number;
  path: string;
}

export interface AttachPathPlan {
  accepted: AttachPathRow[];
  issues: AttachPathIssue[];
}

/**
 * 多行文本 → 逐行判定（顺序与 addRef 一致：长度 → 绝对路径 → 剩余条数）。
 * 空行跳过；同路径不去重（草稿槽允许同路径多条，删一条只删对应下标）。
 */
export function planAttachPaths(
  text: string,
  existingCount: number,
  max: number = MAX_REFS,
): AttachPathPlan {
  const accepted: AttachPathRow[] = [];
  const issues: AttachPathIssue[] = [];
  const room = Math.max(0, max - Math.max(0, Math.floor(existingCount)));
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const path = (lines[index] ?? '').trim();
    if (path.length === 0) continue;
    const line = index + 1;
    if (path.length > ATTACH_PATH_MAX) {
      issues.push({ line, path, reason: 'tooLong' });
      continue;
    }
    if (!ABSOLUTE_PATH.test(path)) {
      issues.push({ line, path, reason: 'absolute' });
      continue;
    }
    if (accepted.length >= room) {
      issues.push({ line, path, reason: 'tooMany' });
      continue;
    }
    accepted.push({ line, path });
  }
  return { accepted, issues };
}
