/**
 * @vessel-agent/basic-tools - 基础工具插件（bash / read / edit）
 * @module @vessel-agent/basic-tools
 *
 * 本项目唯一的工具包，只提供三个互不可替代的工具：
 * - `bash`：执行任意 shell 命令（grep / cat / ls / mkdir / curl …… 全部由它承担），权限 ask
 * - `read`：带行号读文件（支持 offset/limit），权限 allow
 * - `edit`：精确且唯一匹配的字符串替换，权限 ask
 *
 * 危险操作（bash / edit）经 `checkPermission` → `requestPermission` 等用户授权（ADR-029）。
 * `read` / `bash` 额外受路径边界约束（0.8 E1）：内置敏感路径 denylist 直接拒绝；
 * 可选 `allowed_roots` 把越界访问降级为 ask。`..` 与符号链接按真实路径判定。
 */

import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plugin, PluginHost, ToolContext, ToolDefinition } from '@vessel-agent/core';
import { requestPermission } from '@vessel-agent/permission';

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

/** 返回给模型的单方向预览字节数（超出即标注） */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** 落盘时单方向最多保留的字节数（超出仍丢弃，防止无界输出撑爆内存） */
const MAX_PERSIST_BYTES = 16 * 1024 * 1024;

/** 取消时返回的固定文本 */
const CANCELLED_TEXT = '错误：操作已取消（cancelled）。';

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

// ── 路径边界（0.8 E1） ────────────────────────────

/** 内置敏感路径：命中即 deny，不可通过 ask 放行 */
const DEFAULT_DENY_PATHS: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.vessel/config.yaml',
];

/** 插件配置（同时接受 camelCase / snake_case；未知键忽略） */
export interface BasicToolsConfig {
  /** 配置后 read / bash cwd 必须落在任一 root 内；越界走 ask。空 = 不限制根 */
  allowedRoots?: string[];
  /** 追加到内置 denylist 的敏感路径（前缀匹配） */
  denyPaths?: string[];
}

/** 从记录读取字符串数组字段（camelCase 优先，兼容 snake_case） */
function readStringArray(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string[] | undefined {
  const value = record[camel] ?? record[snake];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/** 把 YAML 里的插件配置解析成已知字段（未知键忽略） */
export function parseBasicToolsConfig(value: unknown): BasicToolsConfig {
  if (!isRecord(value)) return {};
  const allowedRoots = readStringArray(value, 'allowedRoots', 'allowed_roots');
  const denyPaths = readStringArray(value, 'denyPaths', 'deny_paths');
  return {
    ...(allowedRoots !== undefined ? { allowedRoots } : {}),
    ...(denyPaths !== undefined ? { denyPaths } : {}),
  };
}

/** 展开开头的 `~`；其余按 cwd 解析为绝对路径 */
function expandHome(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith('~\\')) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return path.resolve(entry);
}

/**
 * 取真实路径：存在则 realpath；不存在则对最近的已存在祖先做 realpath 再拼回剩余段，
 * 这样符号链接目录下的新路径也不会被词法前缀蒙混过去。
 */
function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return realpathSync.native(absolute);
  } catch {
    // 路径（或末端）不存在：沿父目录上溯到第一个可解析的位置
  }
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    suffix.unshift(path.basename(current));
    current = parent;
    try {
      return path.join(realpathSync.native(current), ...suffix);
    } catch {
      // 继续上溯
    }
  }
}

/** candidate 是否等于 root 或位于 root 之下（按路径段，不按字符串前缀） */
function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** 解析后的路径边界（配置在工具构造时固定，避免每次调用重复 realpath） */
interface PathBoundary {
  /** 允许的根；空数组 = 不限制根 */
  allowedRoots: string[];
  denyRoots: string[];
}

/** 构造边界：内置 denylist 始终生效，配置项追加/合并 */
function buildPathBoundary(config: BasicToolsConfig): PathBoundary {
  const denyEntries = [...DEFAULT_DENY_PATHS, ...(config.denyPaths ?? [])];
  return {
    allowedRoots: (config.allowedRoots ?? []).map((entry) => canonicalPath(expandHome(entry))),
    denyRoots: denyEntries.map((entry) => canonicalPath(expandHome(entry))),
  };
}

/** 判定路径：deny 优先于 allow；配置 allowed_roots 后越界为 ask */
function evaluatePath(target: string, boundary: PathBoundary): 'allow' | 'ask' | 'deny' {
  const canonical = canonicalPath(target);
  if (boundary.denyRoots.some((root) => isWithin(canonical, root))) return 'deny';
  if (
    boundary.allowedRoots.length > 0 &&
    !boundary.allowedRoots.some((root) => isWithin(canonical, root))
  ) {
    return 'ask';
  }
  return 'allow';
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

/** 把子进程管道泵成文本（超过 MAX_PERSIST_BYTES 的部分丢弃并标记截断） */
function pumpStream(stream: ReadableStream<Uint8Array>, sink: OutputSink): Pump {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value) continue;
        if (sink.bytes >= MAX_PERSIST_BYTES) {
          sink.truncated = true;
          continue;
        }
        sink.chunks.push(decoder.decode(chunk.value, { stream: true }));
        sink.bytes += chunk.value.byteLength;
        if (sink.bytes >= MAX_PERSIST_BYTES) sink.truncated = true;
      }
      const tail = decoder.decode();
      if (tail && sink.bytes < MAX_PERSIST_BYTES) sink.chunks.push(tail);
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

