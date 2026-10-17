/**
 * Run 选项（F1：从 runtime 移到 types，Kernel 只依赖 port 类型）
 * @module @vessel/core/types
 */

import type { Message } from './provider.js';

/** Run 选项 */
export interface RunOptions {
  /** AbortSignal——设置后可在外部中断 run()（Hermes/Claude Code 模式） */
  signal?: AbortSignal;
  /** 当前 git branch——app 层采集，core 透传存入 RunState.branch */
  branch?: string;
  /**
   * 本轮请求前置注入的消息。core 不解释其来源与语义——
   * skill 内容、附件、引用文件、项目约定，任何要进语言空间的文本都走这里。
   * 写入顺序：注入消息在前，用户输入在后；两者都持久化进 ContextManager。
   */
  messages?: Message[];
}
