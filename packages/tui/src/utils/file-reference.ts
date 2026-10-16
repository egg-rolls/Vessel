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
 * 规则：
 * - `@` 必须位于行首或空白之后——`@` 紧跟非空白字符时不算引用（`a@b.com` 不触发）
 * - 路径为 `@` 之后的连续非空白字符，直到空白或行尾
 * - 再用 extractPath 把这段原文收窄成真正的路径（截断全角标点 + 剥尾部标点）
 *
 * 注意：正则前导的空白会被一并消费，故用捕获组取路径、lastIndex 从组末尾继续。
 */
const REFERENCE_PATTERN = /(?:^|\s)@(\S+)/g;

/**
 * 全角标点——中文标点与路径之间**没有空白**，`@a.md，请继续` 的 `，` 会被 `\S+`
 * 一起吞进 token。路径在这一类标点处**截断**（标点后的内容是句子，不是路径）。
 */
const FULL_WIDTH_PUNCTUATION = '，。；：！？）】」』、';

/**
 * 路径尾部要剥掉的标点（半角 + 全角）。半角标点与路径之间通常有空白，
 * 因此只会落在 token 尾部（`@a.md,` / `@a.md。`）。剥掉的字符仍留在用户原文里。
 */
const TRAILING_PUNCTUATION = `,.;:!?)]}"'>${FULL_WIDTH_PUNCTUATION}`;

/**
 * 把 `\S+` 捕获的原文收窄为路径：
 * 1) 在**第一个全角标点**处截断——中文标点后面跟的是句子，不是路径
 * 2) 再从尾部剥掉标点——处理半角标点与全角标点结尾的情况
 * 两步剥完为空则返回空串，调用方当普通文本跳过。
 */
function extractPath(raw: string): string {
  let end = raw.length;
  for (let i = 0; i < raw.length; i++) {
    if (FULL_WIDTH_PUNCTUATION.includes(raw.charAt(i))) {
      end = i;
      break;
    }
  }
  while (end > 0 && TRAILING_PUNCTUATION.includes(raw.charAt(end - 1))) {
    end--;
  }
  return raw.slice(0, end);
}

/** 去掉末尾的替换字符（按字节截断可能切在多字节字符中间，留下半个字符） */
function stripTrailingReplacement(s: string): string {
  return s.endsWith(REPLACEMENT_CHAR) ? s.slice(0, -1) : s;
}

/**
 * 扫描输入中的 `@<路径>` 引用，把每个命中文件读为一条注入消息。
 *
 * - 多 token 按出现顺序；同一路径重复出现也各生成一条（不去重）
 * - 路径在全角标点处截断并剥掉尾部标点（`@a.md，请继续` -> 读 `a.md`）；
 *   剥完为空则当普通文本跳过
 * - 文件不存在 / 读取失败 -> 跳过该 token，并往 `warnings` 加一行告警
 * - 单文件 > 100KB -> 截断，并在注入内容末尾标注
 */
export function collectFileReferences(input: string): FileReferenceResult {
  const messages: Message[] = [];
  const warnings: string[] = [];

  REFERENCE_PATTERN.lastIndex = 0;
  for (let m = REFERENCE_PATTERN.exec(input); m !== null; m = REFERENCE_PATTERN.exec(input)) {
    const path = extractPath(m[1] ?? '');
    // 整段都是标点（如单独的 `@...`）——当普通文本，不算引用
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
