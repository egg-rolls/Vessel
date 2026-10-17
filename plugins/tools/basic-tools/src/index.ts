/**
 * @vessel/basic-tools - 基础工具插件（bash / read / edit）
 * @module @vessel/basic-tools
 *
 * 本项目唯一的工具包，只提供三个互不可替代的工具：
 * - `bash`：执行任意 shell 命令（grep / cat / ls / mkdir / curl …… 全部由它承担），权限 ask
 * - `read`：带行号读文件（支持 offset/limit），权限 allow
 * - `edit`：精确且唯一匹配的字符串替换，权限 ask
 *
 * 危险操作（bash / edit）经 `checkPermission` → `requestPermission` 等用户授权（ADR-029）。
 * 三个工具都不做沙箱/白名单/路径穿越防护——权限判定是唯一关口。
 */

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Plugin, PluginHost, ToolDefinition } from '@vessel/core';
import { requestPermission } from '@vessel/permission';

// ── 常量 ──────────────────────────────────────────

/** bash 缺省超时（毫秒） */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** 单方向输出超过该行数即触发截断 */
const MAX_OUTPUT_LINES = 2000;

/** 截断后保留的头行数 */
const KEEP_HEAD_LINES = 1000;

/** 截断后保留的尾行数 */
const KEEP_TAIL_LINES = 1000;

/** read 缺省读取行数 */
const DEFAULT_READ_LIMIT = 2000;

/** 单方向输出最多保留的字节数（超出即丢弃并标注，避免无换行输出撑爆内存） */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** read 允许的最大文件字节数（超过直接拒绝，提示用 bash 分块） */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * 进程已退出后，最多再等管道排空多久（毫秒）。
 * 命令被 kill 时，它派生的孙进程（如 `bash -c 'sleep 10'` 里的 sleep）仍持有管道写端，
 * 管道不会关闭——硬等会永久挂住，超时兜底后带着已读到的输出返回。
 */
const DRAIN_GRACE_MS = 300;

// ── 参数与文本工具 ────────────────────────────────

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从记录安全读取字符串字段（非字符串返回空串） */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** 从记录安全读取数字字段（非有限数字返回 undefined） */
function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 按 `\n` 切分文本，去掉每行尾部的 `\r`（CRLF 显示归一），
 * 并丢掉末尾换行产生的空元素。「a\nb\nc\n」= 3 行、「」= 0 行。
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 把 CRLF 归一为 LF（显示用；edit 仍按原始字节匹配） */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** 单方向输出超限时保留头尾，中间标注省略行数 */
function truncateLines(text: string): string {
  const lines = splitLines(text);
  if (lines.length <= MAX_OUTPUT_LINES) return text;
  const head = lines.slice(0, KEEP_HEAD_LINES);
  const tail = lines.slice(lines.length - KEEP_TAIL_LINES);
  const omitted = lines.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;
  return [...head, `...（已省略 ${omitted} 行）...`, ...tail].join('\n');
}

/**
 * 替换首个匹配。
 * 刻意不用 `String.prototype.replace`——它的字符串替换会把 `$&`、`$1` 当特殊模式解释，
 * 而 old_string/new_string 是代码文本，必须逐字符原样写入。
 */
function replaceFirst(text: string, search: string, replacement: string): string {
  const index = text.indexOf(search);
  if (index < 0) return text;
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}

/** 统计 search 在 text 中的出现次数（非重叠） */
function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

/** 最多等 ms 毫秒，不等 promise 到底 */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 管道泵：边读边存进 sink（可中途 cancel 取走已读内容） */
interface Pump {
  /** 读到 EOF（或被取消）后 resolve */
  done: Promise<void>;
  /** 放弃剩余读取，解开挂在 read() 上的等待 */
  cancel: () => void;
}

/** 单方向输出缓冲：字节上限之外的 chunk 只读不存 */
interface OutputSink {
  chunks: string[];
  bytes: number;
  truncated: boolean;
}

/** 新建输出缓冲 */
function createSink(): OutputSink {
  return { chunks: [], bytes: 0, truncated: false };
}

/** 把子进程管道泵成文本（超过 MAX_OUTPUT_BYTES 的部分丢弃并标记截断） */
function pumpStream(stream: ReadableStream<Uint8Array>, sink: OutputSink): Pump {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value) continue;
        if (sink.bytes >= MAX_OUTPUT_BYTES) {
          sink.truncated = true;
          continue;
        }
        sink.chunks.push(decoder.decode(chunk.value, { stream: true }));
        sink.bytes += chunk.value.byteLength;
        if (sink.bytes >= MAX_OUTPUT_BYTES) sink.truncated = true;
      }
      const tail = decoder.decode();
      if (tail && sink.bytes < MAX_OUTPUT_BYTES) sink.chunks.push(tail);
    } catch {
      // 管道被强制关闭——已读到的内容仍然可用
    }
  })();
  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

// ── bash ─────────────────────────────────────────

