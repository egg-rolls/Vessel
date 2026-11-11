/**
 * 「引用文件」入口的路径解析与形状校验（纯函数，0.52 粘贴路径）。
 *
 * 为什么是粘贴路径：浏览器的文件选择只给 `File`（`name` / `webkitRelativePath`），
 * 拿不到本地绝对路径；而 `Message.refs` 只带路径，正文由 agent 用 `read` 按需取。
 * 所以这一版入口只收「一行一个绝对路径」，**不读文件内容、不上传、不新增 RPC**。
 *
 * 这里只做**形状**判定（绝对路径 / 长度 / 条数），口径与 `addRef` 一致；
 * 路径边界（`allowed_roots` / deny 目录）只有服务端知道，判定发生在 `runs.start`
 * 的准入闸门里（越界被拒 → `refsErrorText` 变人话），本文件不重复一份策略。
 */
import { MAX_COMPOSER_REFS } from '../../stores/composerDraftStore';

/** 单条引用路径的字符上限（与 core `MESSAGE_REF_PATH_MAX` / `addRef` 同一口径）。 */
export const ATTACH_PATH_MAX = 4096;

/** 绝对路径判据（与 `addRef` 同一份正则）：`/x`、`\x`、`C:\x`、`C:/x`。 */
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** 一行没通过校验的原因（决定 i18n key，不外泄成自由文本）。 */
export type AttachPathIssueReason = 'absolute' | 'tooLong' | 'tooMany';

/** 一行没通过校验：行号 + 原因，用于「哪一条不行 + 为什么」。 */
export interface AttachPathIssue {
  /** 输入框里的行号（1 起；空行也占一行，与用户看到的一致）。 */
  line: number;
  /** 该行原始路径（已 trim）。 */
  path: string;
  reason: AttachPathIssueReason;
}

/** 通过校验的一行。 */
export interface AttachPathRow {
  line: number;
  path: string;
}

export interface AttachPathPlan {
  /** 通过形状校验、按行序待加入的行。 */
  accepted: AttachPathRow[];
  /** 没通过的行（顺序 = 行序）；空数组表示这次可以整批加完。 */
  issues: AttachPathIssue[];
}

/**
 * 多行文本 → 逐行判定。
 *
 * 顺序与 `addRef` 一致：先看长度（超过 {@link ATTACH_PATH_MAX} 直接拒），再看是不是
 * 绝对路径，最后看剩余条数（`max - existingCount`）。空行 / 纯空白行直接跳过（不算错误）。
 * 同一路径出现两次**不去重**：草稿槽本来就允许同一路径两个 chip，删一个只删对应下标。
 */
export function planAttachPaths(
  text: string,
  existingCount: number,
  max: number = MAX_COMPOSER_REFS,
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
