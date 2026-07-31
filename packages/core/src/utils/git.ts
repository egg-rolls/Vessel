/**
 * Git 工具函数
 * @module @vessel/core/utils
 */

/**
 * 获取当前 git branch 名称
 * 失败时返回 undefined（非 git 仓库、git 未安装等情况）
 */
export async function getCurrentGitBranch(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    const branch = output.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}