/** 组装 bash 返回文本：退出码 + 非空输出段（行数或字节超限时截断并标注） */
function formatBashResult(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  timeoutMs: number;
}): string {
  const parts: string[] = [];
  if (result.timedOut) {
    parts.push(`错误：命令执行超时（已超过 ${result.timeoutMs}ms），进程已被终止。`);
  }
  parts.push(`退出码: ${result.exitCode ?? 'null（进程被信号终止）'}`);

  const stdout = truncateLines(normalizeNewlines(result.stdout));
  if (result.stdout.trim() !== '') {
    const marker = result.stdoutTruncated ? '\n...（输出超过 2MB，已截断）...' : '';
    parts.push(`stdout:\n${stdout}${marker}`);
  }

  const stderr = truncateLines(normalizeNewlines(result.stderr));
  if (result.stderr.trim() !== '') {
    const marker = result.stderrTruncated ? '\n...（输出超过 2MB，已截断）...' : '';
    parts.push(`stderr:\n${stderr}${marker}`);
  }
  return parts.join('\n');
}

/** 启动 `bash -c`；返回类型交给 Bun.spawn 推导（手写 Subprocess 泛型参数极易踩错） */
function spawnBash(command: string, cwd: string | undefined) {
  return Bun.spawn({
    cmd: ['bash', '-c', command],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

/** 执行 bash 命令；超时返回错误文本，不抛异常 */
async function runBash(args: unknown): Promise<string> {
  if (!isRecord(args)) return '错误：bash 需要 { command: string }';
  const command = readString(args, 'command');
  // 纯空白命令是无意义的一次调用，直接挡掉（否则白烧一轮）
  if (command.trim() === '') return '错误：command 不能为空';

  const cwd = readString(args, 'cwd');
  if (cwd !== '' && !existsSync(cwd)) return `错误：cwd 不存在：${cwd}`;

  const timeoutMs = readNumber(args, 'timeout_ms') ?? DEFAULT_BASH_TIMEOUT_MS;
  if (timeoutMs <= 0) return '错误：timeout_ms 必须为正数';

  let proc: ReturnType<typeof spawnBash>;
  try {
    proc = spawnBash(command, cwd === '' ? undefined : cwd);
  } catch (error) {
    return `错误：无法启动 bash：${String(error)}`;
  }

  // 先挂上读取再等退出，否则大输出会把子进程写管道堵死
  const stdoutSink = createSink();
  const stderrSink = createSink();
  const stdoutPump = pumpStream(proc.stdout, stdoutSink);
  const stderrPump = pumpStream(proc.stderr, stderrSink);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  await waitAtMost(Promise.all([stdoutPump.done, stderrPump.done]), DRAIN_GRACE_MS);
  // 孙进程可能仍握着管道写端：主动放弃剩余读取，别让一次超时把整轮对话挂死
  stdoutPump.cancel();
  stderrPump.cancel();

  return formatBashResult({
    exitCode: proc.exitCode,
    stdout: stdoutSink.chunks.join(''),
    stderr: stderrSink.chunks.join(''),
    stdoutTruncated: stdoutSink.truncated,
    stderrTruncated: stderrSink.truncated,
    timedOut,
    timeoutMs,
  });
}

const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command in bash and return merged stdout/stderr with the exit code. ' +
    'Use it for everything that has no dedicated tool: finding/listing files, batch ' +
    'edits, git, builds, tests, HTTP requests.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to run' },
      cwd: { type: 'string', description: 'Working directory (defaults to process cwd)' },
      timeout_ms: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS})`,
      },
    },
    required: ['command'],
  },
  checkPermission: async (input, ctx) => requestPermission(ctx, 'bash', input),
  handler: async (args: unknown) => runBash(args),
};

// ── read ─────────────────────────────────────────

/** 读出带行号的文本片段（行号从 1 开始，`<行号>\t<内容>`） */
function readFileSlice(args: unknown): string {
  if (!isRecord(args)) return '错误：read 需要 { path: string }';
  const inputPath = readString(args, 'path');
  if (inputPath === '') return '错误：path 不能为空';

  const absolute = path.resolve(inputPath);
  if (!existsSync(absolute)) return `错误：文件不存在：${inputPath}`;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolute);
  } catch (error) {
    return `错误：无法访问 ${inputPath}：${String(error)}`;
  }
  if (stat.isDirectory()) return `错误：${inputPath} 是目录，不是文件（用 bash 列出目录）`;
  if (!stat.isFile()) return `错误：${inputPath} 不是普通文件`;
  if (stat.size > MAX_READ_BYTES) {
    return `错误：文件过大（${stat.size} 字节，上限 ${MAX_READ_BYTES} 字节）。请用 bash 分块读取（如 sed -n '1,2000p'）。`;
  }

  let text: string;
  try {
    text = readFileSync(absolute, 'utf-8');
  } catch (error) {
    return `错误：读取失败：${String(error)}`;
  }
  if (text.includes('\0')) {
    return `错误：${inputPath} 看起来是二进制文件（含 NUL 字节），read 只处理文本。`;
  }

  const lines = splitLines(text);
  const total = lines.length;
  if (total === 0) return `（空文件：${inputPath}）`;

  const offset = readNumber(args, 'offset') ?? 1;
  if (!Number.isInteger(offset) || offset < 1) {
    return '错误：offset 必须是不小于 1 的整数（行号从 1 开始）';
  }
  if (offset > total) {
    return `错误：offset（${offset}）超过文件总行数（${total}）`;
  }

  const limit = readNumber(args, 'limit') ?? DEFAULT_READ_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    return '错误：limit 必须是不小于 1 的整数';
  }

  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((line, index) => `${offset + index}\t${line}`).join('\n');
  const lastLine = offset - 1 + slice.length;

  if (lastLine < total) {
    return `${numbered}\n\n已截断，共 ${total} 行，用 offset/limit 继续读（本次已读第 ${offset}-${lastLine} 行）`;
  }
  return numbered;
}

const readTool: ToolDefinition = {
  name: 'read',
  description:
    'Read a text file and return its content with line numbers (1-based, `<line>\\t<content>`). ' +
    `Use offset/limit to page through large files (limit defaults to ${DEFAULT_READ_LIMIT} lines).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      offset: { type: 'number', description: 'First line to read (1-based, default 1)' },
      limit: {
        type: 'number',
        description: `How many lines to read (default ${DEFAULT_READ_LIMIT})`,
      },
    },
    required: ['path'],
  },
  // 只读操作，无副作用：无需用户授权
  checkPermission: async () => 'allow',
  handler: async (args: unknown) => readFileSlice(args),
};

