/**
 * 单个体验型 plugin 的子进程（CONTRACT-0.43 §3）。
 *
 * - `bun <entry>`，cwd = plugin 包目录；stdin/stdout 换行分隔 JSON-RPC 2.0；
 * - stderr 原样写 `<dataDir>/logs/plugin.log`（1 MiB 轮转）；
 * - `plugin.hello` 5s / `plugin.activate` 10s / `plugin.rpc` 10s / 心跳 15s；
 * - 超时 → `plugin_timeout` 并杀进程；退出由 manager 决定是否重启。
 * - plugin → host 只允许 `plugin.log` / `plugin.ready`；`host.*` 与
 *   `fs.*` / `net.*` / `process.*` / `secrets.*` 一律拒绝（v1 deny stub）。
 *
 * 这是崩溃 / 生命周期隔离，不是安全沙箱（DECISION-044 §1.5）。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileSink } from 'bun';
import { ensurePayload, jsonByteLength, MAX_PLUGIN_MESSAGE_BYTES } from './dto.js';
import { type PluginHostError, pluginError, pluginErrorCodeOf } from './errors.js';
import type { PluginDescriptor, PluginErrorCode, PluginEventDto } from './types.js';

/** 协议版本（contract §3） */
export const PLUGIN_PROTOCOL_VERSION = 1;

export const PLUGIN_TIMEOUTS = {
  handshake: 5_000,
  activate: 10_000,
  rpc: 10_000,
  heartbeat: 15_000,
  deactivate: 2_000,
  terminate: 2_000,
  kill: 2_000,
} as const;

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_PENDING_LINE_CHARS = MAX_PLUGIN_MESSAGE_BYTES;

/** 子进程状态 */
export type ChildStatus = 'new' | 'starting' | 'active' | 'stopping' | 'stopped';

export interface ChildExitInfo {
  code: number | null;
  signal: string | null;
  /** 宿主主动结束（deactivate / stop）导致的退出不算 crash。 */
  expected: boolean;
  /** 引发退出的宿主侧错误码（timeout / payload / crashed）。 */
  errorCode?: PluginErrorCode;
  message?: string;
}

export interface ChildProcessHooks {
  /** plugin → host `plugin.log`（已做字段裁剪，正文由 plugin 自行负责）。 */
  onLog?(level: string, message: string): void;
  /** plugin → host `plugin.ready`。 */
  onReady?(): void;
  /** 被 deny 的宿主 API（fs / net / process / secrets）。 */
  onPermissionDenied?(api: string): void;
  /** 非预期退出（manager 据此决定重启 / 禁用）。 */
  onExit?(info: ChildExitInfo): void;
}

export interface ChildProcessOptions {
  descriptor: PluginDescriptor;
  /** 该 plugin 的 settings（来自 config.yaml plugins[].config）。 */
  settings: Record<string, unknown>;
  /** 私有可写目录 `<globalDataDir>/plugins/<id>`（env + 日志）。 */
  dataDir: string;
  /**
   * 全局 data dir（只读）；仅当 manifest `permissions.fs` 含 `data-dir` 时，
   * 才作为 `plugin.activate.params.dataDir` 暴露（CONTRACT-0.43 §3.2.1）。
   */
  globalDataDir?: string;
  execPath?: string;
  hooks?: ChildProcessHooks;
  timeouts?: Partial<typeof PLUGIN_TIMEOUTS>;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageId(id: unknown): string | null {
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'string' && id.length > 0) return id;
  return null;
}

/**
 * 构造子进程 env：只给最小运行环境 + 契约规定的四个变量。
 * 绝不透传 gateway token / 全量 config / 其它 VESSEL_* 变量。
 */
export function buildPluginEnv(input: {
  descriptor: PluginDescriptor;
  settings: Record<string, unknown>;
  dataDir: string;
}): Record<string, string> {
  const inherited = process.env;
  const env: Record<string, string> = {};
  const allow = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'SYSTEMROOT',
    'SystemDrive',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_ENV',
  ];
  for (const key of allow) {
    const value = inherited[key];
    if (value !== undefined) env[key] = value;
  }
  env.VESSEL_PLUGIN_ID = input.descriptor.id;
  env.VESSEL_PLUGIN_PROTOCOL = String(PLUGIN_PROTOCOL_VERSION);
  env.VESSEL_PLUGIN_DATA_DIR = input.dataDir;
  env.VESSEL_PLUGIN_CONFIG = JSON.stringify(input.settings);
  // E4 §3.2.2：宿主进程绝对 cwd（只读元数据，不是权限授予）。
  env.VESSEL_PLUGIN_HOST_CWD = process.cwd();
  return env;
}