/** 把完整输出裁成模型可读预览（按字节上限） */
function toPreview(text: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.byteLength <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  return {
    text: buffer.subarray(0, MAX_OUTPUT_BYTES).toString('utf-8'),
    truncated: true,
  };
}

/** 输出落盘根目录：显式 env → data_dir → 默认数据目录 */
function toolOutputRoot(): string {
  const explicit = process.env.VESSEL_TOOL_OUTPUT_DIR;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit);
  const dataDir = process.env.VESSEL_DATA_DIR;
  if (typeof dataDir === 'string' && dataDir.trim() !== '') {
    return path.join(path.resolve(dataDir), 'tool-output');
  }
  return path.join(os.homedir(), '.vessel', 'data', 'tool-output');
}

/** 目录名安全化：只保留字母数字与 ._- */
function safeSegment(value: string | undefined): string {
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return cleaned === '' ? 'no-session' : cleaned;
}

/** 把完整输出写入 session 目录；失败返回 undefined（调用方降级为纯截断） */
async function persistBashOutput(payload: {
  command: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const dir = path.join(toolOutputRoot(), safeSegment(payload.sessionId));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
    const body = [
      `# command: ${payload.command}`,
      `# exit_code: ${payload.exitCode ?? 'null'}`,
      `# cancelled: ${payload.cancelled}`,
      `# timed_out: ${payload.timedOut}`,
      `# truncated_at_16MiB: ${payload.truncated}`,
      '',
      '[stdout]',
      payload.stdout,
      '[stderr]',
      payload.stderr,
    ].join('\n');
    await writeFile(file, body, 'utf-8');
    return file;
  } catch {
    return undefined;
  }
}

/** 组装 bash 返回文本：退出码 + 非空输出段（行数或字节超限时截断并标注） */
function formatBashResult(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  timeoutMs: number;
  cancelled: boolean;
}): string {
  const parts: string[] = [];
  if (result.cancelled) {
    parts.push(CANCELLED_TEXT);
  } else if (result.timedOut) {
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
    // POSIX 下建独立进程组，取消时能连同孙进程一起杀
    detached: process.platform !== 'win32',
  });
}

/** 杀掉 bash 及其派生的孙进程（POSIX 用进程组；Windows 用 taskkill /T） */
function killProcessTree(proc: ReturnType<typeof spawnBash>): void {
  const pid = proc.pid;
  if (typeof pid === 'number' && pid > 0) {
    if (process.platform === 'win32') {
      try {
        Bun.spawnSync({
          cmd: ['taskkill', '/PID', String(pid), '/T', '/F'],
          stdout: 'ignore',
          stderr: 'ignore',
        });
      } catch {
        // taskkill 不可用：仍尝试直接 kill
      }
    } else {
      try {
        // detached 时 pid 即进程组 id
        process.kill(-pid, 'SIGTERM');
      } catch {
        // 进程组已不存在
      }
    }
  }
  try {
    proc.kill();
  } catch {
    // 已退出
  }
}

