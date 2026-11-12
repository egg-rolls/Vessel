/**
 * 「成员 cwd」的取值口径（0.51 Bug 1）。
 *
 * 为什么需要一层专门的模块：工具的 cwd 在 0.51 之前只有两个来源 —— `agent.cwd`
 *（全局一份）与 `process.cwd()`（进程属性）。而「成员属于哪个 Team、该 Team 的基础路径
 * 在哪」从来没有进过工具层，于是所有成员都落在网关进程自己的目录。本模块只负责**挑值**
 *（挑哪个候选、要不要丢弃），怎么传下去是 core 的 `ToolContext.cwd` 通道。
 *
 * 两条铁律：
 *
 * 1. **锚点 Team 不参与**。`<dataDir>/default`、`<dataDir>/headless` 是系统按路径派生的
 *    身份锚点，不是用户在成员身上表达过的位置，目录还可能根本不存在
 *    （`ensureForWorkspace` 只按路径算身份、不建目录）。把它们当 cwd 会让 `main` 的
 *    bash / read / edit 直接硬报错 —— 那是把「目录不对」升级成「工具坏了」。
 * 2. **拿不到有效目录就降级，不硬错**。成员 cwd 是派生值（Team 基础路径的快照），用户
 *    没在工具配置里写过它：目录被删 / 换机器 / 快照过期都不该打死这具 body 的工具。
 *    所以这里返回 `degraded` 让调用方 warn 一次，然后什么都不传（由工具退回下一级）。
 *
 * @module @vessel-agent/agent
 */

import { statSync } from 'node:fs';
import { workspaceKey } from './team-slug.js';

/** 成员 cwd 是哪一级给的（诊断 / 测试用） */
export const MEMBER_CWD_SOURCES = ['record', 'team'] as const;

export type MemberCwdSource = (typeof MEMBER_CWD_SOURCES)[number];

export interface MemberCwdPick {
  /** 可用的绝对路径；`undefined` = 没有可用候选（调用方退回 `agent.cwd` / `process.cwd()`） */
  cwd?: string;
  /** 值是哪一级给的 */
  source?: MemberCwdSource;
  /**
   * 降级说明：候选存在但不可用（`not_a_directory`）或压根没有候选（`none`）。
   * 只有 `not_a_directory` 值得 warn —— `none` 是绝大多数 unbound 成员的常态。
   */
  degraded?: 'none' | 'not_a_directory';
  /** 被丢弃的候选（`not_a_directory` 时用于日志） */
  rejected?: string;
}

/** 目录存在且是目录；任何 fs 错误都算「不可用」（不抛） */
export function isUsableDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 归一化比较键；路径本身非法（空串 / 无法解析）时返回 `undefined`，调用方当作「不是锚点」。
 *
 * 用 `workspaceKey` 而不是字符串相等：Team workspace 存的是归一化绝对路径，而 dataDir
 * 派生的锚点可能与它差在大小写 / 尾分隔符 / symlink 写法上（Windows 尤其）。
 */
function keyOf(candidate: string): string | undefined {
  if (candidate.trim() === '') return undefined;
  try {
    return workspaceKey(candidate);
  } catch {
    return undefined;
  }
}

/**
 * 是否属于「系统锚点」workspace（`<dataDir>/default` / `<dataDir>/headless`）。
 *
 * 判据是**路径相等**（归一化比较键），不是前缀：路径与锚点同键就意味着它本来就是同一个
 * 目录，那时把它当 cwd 同样是拿一个「只用于算身份」的路径去用。
 */
export function isAnchorWorkspace(
  workspace: string,
  anchors: readonly string[] | undefined,
): boolean {
  if (anchors === undefined || anchors.length === 0) return false;
  const key = keyOf(workspace);
  if (key === undefined) return false;
  return anchors.some((anchor) => keyOf(anchor) === key);
}

export interface ResolveMemberCwdInput {
  /** create 时烧进记录的显式 Team 基础路径（方案 C 的快照） */
  recordCwd?: string;
  /** 运行期按 teamId 兜底解析出的 Team 基础路径（`cwdFor`） */
  teamCwd?: string;
}

/**
 * Team workspace → 成员 cwd（锚点排除的**唯一**判据）。
 *
 * `create` 烧快照与装配层 `cwdFor` 都走这一条：两处各写一遍锚点判断迟早会分叉，
 * 而只要漏一处，`main` 就会拿到 `<dataDir>/default`，工具面直接报「目录不存在」。
 */
export function memberCwdFromTeam(
  workspace: string | undefined,
  anchors: readonly string[] | undefined,
): string | undefined {
  if (workspace === undefined) return undefined;
  return isAnchorWorkspace(workspace, anchors) ? undefined : workspace;
}

/**
 * 挑一个可用的成员 cwd。
 *
 * 顺序固定：**记录快照**（用户在 create 时选定那一刻的值）> **Team 兜底**（运行期按记录里
 * 的 `team_id` 重查）。两级都不可用时返回 `degraded: 'not_a_directory'` + 被丢弃的候选，
 * 让调用方 warn 一次后按「没有成员 cwd」处理。
 *
 * 不做 `~` 展开也不做相对路径解析：能进这两个字段的值必须已经是绝对路径
 *（`TeamRecord.workspace` 由 `normalizeWorkspace` 归一化为绝对路径）。
 */
export function resolveMemberCwd(input: ResolveMemberCwdInput): MemberCwdPick {
  const candidates: Array<{ source: MemberCwdSource; value: string | undefined }> = [
    { source: 'record', value: input.recordCwd },
    { source: 'team', value: input.teamCwd },
  ];
  let rejected: string | undefined;
  for (const candidate of candidates) {
    const value = candidate.value;
    if (value === undefined || value.trim() === '') continue;
    if (isUsableDirectory(value)) return { cwd: value, source: candidate.source };
    rejected ??= value;
  }
  return rejected === undefined ? { degraded: 'none' } : { degraded: 'not_a_directory', rejected };
}