/** 追加写日志；1 MiB 轮转到 `plugin.log.1`。 */
class PluginLogFile {
  private chain: Promise<void> = Promise.resolve();
  private readonly dir: string;
  private readonly file: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'logs');
    this.file = join(this.dir, 'plugin.log');
  }

  append(text: string): void {
    const line = `${new Date().toISOString()} ${text.replace(/\r?\n$/, '')}\n`;
    this.chain = this.chain
      .then(() => this.appendNow(line))
      .catch(() => {
        // 日志失败不得影响 plugin 生命周期
      });
  }

  private async appendNow(line: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const info = await stat(this.file);
      const bytes = new TextEncoder().encode(line).byteLength;
      if (info.size + bytes > MAX_LOG_BYTES) {
        await rm(`${this.file}.1`, { force: true });
        await rename(this.file, `${this.file}.1`);
      }
    } catch {
      // 首次写入：文件还不存在
    }
    await appendFile(this.file, line, { mode: 0o600 });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

/**
 * 子进程句柄。`start()` 完成 handshake + activate 后 `status === 'active'`。
 * 所有退出都经 `hooks.onExit` 上报一次；manager 负责重启策略。
 */
export class ChildPluginProcess {
  readonly descriptor: PluginDescriptor;
  readonly dataDir: string;
  status: ChildStatus = 'new';

  private readonly settings: Record<string, unknown>;
  private readonly globalDataDir?: string;
  private readonly execPath: string;
  private readonly hooks: ChildProcessHooks;
  private readonly timeouts: typeof PLUGIN_TIMEOUTS;
  private readonly logFile: PluginLogFile;

  private proc?: ReturnType<typeof Bun.spawn>;
  private stdin?: FileSink;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer = '';
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private expectedExit = false;
  private exitCode: PluginErrorCode | undefined;
  private exitMessage: string | undefined;
  private reportedExit = false;

  constructor(options: ChildProcessOptions) {
    this.descriptor = options.descriptor;
    this.settings = options.settings;
    this.dataDir = options.dataDir;
    this.globalDataDir = options.globalDataDir;
    this.execPath = options.execPath ?? process.execPath;
    this.hooks = options.hooks ?? {};
    this.timeouts = { ...PLUGIN_TIMEOUTS, ...options.timeouts };
    this.logFile = new PluginLogFile(options.dataDir);
  }

