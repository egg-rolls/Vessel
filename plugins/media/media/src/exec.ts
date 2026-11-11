/**
 * @vessel-agent/media - 外部 CLI 执行
 * @module @vessel-agent/media/exec
 *
 * 只用 node:child_process 的 spawn（不引入 npm 依赖、不经 shell）：
 * - 输出边读边截断，超过 maxBytes 的字节只计数不保存；
 * - 尊重 ctx.signal（abort 立刻 kill 子进程）与超时；
 * - 一切失败都折成返回值，不抛异常（工具层负责转成人读错误文本）。
 */

import { spawn } from 'node:child_process';

/** 执行选项 */
export interface RunCliOptions {
  /** 取消信号（来自 ToolContext.signal） */
  signal?: AbortSignal;
  /** 超时毫秒；<= 0 表示不限时 */
  timeoutMs: number;
  /** stdout 保存上限（字节） */
  maxBytes: number;
  /** stderr 保存上限（字节，缺省 4 KiB） */
  maxStderrBytes?: number;
}

/** 执行结果（永不抛异常） */
export interface RunCliResult {
  /** 退出码；被信号杀掉 / 未启动时为 null */
  code: number | null;
  /** stdout（已按 maxBytes 截断） */
  stdout: string;
  /** stderr（已按 maxStderrBytes 截断） */
  stderr: string;
  /** stdout 实际产出的总字节数（截断前） */
  stdoutBytes: number;
  /** stdout 是否被截断 */
  truncated: boolean;
  /** 是否因 signal abort 中止 */
  aborted: boolean;
  /** 是否超时 */
  timedOut: boolean;
  /** 启动失败原因（ENOENT / EACCES 等） */
  spawnError?: string;
}

/** 单调截断写入：超出上限的字节只计数 */
interface CapSink {
  chunks: string[];
  bytes: number;
  total: number;
  truncated: boolean;
  cap: number;
}

/** 新建截断缓冲 */
function createSink(cap: number): CapSink {
  return { chunks: [], bytes: 0, total: 0, truncated: false, cap };
}

/** 追加一块数据（UTF-8 解码按流模式，跨块多字节字符不会被切坏） */
function appendChunk(sink: CapSink, chunk: Buffer, decoder: TextDecoder): void {
  sink.total += chunk.byteLength;
  if (sink.truncated) return;
  const remaining = sink.cap - sink.bytes;
  if (remaining <= 0) {
    sink.truncated = true;
    return;
  }
  if (chunk.byteLength <= remaining) {
    sink.chunks.push(decoder.decode(chunk, { stream: true }));
    sink.bytes += chunk.byteLength;
    return;
  }
  sink.chunks.push(decoder.decode(chunk.subarray(0, remaining), { stream: false }));
  sink.bytes += remaining;
  sink.truncated = true;
}

/**
 * 运行一条 CLI（不经 shell，参数逐个传入）。
 * @param command 可执行文件绝对路径或命令名
 */
export function runCli(
  command: string,
  args: readonly string[],
  options: RunCliOptions,
): Promise<RunCliResult> {
  const stdoutSink = createSink(options.maxBytes);
  const stderrSink = createSink(options.maxStderrBytes ?? 4096);

  const result: RunCliResult = {
    code: null,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    truncated: false,
    aborted: false,
    timedOut: false,
  };

  if (options.signal?.aborted === true) {
    return Promise.resolve({ ...result, aborted: true });
  }

  return new Promise<RunCliResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** 收尾：只 resolve 一次 */
    const finish = (patch: Partial<RunCliResult>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        ...result,
        ...patch,
        stdout: stdoutSink.chunks.join(''),
        stderr: stderrSink.chunks.join(''),
        stdoutBytes: stdoutSink.total,
        truncated: stdoutSink.truncated,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ spawnError: String(error) });
      return;
    }

    /** abort：kill 子进程，结果标记 aborted */
    function onAbort(): void {
      result.aborted = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
      finish({ code: child.exitCode });
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        result.timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
        finish({ code: child.exitCode });
      }, options.timeoutMs);
    }

    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    child.stdout?.on('data', (chunk: Buffer) => appendChunk(stdoutSink, chunk, stdoutDecoder));
    child.stderr?.on('data', (chunk: Buffer) => appendChunk(stderrSink, chunk, stderrDecoder));

    child.on('error', (error) => {
      finish({ spawnError: String(error) });
    });
    child.on('close', (code) => {
      finish({ code });
    });
  });
}