// ── edit ─────────────────────────────────────────

/**
 * 原子写：先写同目录临时文件再 rename，避免写一半崩溃把原文件截断。
 * 失败时清理临时文件并把错误留给调用方格式化。
 */
function writeFileAtomic(absolutePath: string, content: string): void {
  const tempPath = `${absolutePath}.vessel-tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件可能未创建，忽略
    }
    throw error;
  }
}

/** 精确且唯一匹配的字符串替换；多处替换必须显式 replace_all */
function editFile(args: unknown): string {
  if (!isRecord(args)) return '错误：edit 需要 { path, old_string, new_string }';
  const inputPath = readString(args, 'path');
  const oldString = readString(args, 'old_string');
  const newString = readString(args, 'new_string');
  if (inputPath === '') return '错误：path 不能为空';
  if (oldString === '') return '错误：old_string 不能为空';

  const absolute = path.resolve(inputPath);
  if (!existsSync(absolute)) return `错误：文件不存在：${inputPath}`;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolute);
  } catch (error) {
    return `错误：无法访问 ${inputPath}：${String(error)}`;
  }
  if (stat.isDirectory()) return `错误：${inputPath} 是目录，不是文件`;
  if (!stat.isFile()) return `错误：${inputPath} 不是普通文件`;

  let original: string;
  try {
    original = readFileSync(absolute, 'utf-8');
  } catch (error) {
    return `错误：读取失败：${String(error)}`;
  }

  const count = countOccurrences(original, oldString);
  if (count === 0) {
    const crlfHint =
      original.includes('\r\n') && oldString.includes('\n') && !oldString.includes('\r\n')
        ? ' 该文件使用 CRLF 换行：old_string 里的换行需要写成 \\r\\n，或先用 bash 归一换行。'
        : '';
    return `错误：未找到匹配（匹配 0 处），未做任何修改。old_string 必须与文件内容逐字符一致（含缩进与换行）。${crlfHint}`;
  }

  const replaceAll = args.replace_all === true;
  if (count > 1 && !replaceAll) {
    return `错误：old_string 匹配到 ${count} 处，不唯一，未做任何修改。请补足上下文使其唯一，或传 replace_all: true 全部替换。`;
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : replaceFirst(original, oldString, newString);

  try {
    writeFileAtomic(absolute, updated);
  } catch (error) {
    return `错误：写入失败：${String(error)}`;
  }

  return `已替换 ${count} 处（${inputPath}）`;
}

const editTool: ToolDefinition = {
  name: 'edit',
  description:
    'Replace a text snippet in a file. old_string must match the file content exactly and ' +
    'occur exactly once; pass replace_all: true to replace every occurrence.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Exact text to replace (must be unique)' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring a unique match',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  checkPermission: async (input, ctx) => requestPermission(ctx, 'edit', input),
  handler: async (args: unknown) => editFile(args),
};

// ── 插件导出 ──────────────────────────────────────

/** 创建三个基础工具（幂等：返回同一组无状态工具定义） */
export function createBasicTools(): ToolDefinition[] {
  return [bashTool, readTool, editTool];
}

/** basic-tools 插件——唯一工具包，install 时把三个工具注册进 PluginHost */
export const basicToolsPlugin: Plugin = {
  name: 'basic-tools',
  version: '0.1.0',
  description: 'bash / read / edit — the minimal tool set everything else composes from',
  install(host: PluginHost) {
    for (const tool of createBasicTools()) {
      host.registerTool(tool);
    }
  },
};

export default basicToolsPlugin;
