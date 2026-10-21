/**
 * `vessel completion <bash|zsh|fish|powershell>`（0.18）。
 *
 * 向 stdout 打印可直接 source / 加载的补全脚本；成功退出 0。
 * 无参数 / 未知 shell：用法写 stderr，退出码 1。
 *
 * 纯静态输出：只读 `completion-spec.ts`，不加载配置、不启动 runtime、不联网。
 *
 * @module vessel/completion-command
 */

import { renderCompletionScript } from './completion-script';
import type { CompletionCommandArgs } from './completion-spec';
import { t } from './i18n';

/** 执行补全命令；返回进程退出码 */
export function runCompletionCommand(command: CompletionCommandArgs): number {
  if (command.shell === null) {
    const usage = t('completion.usage');
    const message =
      command.requested === null
        ? usage
        : `${t('completion.unknownShell', { shell: command.requested })}\n${usage}`;
    console.error(message);
    return 1;
  }
  process.stdout.write(renderCompletionScript(command.shell));
  return 0;
}
