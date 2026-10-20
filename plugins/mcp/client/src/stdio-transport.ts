/**
 * stdio 传输：MCP JSON-RPC over 子进程 stdin/stdout。
 *
 * 帧格式为换行分隔 JSON（NDJSON），不使用 Content-Length。
 * stderr 单独按行收集，仅用于失败诊断。
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { JsonRpcNotificationMessage, JsonRpcRequestMessage } from './json-rpc.js';
import {
  formatError,
  isResponse,
  isServerRequest,
  JsonRpcError,
  McpTransportError,
  parseJsonRpcLine,
} from './json-rpc.js';
import { warnMcp } from './logging.js';
import type { McpServerConfig, McpTransport, RequestOptions } from './types.js';

/** 单行上限：防止坏 server 把内存吃光 */
const MAX_LINE_CHARS = 1024 * 1024;
/** stderr 环形缓冲行数 */
const STDERR_BUFFER_LINES = 50;
/** 关闭预算：先等 stdin end，再 SIGTERM，再 SIGKILL */
const CLOSE_GRACE_MS = 2000;
const KILL_GRACE_MS = 1000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
}

/** 构造子进程环境：继承当前 env，再用配置覆盖 */
function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

export class StdioTransport implements McpTransport {
  readonly kind = 'stdio' as const;

  private readonly config: McpServerConfig;
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrLines: string[] = [];
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private closePromise?: Promise<void>;
  private closeHandler?: (reason: string) => void;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (this.closed) throw new McpTransportError('closed', this.serverLabel('transport is closed'));

    const command = this.config.command;
    if (!command) {
      throw new McpTransportError('io', `MCP server "${this.config.name}" requires a command`);
    }

    const child = spawn(command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(this.config.env),
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.child = undefined;
        reject(
          new McpTransportError(
            'io',
            this.serverLabel(`failed to start process: ${error.message}`),
          ),
        );
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: Buffer | string) => {
      this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.onStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.once('exit', (code, signal) => this.onExit(code, signal));
    // spawn 成功后的运行期错误（EPIPE 等）也走退出路径
    child.once('error', (error) => this.onExit(null, null, error));

    if (child.exitCode !== null) {
      this.onExit(child.exitCode, child.signalCode);
    }
  }

  request(method: string, params: unknown, opts: RequestOptions): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new McpTransportError('closed', this.serverLabel('transport is closed')),
      );
    }
    if (opts.signal?.aborted) {
      return Promise.reject(new McpTransportError('aborted', 'MCP request aborted'));
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = () => {
        this.pending.delete(id);
        this.sendCancelled(id);
        settle(() => reject(new McpTransportError('aborted', `MCP request "${method}" aborted`)));
      };

      if (opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          settle(() =>
            reject(
              new McpTransportError(
                'timeout',
                `MCP request "${method}" timed out after ${opts.timeoutMs}ms`,
              ),
            ),
          );
        }, opts.timeoutMs);
      }

      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
        method,
      });
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      const message: JsonRpcRequestMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(id);
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      throw new McpTransportError('closed', this.serverLabel('transport is closed'));
    }
    const message: JsonRpcNotificationMessage = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(message);
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    if (this.closed) {
      this.rejectAll(new McpTransportError('closed', this.serverLabel('transport is closed')));
      return;
    }
    this.closed = true;
    this.rejectAll(new McpTransportError('closed', this.serverLabel('closed')));

    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let termTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (termTimer !== undefined) clearTimeout(termTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve();
      };
      child.once('exit', finish);
      try {
        child.stdin.end();
      } catch {
        // 已经关闭
      }
      termTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // 已退出
        }
      }, CLOSE_GRACE_MS);
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
        finish();
      }, CLOSE_GRACE_MS + KILL_GRACE_MS);
    });
  }

  private write(message: JsonRpcRequestMessage | JsonRpcNotificationMessage): void {
    const child = this.child;
    if (!child || this.closed) {
      throw new McpTransportError('closed', this.serverLabel('transport is closed'));
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      throw new McpTransportError(
        'io',
        this.serverLabel(`failed to write to process: ${formatError(error)}`),
      );
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() !== '') this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      const reason = this.serverLabel('protocol error: message line exceeds 1 MiB');
      this.rejectAll(new McpTransportError('protocol', reason));
      this.closeHandler?.(reason);
      void this.close();
    }
  }

  private handleLine(line: string): void {
    const parsed = parseJsonRpcLine(line);
    if (parsed === undefined) {
      warnMcp(this.config.name, 'MCP server wrote a non-JSON line to stdout; ignoring');
      return;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) this.handleMessage(item);
      return;
    }
    this.handleMessage(parsed);
  }

  private handleMessage(message: unknown): void {
    if (isResponse(message)) {
      if (typeof message.id !== 'number') {
        warnMcp(this.config.name, 'MCP server returned a response with a non-numeric id');
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        warnMcp(this.config.name, 'MCP server returned an unknown response id');
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new JsonRpcError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isServerRequest(message)) {
      warnMcp(this.config.name, 'MCP server sent an unsupported request', {
        method: message.method,
      });
      return;
    }
    // 通知（无 id）忽略
  }

  private onStderr(chunk: string): void {
    const lines = chunk.split('\n');
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '');
      if (trimmed === '') continue;
      this.stderrLines.push(trimmed);
      if (this.stderrLines.length > STDERR_BUFFER_LINES) this.stderrLines.shift();
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    const detail = error
      ? `failed: ${error.message}`
      : `exited (code ${code === null ? 'null' : code}${signal ? `, signal ${signal}` : ''})`;
    const lastStderr = this.stderrLines[this.stderrLines.length - 1];
    const reason = this.serverLabel(lastStderr ? `${detail}: ${lastStderr}` : detail);
    this.child = undefined;
    this.rejectAll(new McpTransportError('closed', reason));
    if (!this.closed) {
      this.closed = true;
      this.closeHandler?.(reason);
    }
  }

  private rejectAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }

  private sendCancelled(id: number): void {
    if (this.closed) return;
    try {
      this.write({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: id, reason: 'client aborted' },
      });
    } catch {
      // 尽力而为
    }
  }

  private serverLabel(suffix: string): string {
    return `MCP server "${this.config.name}" ${suffix}`;
  }
}