  /** 启动子进程并完成握手 / 激活；失败时杀进程并抛错。 */
  async start(): Promise<void> {
    if (this.status !== 'new') throw new Error('ChildPluginProcess can only be started once.');
    this.status = 'starting';
    const descriptor = this.descriptor;
    try {
      this.proc = Bun.spawn([this.execPath, descriptor.entry], {
        cwd: descriptor.pluginDir,
        env: buildPluginEnv({ descriptor, settings: this.settings, dataDir: this.dataDir }),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      });
    } catch (error) {
      this.status = 'stopped';
      throw pluginError('plugin_activation_failed', 'Failed to spawn plugin process.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const stdin = this.proc.stdin;
    if (typeof stdin !== 'number') this.stdin = stdin;
    const stdout = this.proc.stdout;
    if (typeof stdout !== 'number') void this.pumpStdout(stdout);
    const stderr = this.proc.stderr;
    if (typeof stderr !== 'number') void this.pumpStderr(stderr);
    void this.proc.exited.then(
      (code) => this.finish(code, null),
      () => this.finish(null, null),
    );

    try {
      const hello = await this.request(
        'plugin.hello',
        { protocol: PLUGIN_PROTOCOL_VERSION, modId: descriptor.id, version: descriptor.version },
        this.timeouts.handshake,
      );
      if (!isRecord(hello) || hello.protocol !== PLUGIN_PROTOCOL_VERSION || hello.ok !== true) {
        throw pluginError('plugin_activation_failed', 'plugin.hello rejected the host handshake.');
      }
      // §3.2.1：dataDir 是全局 data dir（只读），且只有声明 data-dir 权限才下发；
      // 私有可写目录始终只经 VESSEL_PLUGIN_DATA_DIR 提供。
      const fsPermissions = descriptor.permissions?.fs ?? [];
      const activated = await this.request(
        'plugin.activate',
        {
          settings: this.settings,
          ...(fsPermissions.includes('data-dir') && this.globalDataDir !== undefined
            ? { dataDir: this.globalDataDir }
            : {}),
          // E4 §3.2.2：宿主进程绝对 cwd；marketplace 用它推导 project scope。
          hostCwd: process.cwd(),
          events: descriptor.contributes?.events ?? [],
        },
        this.timeouts.activate,
      );
      if (!isRecord(activated) || activated.ok !== true) {
        const remote = isRecord(activated) && isRecord(activated.error) ? activated.error.code : '';
        throw pluginError(
          'plugin_activation_failed',
          `plugin.activate failed${typeof remote === 'string' && remote ? `: ${remote}` : ''}.`,
        );
      }
    } catch (error) {
      this.exitCode = pluginErrorCodeOf(error) ?? 'plugin_activation_failed';
      this.exitMessage = error instanceof Error ? error.message : String(error);
      await this.terminate();
      throw error;
    }

    this.status = 'active';
    this.startHeartbeat();
    this.logFile.append('plugin activated');
  }

  /** `plugin.rpc` 请求；子进程只看到 bare 方法名，命名空间归宿主。 */
  async callRpc(name: string, params: Record<string, unknown>): Promise<unknown> {
    this.assertActive();
    if (name.length === 0 || name.includes('.')) {
      throw pluginError('plugin_manifest_invalid', 'plugin.rpc name must be bare.', { name });
    }
    ensurePayload(params, `plugin.rpc(${name}).params`);
    const result = await this.request('plugin.rpc', { name, params }, this.timeouts.rpc);
    ensurePayload(result, `plugin.rpc(${name}).result`);
    return result;
  }

  /** `plugin.event` notification；超限事件由调用方丢弃。 */
  notifyEvent(event: PluginEventDto): void {
    if (this.status !== 'active') return;
    const bytes = jsonByteLength(event);
    if (bytes > MAX_PLUGIN_MESSAGE_BYTES) return;
    this.write({ jsonrpc: '2.0', method: 'plugin.event', params: event });
  }

  /** 幂等停止：deactivate → 2s → SIGTERM → 2s → SIGKILL。 */
  async terminate(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'new') return;
    this.expectedExit = true;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    const wasActive = this.status === 'active';
    this.status = 'stopping';

    if (wasActive) {
      try {
        await this.request('plugin.deactivate', {}, this.timeouts.deactivate);
      } catch {
        // 契约：deactivate 失败不阻塞回收
      }
    }

    const proc = this.proc;
    if (proc === undefined) {
      this.status = 'stopped';
      return;
    }
    try {
      this.stdin?.end();
    } catch {
      // 已关闭
    }
    if (await this.waitExited(this.timeouts.deactivate)) {
      this.status = 'stopped';
      await this.logFile.flush();
      return;
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      // 已退出
    }
    if (await this.waitExited(this.timeouts.terminate)) {
      this.status = 'stopped';
      await this.logFile.flush();
      return;
    }
    try {
      proc.kill('SIGKILL');
    } catch {
      // 已退出
    }
    await this.waitExited(this.timeouts.kill);
    this.status = 'stopped';
    await this.logFile.flush();
  }

  /** 等待日志落盘（测试 / 关闭时用）。 */
  flushLog(): Promise<void> {
    return this.logFile.flush();
  }

  private assertActive(): void {
    if (this.status !== 'active') {
      throw pluginError('plugin_activation_failed', 'Plugin process is not active.', {
        status: this.status,
      });
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.status !== 'active') return;
      void this.request('ping', {}, this.timeouts.heartbeat).catch(() => {
        // request 超时已触发 fail()
      });
    }, this.timeouts.heartbeat);
  }

  private async waitExited(ms: number): Promise<boolean> {
    const proc = this.proc;
    if (proc === undefined) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const exited = proc.exited.then(
      () => true as const,
      () => true as const,
    );
    const result = await Promise.race([exited, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.status === 'stopped') {
      return Promise.reject(pluginError('plugin_crashed', 'Plugin process is stopped.'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const error = pluginError(
          'plugin_timeout',
          `plugin.${method === 'ping' ? 'heartbeat' : method} timed out after ${timeoutMs}ms.`,
          { method },
        );
        void this.fail(error);
        reject(error);
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.stdin;
    if (stdin === undefined) throw new Error('Plugin stdin is not available.');
    const line = JSON.stringify(message);
    if (new TextEncoder().encode(line).byteLength > MAX_PLUGIN_MESSAGE_BYTES) {
      throw pluginError('plugin_payload_too_large', 'Outgoing plugin message exceeds 1 MiB.');
    }
    stdin.write(`${line}\n`);
    void stdin.flush?.();
  }

  private writeResult(id: unknown, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private writeError(id: unknown, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private async pumpStdout(stream: ReadableStream<Uint8Array> | undefined): Promise<void> {
    if (stream === undefined) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) this.onStdout(decoder.decode(value, { stream: true }));
      }
      this.onStdout(decoder.decode());
    } catch {
      // 进程退出时流可能抛错
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array> | undefined): Promise<void> {
    if (stream === undefined) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line.length > 0) this.logFile.append(`[stderr] ${line.slice(0, 2000)}`);
          index = buffer.indexOf('\n');
        }
      }
      if (buffer.trim().length > 0) this.logFile.append(`[stderr] ${buffer.slice(0, 2000)}`);
    } catch {
      // 进程退出
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      let line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length > 0) this.handleLine(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
    if (this.stdoutBuffer.length > MAX_PENDING_LINE_CHARS) {
      this.stdoutBuffer = '';
      void this.fail(pluginError('plugin_payload_too_large', 'Plugin message line exceeds 1 MiB.'));
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      this.logFile.append('[host] ignored non-JSON line on stdout');
      return;
    }

    const id = messageId(message.id);
    const method = typeof message.method === 'string' ? message.method : undefined;

    if (
      id !== null &&
      method === undefined &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      this.settle(id, message);
      return;
    }
    if (method !== undefined) {
      this.handleIncoming(method, message.params, id);
    }
  }

  private settle(id: string, message: JsonRpcMessage): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = message.error;
      const remoteCode = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
      const messageText =
        isRecord(error) && typeof error.message === 'string'
          ? error.message
          : `Remote ${pending.method} failed.`;
      const failure = pluginError(
        pluginErrorCodeOf({ code: remoteCode }) ?? 'plugin_activation_failed',
        messageText,
        { remote_code: remoteCode ?? null },
      );
      pending.reject(failure);
      return;
    }
    pending.resolve(message.result);
  }

  private handleIncoming(method: string, params: unknown, id: string | null): void {
    if (method === 'pong') return;
    if (method === 'ping') {
      if (id !== null) this.writeResult(id, { pong: true });
      return;
    }
    if (method === 'plugin.log') {
      const level = isRecord(params) && typeof params.level === 'string' ? params.level : 'info';
      const text = isRecord(params) && typeof params.message === 'string' ? params.message : '';
      this.logFile.append(`[plugin:${level}] ${text.slice(0, 2000)}`);
      this.hooks.onLog?.(level, text);
      return;
    }
    if (method === 'plugin.ready') {
      this.hooks.onReady?.();
      return;
    }
    if (isDeniedHostApi(method)) {
      this.hooks.onPermissionDenied?.(method);
      this.logFile.append(`[host] denied ${method}`);
      if (id !== null) this.writeError(id, -32001, 'plugin_permission_denied');
      return;
    }
    if (id !== null) {
      this.writeError(id, -32601, `Unknown method: ${method}`);
    }
  }

  private async fail(error: PluginHostError): Promise<void> {
    if (this.status === 'stopped' || this.status === 'stopping') return;
    this.exitCode = error.code;
    this.exitMessage = error.message;
    this.logFile.append(`[host] ${error.code}: ${error.message}`);
    // 超时 / 超限直接回收，不再给 hung 进程发 deactivate。
    this.status = 'stopping';
    await this.terminate();
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.reportedExit) return;
    this.reportedExit = true;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    const wasActive = this.status === 'active' || this.status === 'starting';
    this.status = 'stopped';
    this.rejectAll(pluginError('plugin_crashed', 'Plugin process exited.', { code, signal }));
    const expected = this.expectedExit || !wasActive;
    if (this.exitCode === undefined && code !== null && code !== 0 && wasActive) {
      this.exitCode = 'plugin_crashed';
      this.exitMessage = `Plugin exited with code ${code}.`;
    }
    this.logFile.append(
      `[host] process exited code=${String(code)} signal=${String(signal)} expected=${String(expected)}`,
    );
    this.hooks.onExit?.({
      code,
      signal,
      expected,
      ...(this.exitCode !== undefined ? { errorCode: this.exitCode } : {}),
      ...(this.exitMessage !== undefined ? { message: this.exitMessage } : {}),
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

/** v1 只读所在目录；这些宿主 API 全部拒绝（task: explicit deny stubs）。 */
export function isDeniedHostApi(method: string): boolean {
  return (
    method.startsWith('host.') ||
    method.startsWith('fs.') ||
    method.startsWith('net.') ||
    method.startsWith('process.') ||
    method.startsWith('secrets.')
  );
}
