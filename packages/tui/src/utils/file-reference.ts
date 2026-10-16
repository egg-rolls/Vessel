/**
 * `@path` 文件引用展开（C10，前端职责——core 只收消息）
 * @module @vessel/tui/utils
 *
 * REPL 输入里的 `@<路径>` 在发送前展开为注入消息（走 Runtime.run 的 `RunOptions.messages`），
 * 交给 core 前置于用户输入。core 不认识「引用」这个概念，只知道「本轮要注入的消息」。
 *
 * 用户原文不被修改：`@path` token 保留在发送的文本里。
 */

import { readFileSync } from 'node:fs';
import type { Message } from '@vessel/core';

/** 单文件注入上限（字节）。超出则截断并在内容末尾标注 */
export const MAX_FILE_BYTES = 102400; // 100KB

/** U+FFFD——Buffer 按字节截断/解码失败时的替换字符 */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

export interface FileReferenceResult {
  /** 每个命中的文件一条 user role 消息；顺序与出现顺序一致 */
  messages: Message[];
  /** 读不到的文件等告警文案，调用方负责展示 */
  warnings: string[];
}

/**
 * 匹配 `@<路径>` token。
 *
 * 规则（C10）：
 * - `@` 必须位于行首或空白之后——`@` 紧跟非空白字符时不算引用（`a@b.com` 不触发）
 * - 路径为 `@` 之后的连续非空白字符，直到空白或行尾
 *
 * 注意：正则前导的空白会被一并消费，故用捕获组取路径、lastIndex 从组末尾继续。
 */
const REFERENCE_PATTERN = /(?:^|\s)@(\S+)/g;

/** 去掉末尾的替换字符（按字节截断可能切在多字节字符中间，留下半个字符） */
function stripTrailingReplacement(s: string): string {
  return s.endsWith(REPLACEMENT_CHAR) ? s.slice(0, -1) : s;
}

/**
 * 扫描输入中的 `@<路径>` 引用，把每个命中文件读为一条注入消息。
 *
 * - 多 token 按出现顺序；同一路径重复出现也各生成一条（不去重）
 * - 文件不存在 / 读取失败 -> 跳过该 token，并往 `warnings` 加一行告警
 * - 单文件 > 100KB -> 截断，并在注入内容末尾标注
 */
export function collectFileReferences(input: string): FileReferenceResult {
  const messages: Message[] = [];
  const warnings: string[] = [];

  REFERENCE_PATTERN.lastIndex = 0;
  for (let m = REFERENCE_PATTERN.exec(input); m !== null; m = REFERENCE_PATTERN.exec(input)) {
    const path = m[1];
    if (!path) continue;

    let text: string;
    try {
      const buf = readFileSync(path);
      if (buf.byteLength > MAX_FILE_BYTES) {
        const head = stripTrailingReplacement(buf.subarray(0, MAX_FILE_BYTES).toString('utf8'));
        text = `${head}\n[truncated: file is ${buf.byteLength} bytes, showing first ${MAX_FILE_BYTES} bytes]`;
      } else {
        text = stripTrailingReplacement(buf.toString('utf8'));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Warning: cannot read referenced file "${path}": ${reason}`);
      continue;
    }

    messages.push({
      role: 'user',
      content: `<file path="${path}">\n${text}\n</file>`,
    });
  }

  return { messages, warnings };
}
