/**
 * `@path` 文件引用展开（C10，前端职责——core 只收消息）
 * @module @vessel/tui/utils
 *
 * REPL 输入里的 `@<路径>` 在发送前展开为注入消息（走 Runtime.run 的 `RunOptions.messages`），
 * 交给 core 前置于用户输入。core 不认识「引用」这个概念，只知道「本轮要注入的消息」。
 *
 * 用户原文不被修改：`@path` token 保留在发送的文本里。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@vessel/core';

/** 单文件注入上限（字节）。超出则截断并在内容末尾标注 */
export const MAX_FILE_BYTES = 102400; // 100KB

/** U+FFFD——Buffer 按字节截断/解码失败时的替换字符 */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

export interface FileReferenceInfo {
  /** 实际解析到的路径（已展开 ~ / 已去掉 :line 与 #anchor） */
  path: string;
  /** 原文件字节数 */
  bytes: number;
  /** 是否因超过 100KB 被截断 */
  truncated: boolean;
}

export interface FileReferenceResult {
  /** 每个命中的文件一条 user role 消息；顺序与出现顺序一致 */
  messages: Message[];
  /** 读不到的文件等告警文案，调用方负责展示 */
  warnings: string[];
  /** 成功注入的文件信息（供 UI 显示引用行） */
  references: FileReferenceInfo[];
}

/**
 * 匹配 `@<路径>` token。
 *
 * 规则：
 * - `@` 必须位于行首、空白之后，或开括号/引号之后（`(@a.md)`、`"@a.md"` 也识别）；
 * - `a@b.com` 这类紧贴字母的 `@` 不触发；
 * - 路径为 `@` 之后的连续非空白字符，直到空白或行尾；
 * - 再用 extractPath 把这段原文收窄成真正的路径（截断全角标点 + 剥尾部标点）。
 *
 * 注意：正则前导的边界字符会被一并消费，故用捕获组取路径、lastIndex 从组末尾继续。
 */
const REFERENCE_PATTERN = /(?:^|[\s([{（【「『《〈"'“‘])@(\S+)/g;

/**
 * 全角标点——中文标点与路径之间**没有空白**，`@a.md，请继续` 的 `，` 会被 `\S+`
 * 一起吞进 token。路径在这一类标点处**截断**（标点后的内容是句子，不是路径）。
 */
const FULL_WIDTH_PUNCTUATION = '，。；：！？）】」』、”’》〉］｝…～';

/**
 * 路径尾部要剥掉的标点（半角 + 全角）。半角标点与路径之间通常有空白，
 * 因此只会落在 token 尾部（`@a.md,` / `@a.md。`）。剥掉的字符仍留在用户原文里。
 */
const TRAILING_PUNCTUATION = `,.;:!?)]}"'>'${FULL_WIDTH_PUNCTUATION}`;

/**
 * 把 `\S+` 捕获的原文收窄为路径：
 * 1) 在**第一个全角标点**处截断——中文标点后面跟的是句子，不是路径
 * 2) 再从尾部剥掉标点——处理半角标点与全角标点结尾的情况
 * 两步剥完为空则返回空串，调用方当普通文本跳过。
 */
export function extractPath(raw: string): string {
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

/** 展开 `~` / `~/` / `~\` 为 home 目录；其它原样返回 */
export function expandHome(raw: string): string {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * 把用户写出的引用收窄成实际路径。按优先级尝试：
 * 1. 原样（文件名本身含 `#` 或 `:12` 时优先命中）；
 * 2. 去掉尾部 `:行[:列]`；
 * 3. 去掉 `#anchor`；
 * 4. 同时去掉两者。
 * 全部不存在时返回原样（让调用方给出原始路径的 warning）。
 */
export function resolveReferencePath(raw: string): string {
  const expanded = expandHome(raw);
  const withoutLine = expanded.replace(/:\d+(?::\d+)?$/, '');
  const withoutHash = expanded.split('#')[0] ?? expanded;
  const withoutBoth = withoutHash.replace(/:\d+(?::\d+)?$/, '');
  const candidates = [expanded, withoutLine, withoutHash, withoutBoth];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return expanded;
}

/** 粗略二进制判定：前 8KB 出现 NUL 即视为二进制 */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 扫描输入中的 `@<路径>` 引用，把每个命中文件读为一条注入消息。
 *
 * - 多 token 按出现顺序；同一路径重复出现也各生成一条（不去重）
 * - 路径在全角标点处截断并剥掉尾部标点（`@a.md，请继续` -> 读 `a.md`）；
 *   剥完为空则当普通文本跳过
 * - `:行[:列]` / `#anchor` / `~` 按 resolveReferencePath 的优先级解析
 * - 文件不存在 / 读取失败 / 二进制 -> 跳过该 token，并往 `warnings` 加一行告警
 * - 单文件 > 100KB -> 截断，并在注入内容末尾标注
 */
export function collectFileReferences(input: string): FileReferenceResult {
  const messages: Message[] = [];
  const warnings: string[] = [];
  const references: FileReferenceInfo[] = [];

  REFERENCE_PATTERN.lastIndex = 0;
  for (let m = REFERENCE_PATTERN.exec(input); m !== null; m = REFERENCE_PATTERN.exec(input)) {
    const rawPath = extractPath(m[1] ?? '');
    // 整段都是标点（如单独的 `@...`）——当普通文本，不算引用
    if (!rawPath) continue;

    const path = resolveReferencePath(rawPath);

    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Warning: cannot read referenced file "${path}": ${reason}`);
      continue;
    }

    if (looksBinary(buf)) {
      warnings.push(`Warning: skipped binary file "${path}"`);
      continue;
    }

    const truncated = buf.byteLength > MAX_FILE_BYTES;
    let text: string;
    if (truncated) {
      const head = stripTrailingReplacement(buf.subarray(0, MAX_FILE_BYTES).toString('utf8'));
      text = `${head}\n[truncated: file is ${buf.byteLength} bytes, showing first ${MAX_FILE_BYTES} bytes]`;
    } else {
      text = stripTrailingReplacement(buf.toString('utf8'));
    }

    messages.push({
      role: 'user',
      content: `<file path="${path}">\n${text}\n</file>`,
    });
    references.push({ path, bytes: buf.byteLength, truncated });
  }

  return { messages, warnings, references };
}
