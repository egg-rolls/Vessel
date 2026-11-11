/**
 * 附件引用闸门：`runs.start` 的 refs 在**准入前**判定路径边界（0.52）。
 *
 * 三条理由：
 * - 引用一旦落盘（`user.message` → SessionState）就收不回来 —— 会话历史是事实源；
 * - 模型侧按路径读文件（多模态解析器插件的 `media` 工具）走的正是 read 工具那套边界，
 *   引用先放行再在工具侧拒，等于让人以为附件已经附上了；
 * - 判定只能有一套：这里复用 `@vessel-agent/basic-tools` 的 `buildPathBoundary` /
 *   `evaluatePath` / `canonicalPath`，不复制第二套前缀比较（realpath、deny 优先级、
 *   `~` 展开都跟着工具走）。
 *
 * 判定口径（与工具的差别只有一条「不在运行时问」）：
 * - `deny`（内置 `~/.ssh` / `~/.aws` / `~/.gnupg` / 用户配置 `deny_paths`）→ 硬拒；
 * - `ask`（配置了 `allowed_roots` 且在根外）→ 同样硬拒：引用没有「加进来再问」的
 *   中间态，一个未经确认的路径一旦进历史，后面每一轮请求都带着它；
 * - `allow` → 放行。
 *
 * 边界来源是 `basic-tools` 的安装配置（`allowed_roots` / `deny_paths` / `cwd`），
 * 与工具同一份；装配层传 getter，热应用后按新配置重建（配置指纹变了才重建）。
 *
 * @module vessel/refs-gate
 */

import * as path from 'node:path';
import type { VesselConfig } from '../packages/config/src/index';
import type { MessageRef } from '../packages/core/src/index';
import type { RefsVerdict } from '../packages/serve/src/gateway/methods/runs.js';
import {
  buildPathBoundary,
  canonicalPath,
  evaluatePath,
  type PathBoundary,
  parseBasicToolsConfig,
} from '../plugins/tools/basic-tools/src/index';
import { resolveAgentCwd } from './path-resolution';
import { buildPluginConfigMap, declarativePluginEntries } from './plugin-config';

/** 闸门签名：通过返回 `undefined`，拒绝返回稳定码 + 被拒的那条路径。 */
export type RefsGate = (refs: readonly MessageRef[]) => RefsVerdict | undefined;

export interface RefsGateOptions {
  /**
   * 当前 `basic-tools` 的安装配置（`plugins[]` 里的 `config`，未配置时 `undefined`）。
   *
   * 传 getter 而不是快照：热应用（`gateway.reload` / `plugins.reload`）只改配置对象，
   * gateway 实例不重建，闸门必须自己看到新值。
   */
  getConfig: () => Record<string, unknown> | undefined;
}

/** 只展开开头的 `~`（与工具的 `expandHome` 同口径；相对路径不解析）。 */
function expandHome(target: string): string {
  if (target === '~') return process.env.HOME ?? target;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return home === undefined ? target : path.join(home, target.slice(2));
  }
  return target;
}

/**
 * 绝对路径判定：POSIX `/…`、Windows 盘符 `C:\…` 与 UNC `\\server\…` 都算。
 *
 * 不用 `node:path.isAbsolute` 单判：它的结果随宿主平台变（在 Linux 上 `C:\x` 不算绝对），
 * 而 gateway 可能被 Windows 上的浏览器驱动，refs 里的路径来自同一台宿主的路径风格。
 */
function isAbsolutePath(target: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(target);
}

export function createRefsGate(options: RefsGateOptions): RefsGate {
  /** 上次构建边界的配置指纹与实例（`buildPathBoundary` 会做 realpath，不便宜）。 */
  let fingerprint: string | undefined;
  let boundary: PathBoundary | undefined;

  const boundaryOf = (config: Record<string, unknown> | undefined): PathBoundary => {
    const next = JSON.stringify(config ?? {});
    if (boundary === undefined || fingerprint !== next) {
      boundary = buildPathBoundary(parseBasicToolsConfig(config));
      fingerprint = next;
    }
    return boundary;
  };

  return (refs) => {
    if (refs.length === 0) return undefined;
    const current = boundaryOf(options.getConfig());
    for (const ref of refs) {
      const raw = expandHome(ref.path);
      if (!isAbsolutePath(raw)) return { reason: 'refs_invalid', path: ref.path };
      const decision = evaluatePath(canonicalPath(raw), current);
      if (decision === 'deny') return { reason: 'refs_denied', path: ref.path };
      if (decision === 'ask') return { reason: 'refs_outside_roots', path: ref.path };
    }
    return undefined;
  };
}

/**
 * 从活配置构造闸门（装配层唯一入口）。
 *
 * 传 `() => config`：热应用会替换 `config` 的字段，闸门每次判定按当前值取
 * `basic-tools` 安装配置 —— 与工具自己安装时读到的是同一份（`buildPluginConfigMap`
 * 的合并顺序也一致：声明式条目先、显式 `plugins[].config` 覆盖、`agent.cwd` 兜底）。
 */
export function createConfigRefsGate(getConfig: () => VesselConfig): RefsGate {
  return createRefsGate({
    getConfig: () => {
      const current = getConfig();
      return buildPluginConfigMap(
        current.plugins,
        declarativePluginEntries(current),
        resolveAgentCwd(current),
      )['basic-tools'];
    },
  });
}