/** 执行 bash 命令；超时/取消返回错误文本，不抛异常 */
async function runBash(args: unknown, ctx: ToolContext, boundary: PathBoundary): Promise<string> {
  if (!isRecord(args)) return '错误：bash 需要 { command: string }';
  const command = readString(args, 'command');
  // 纯空白命令是无意义的一次调用，直接挡掉（否则白烧一轮）
  if (command.trim() === '') return '错误：command 不能为空';

  const cwd = readString(args, 'cwd');
  if (cwd !== '' && !existsSync(cwd)) return `错误：cwd 不存在：${cwd}`;
  // 防御性检查：即使调用方绕过 checkPermission（如 workflow 直接调 handler），
  // 敏感路径的 cwd 仍然拒绝；allowed_roots 的越界由 checkPermission 走 ask。
  if (evaluatePath(cwd === '' ? process.cwd() : cwd, boundary) === 'deny') {
    return `错误：cwd 在敏感路径拒绝列表中：${cwd === '' ? process.cwd() : cwd}`;
  }

  const timeoutMs = readNumber(args, 'timeout_ms') ?? DEFAULT_BASH_TIMEOUT_MS;
  if (timeoutMs <= 0) return '错误：timeout_ms 必须为正数';

  const signal = ctx.signal;
  if (signal?.aborted) return CANCELLED_TEXT;

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
  let cancelled = false;
  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    killProcessTree(proc);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  // addEventListener 不会补发已发生的 abort
  if (signal?.aborted) onAbort();

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(proc);
  }, timeoutMs);

  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  await waitAtMost(Promise.all([stdoutPump.done, stderrPump.done]), DRAIN_GRACE_MS);
  // 孙进程可能仍握着管道写端：主动放弃剩余读取，别让一次超时把整轮对话挂死
  stdoutPump.cancel();
  stderrPump.cancel();

  const stdout = stdoutSink.chunks.join('');
  const stderr = stderrSink.chunks.join('');
  const stdoutPreview = toPreview(stdout);
  const stderrPreview = toPreview(stderr);
  const overLines =
    splitLines(stdout).length > MAX_OUTPUT_LINES || splitLines(stderr).length > MAX_OUTPUT_LINES;
  const overBytes = stdoutPreview.truncated || stderrPreview.truncated;
  const shouldPersist = overLines || overBytes || stdoutSink.truncated || stderrSink.truncated;

  let persistNote: string | undefined;
  if (shouldPersist) {
    const saved = await persistBashOutput({
      command,
      exitCode: proc.exitCode,
      cancelled,
      timedOut,
      stdout,
      stderr,
      truncated: stdoutSink.truncated || stderrSink.truncated,
      ...(ctx.session_id !== undefined ? { sessionId: ctx.session_id } : {}),
    });
    persistNote =
      saved !== undefined
        ? `完整输出已写入：${saved}（${Buffer.byteLength(stdout) + Buffer.byteLength(stderr)} 字节）`
        : '完整输出落盘失败（预览已截断）。';
  }

  const formatted = formatBashResult({
    exitCode: proc.exitCode,
    stdout: stdoutPreview.text,
    stderr: stderrPreview.text,
    stdoutTruncated: stdoutPreview.truncated || stdoutSink.truncated,
    stderrTruncated: stderrPreview.truncated || stderrSink.truncated,
    timedOut,
    timeoutMs,
    cancelled,
  });
  return persistNote !== undefined ? `${formatted}\n${persistNote}` : formatted;
}

/** 构造 bash 工具（路径边界随配置固定） */
function createBashTool(config: BasicToolsConfig): ToolDefinition {
  const boundary = buildPathBoundary(config);
  return {
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
    checkPermission: async (input, ctx) => {
      if (isRecord(input)) {
        const cwd = readString(input, 'cwd');
        const decision = evaluatePath(cwd === '' ? process.cwd() : cwd, boundary);
        // deny 直接拒绝；配置 allowed_roots 的越界走 ask（由运行时向用户确认）
        if (decision !== 'allow') return decision;
      }
      return requestPermission(ctx, 'bash', input);
    },
    handler: async (args: unknown, ctx) => runBash(args, ctx, boundary),
  };
}

// ── read ─────────────────────────────────────────

/** 读出带行号的文本片段（行号从 1 开始，`<行号>\t<内容>`） */
function readFileSlice(
  args: unknown,
  signal: AbortSignal | undefined,
  boundary: PathBoundary,
): string {
  if (signal?.aborted) return CANCELLED_TEXT;
  if (!isRecord(args)) return '错误：read 需要 { path: string }';
  const inputPath = readString(args, 'path');
  if (inputPath === '') return '错误：path 不能为空';
  // 防御性检查：即使调用方绕过 checkPermission，也绝不读取敏感路径
  if (evaluatePath(inputPath, boundary) === 'deny') {
    return `错误：路径在敏感路径拒绝列表中：${inputPath}`;
  }

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

/** 构造 read 工具（路径边界随配置固定） */
function createReadTool(config: BasicToolsConfig): ToolDefinition {
  const boundary = buildPathBoundary(config);
  return {
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
    // 只读操作无副作用；但敏感路径 deny、配置 allowed_roots 后越界 ask
    checkPermission: async (input) => {
      if (!isRecord(input)) return 'allow';
      const inputPath = readString(input, 'path');
      if (inputPath === '') return 'allow';
      return evaluatePath(inputPath, boundary);
    },
    handler: async (args: unknown, ctx) => readFileSlice(args, ctx.signal, boundary),
  };
}

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
function editFile(args: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return CANCELLED_TEXT;
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

  // 校验通过后、落盘前再检查一次：取消后不得留下半次修改
  if (signal?.aborted) return CANCELLED_TEXT;

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
  handler: async (args: unknown, ctx) => editFile(args, ctx.signal),
};

// ── 插件导出 ──────────────────────────────────────

/**
 * 创建三个基础工具。
 * 不传配置时只启用内置 denylist（不限制根），与旧行为兼容。
 */
export function createBasicTools(config: BasicToolsConfig = {}): ToolDefinition[] {
  return [createBashTool(config), createReadTool(config), editTool];
}

/** basic-tools 插件——唯一工具包，install 时把三个工具注册进 PluginHost */
export const basicToolsPlugin: Plugin = {
  name: 'basic-tools',
  version: '0.1.0',
  description: 'bash / read / edit — the minimal tool set everything else composes from',
  install(host: PluginHost, options?: { config?: Record<string, unknown> }) {
    const config = parseBasicToolsConfig(options?.config);
    for (const tool of createBasicTools(config)) {
      host.registerTool(tool);
    }
  },
};

export default basicToolsPlugin;
