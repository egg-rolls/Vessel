/**
 * tools-engine 入口：child 模式（P2 seams 契约 §2.4）+ pool 模式（engine-pool 契约 S19）。
 *
 * child：stdout **只走 NDJSON JSON-RPC 协议帧**；诊断一律 stderr（core createStderrLogger）。
 * settings 从 VESSEL_PLUGIN_CONFIG 读 → 先于任何工具执行设落盘 env。
 * 出站单行 8 MiB 守卫（超限折 error 回包 / 丢弃 notification）；
 * handler 异常折 -32000 回包，不崩 child；stdin end → dispose + 退出。
 *
 * pool：env VESSEL_ENGINE_POOL_DIR + VESSEL_ENGINE_ID 存在 → TCP loopback listener（127.0.0.1:0）；
 * 首行 auth（S2）分流 control/data；每 data 连接 = 一个 NodeScope（registry/inFlight/MCP 按 scope）；
 * 派发前进程级准入（S18，busy 折 error 回包不进模型）；bind 后自写 S6 状态文件（0600 atomicWrite）；
 * 控制断不退出（detached 等 adopt）；SIGTERM/deactivate → 全 scope dispose → exit 0。
 * node dirs 只经 auth 帧透传至 executeWorker（Q9：不设进程全局 env）。
 *
 * NDJSON 行泵 / 字节守卫单实现 = @vessel-agent/serve codec（S10；child/pool 共用）。
 *
 * @module tools-engine/entry
 */

import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, createStderrLogger } from '@vessel-agent/core';
import {
  ENGINE_BUSY_CODE,
  ENGINE_BUSY_PREFIX,
  ENGINE_ERROR,
  ENGINE_MAX_MESSAGE_BYTES,
  ENGINE_WIRE,
  type EngineAuthFrame,
} from '@vessel-agent/engine-client';
import { attachNdjsonReader, createNdjsonWriter } from '@vessel-agent/serve';
import { readPackageVersion } from '../shared/version.js';
import { ToolsEngine } from './engine.js';
import { McpConnectionManager } from './mcp.js';
import { parseAuthFrame } from './validate.js';

const logger = createStderrLogger();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── settings → 落盘 env（先于任何工具执行；toolOutputRoot 与 host 同源） ──

function applySettingsEnv(): void {
  const raw = process.env.VESSEL_PLUGIN_CONFIG;
  if (raw === undefined || raw === '') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('tools-engine: VESSEL_PLUGIN_CONFIG is not valid JSON');
    return;
  }
  if (!isRecord(parsed)) return;
  const { dataDir, toolOutputDir } = parsed;
  if (typeof dataDir === 'string' && dataDir.trim() !== '') {
    process.env.VESSEL_DATA_DIR = dataDir;
  }
  if (typeof toolOutputDir === 'string' && toolOutputDir.trim() !== '') {
    process.env.VESSEL_TOOL_OUTPUT_DIR = toolOutputDir;
  }
}

// ── 模式判定（S19）：env 对存在 → pool；否则 child 路径逐字不变 ──

const poolDir = process.env.VESSEL_ENGINE_POOL_DIR ?? '';
const engineId = process.env.VESSEL_ENGINE_ID ?? '';

if (poolDir !== '' && engineId !== '') {
  startPoolMode(poolDir, engineId);
} else {
  applySettingsEnv();

  // ── 出站协议帧（单行 8 MiB 守卫；S10 codec 单实现） ─────────────

  const { writeFrame } = createNdjsonWriter(process.stdout, {
    maxBytes: ENGINE_MAX_MESSAGE_BYTES,
    // 写端不产生入站帧；出站超限由 writeFrame false 折回（现态语义）。
    onFrame: () => {},
    onViolation: () => {},
  });

  function writeResult(id: unknown, result: unknown): void {
    if (!writeFrame({ jsonrpc: '2.0', id, result })) {
      writeFrame({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'engine result exceeds the message size limit' },
      });
    }
  }

  function writeError(id: unknown, code: number, message: string): void {
    writeFrame({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function sendNotification(method: string, params: unknown): void {
    // 超限 notification 直接丢弃（writeFrame 返回 false）。
    writeFrame({ jsonrpc: '2.0', method, params });
  }

  // ── tool.callback 出站请求：自增 id + pending map ─────────────

  let nextRequestId = 1;
  const pendingCallbacks = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  function sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = nextRequestId++;
    const key = String(id);
    return new Promise<unknown>((resolve, reject) => {
      pendingCallbacks.set(key, { resolve, reject });
      if (!writeFrame({ jsonrpc: '2.0', id, method, params })) {
        pendingCallbacks.delete(key);
        reject(new Error('engine request exceeds the message size limit'));
      }
    });
  }

  function settleCallback(id: unknown, frame: Record<string, unknown>): void {
    const key = typeof id === 'number' ? String(id) : typeof id === 'string' ? id : undefined;
    if (key === undefined) return;
    const pending = pendingCallbacks.get(key);
    if (pending === undefined) return;
    pendingCallbacks.delete(key);
    const error = frame.error;
    if (error !== undefined) {
      const message =
        isRecord(error) && typeof error.message === 'string'
          ? error.message
          : 'tool.callback failed';
      pending.reject(new Error(message));
      return;
    }
    pending.resolve(frame.result);
  }

  // MCP 连接在 worker 侧；被动断开 → health notification（带 mcp 快照，host 缓存读面）。
  const mcp = new McpConnectionManager({
    notifyHealth: () => sendNotification(ENGINE_WIRE.health, engine.health()),
    logger,
  });
  const engine = new ToolsEngine({ request: sendRequest, notify: sendNotification }, mcp);

  // ── 入站分发（S10 codec 交付已解析 record；非 JSON 诊断 warn 随冻结形状移除） ──

  function handleFrame(parsed: Record<string, unknown>): void {
    const id = parsed.id;
    const method = typeof parsed.method === 'string' ? parsed.method : undefined;

    // 回包帧（id + result/error，无 method）→ settle tool.callback pending。
    if (method === undefined) {
      if (
        id !== undefined &&
        id !== null &&
        (parsed.result !== undefined || parsed.error !== undefined)
      ) {
        settleCallback(id, parsed);
      }
      return;
    }

    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'plugin.hello':
        if (isRequest) writeResult(id, { protocol: 1, ok: true });
        return;
      case 'plugin.activate':
        if (isRequest) writeResult(id, { ok: true });
        return;
      case 'ping':
        if (isRequest) writeResult(id, { pong: true });
        return;
      case 'plugin.deactivate':
        void (async () => {
          await engine.dispose();
          if (isRequest) writeResult(id, { ok: true });
        })();
        return;
      case ENGINE_WIRE.mcpControl:
        if (!isRequest) return;
        void (async () => {
          try {
            writeResult(id, await engine.handleMcpControl(parsed.params));
          } catch (error) {
            writeError(id, -32000, errorMessage(error));
          }
        })();
        return;
      case ENGINE_WIRE.toolInvoke:
        if (!isRequest) return;
        void (async () => {
          try {
            writeResult(id, await engine.handleInvoke(parsed.params));
          } catch (error) {
            writeError(id, -32000, errorMessage(error));
          }
        })();
        return;
      case ENGINE_WIRE.registrySync:
        if (!isRequest) return;
        try {
          writeResult(id, engine.handleRegistrySync(parsed.params));
        } catch (error) {
          writeError(id, -32000, errorMessage(error));
        }
        return;
      case ENGINE_WIRE.health:
        if (isRequest) writeResult(id, engine.health());
        return;
      case ENGINE_WIRE.toolCancel:
        try {
          engine.handleCancel(parsed.params);
        } catch (error) {
          logger.warn('tools-engine: tool.cancel rejected', { message: errorMessage(error) });
        }
        return;
      case ENGINE_WIRE.implReject:
        try {
          engine.handleImplReject(parsed.params);
        } catch (error) {
          logger.warn('tools-engine: engine.impl.reject rejected', {
            message: errorMessage(error),
          });
        }
        return;
      default:
        if (isRequest) writeError(id, -32601, `Unknown method: ${method}`);
        return;
    }
  }

  // ── 退出路径（host terminate / stdin end） ────────────────────

  let shuttingDown = false;

  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      // dispose 含 mcp.dispose：关全部 server 连接（杀孙进程）后再退出。
      await engine.dispose();
      for (const pending of pendingCallbacks.values()) {
        pending.reject(new Error(ENGINE_ERROR.unavailable));
      }
      pendingCallbacks.clear();
      process.exit(0);
    })();
  }

  attachNdjsonReader(process.stdin, {
    maxBytes: ENGINE_MAX_MESSAGE_BYTES,
    onFrame: handleFrame,
    // 残留 buffer 超限：codec 已清 buffer；host 出站同限守卫在先，只对非法帧触发（§5(c)）。
    onViolation: () => {
      logger.warn('tools-engine: inbound frame exceeds the message size limit');
    },
  });
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

// ── pool 模式（S19）：TCP loopback + 首行 auth 分流 + 每 data 连接一个 NodeScope ──

/** S2 auth 超时（冻结 5s；与 PoolTransport auth 超时同值）。 */
const POOL_AUTH_TIMEOUT_MS = 5_000;

/** 每 data 连接一个 NodeScope：registry/inFlight/MCP 全按 scope（S19）。 */
interface PoolScope {
  nodeId: string;
  incarnation: number;
  socket: net.Socket;
  engine: ToolsEngine;
  pendingCallbacks: Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >;
  dispatch(frame: Record<string, unknown>): void;
}

/**
 * S18 准入阈值：settings 经 spawn env VESSEL_PLUGIN_CONFIG 下发（S7）。
 * pool 模式只读 maxInflight / rssSoftLimitMb；dirs 永不设进程全局 env（Q9，验收⑧）。
 */
function readPoolLimits(): { maxInflight: number; rssSoftLimitBytes?: number } {
  const defaultMaxInflight = Math.max(cpus().length, 1) * 4;
  const raw = process.env.VESSEL_PLUGIN_CONFIG;
  if (raw === undefined || raw === '') return { maxInflight: defaultMaxInflight };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('tools-engine: VESSEL_PLUGIN_CONFIG is not valid JSON');
    return { maxInflight: defaultMaxInflight };
  }
  if (!isRecord(parsed)) return { maxInflight: defaultMaxInflight };
  const { maxInflight, rssSoftLimitMb } = parsed;
  const limits: { maxInflight: number; rssSoftLimitBytes?: number } = {
    maxInflight:
      typeof maxInflight === 'number' && Number.isFinite(maxInflight) && maxInflight > 0
        ? Math.floor(maxInflight)
        : defaultMaxInflight,
  };
  if (typeof rssSoftLimitMb === 'number' && Number.isFinite(rssSoftLimitMb) && rssSoftLimitMb > 0) {
    limits.rssSoftLimitBytes = rssSoftLimitMb * 1024 * 1024;
  }
  return limits;
}

function startPoolMode(poolDir: string, engineId: string): void {
  const startedAt = Date.now();
  // S6：tokens engine 自生成（每 spawn 轮换）；control_token 永不进 routing（gateway 只发布 data_token）。
  const controlToken = randomBytes(32).toString('base64url');
  const dataToken = randomBytes(32).toString('base64url');
  const limits = readPoolLimits();
  /** node_id → 最新代际 scope（S2 incarnation fencing：incoming ≥ current 取代，< 拒 4409）。 */
  const scopes = new Map<string, PoolScope>();
  let boundPort = 0;
  let shuttingDown = false;

  function inflightTotal(): number {
    let total = 0;
    for (const scope of scopes.values()) total += scope.engine.inFlightCount();
    return total;
  }

  /** S18：派发前进程级准入；busy 折 error 回包（S3 稳定码），不折 content、不进模型、无队列。 */
  function busyMessage(): string | undefined {
    if (inflightTotal() >= limits.maxInflight) {
      return `${ENGINE_BUSY_PREFIX}: tool engine is at capacity`;
    }
    if (
      limits.rssSoftLimitBytes !== undefined &&
      process.memoryUsage.rss() >= limits.rssSoftLimitBytes
    ) {
      return `${ENGINE_BUSY_PREFIX}: rss soft limit reached`;
    }
    return undefined;
  }

  /** S4：控制连接 engine.health = 进程级形状（loaded/mcp 缺省；busy ≠ 故障，不触发熔断/重启）。 */
  function processHealth(): {
    status: 'ok' | 'degraded';
    inflight_total: number;
    rss_bytes: number;
    scopes: number;
  } {
    const total = inflightTotal();
    const rss = process.memoryUsage.rss();
    const degraded =
      total >= limits.maxInflight ||
      (limits.rssSoftLimitBytes !== undefined && rss >= limits.rssSoftLimitBytes);
    return {
      status: degraded ? 'degraded' : 'ok',
      inflight_total: total,
      rss_bytes: rss,
      scopes: scopes.size,
    };
  }

  /** scope dispose（engine.ts:178-185 语义按 scope）：abort in-flight + 关 MCP 杀孙进程；callback 等待拒 unavailable。 */
  async function disposeScope(scope: PoolScope): Promise<void> {
    await scope.engine.dispose();
    for (const pending of scope.pendingCallbacks.values()) {
      pending.reject(new Error(ENGINE_ERROR.unavailable));
    }
    scope.pendingCallbacks.clear();
  }

  async function disposeAllScopes(): Promise<void> {
    const all = [...scopes.values()];
    scopes.clear();
    await Promise.all(all.map((scope) => disposeScope(scope)));
    for (const scope of all) scope.socket.destroy();
  }

  /** S19：进程 SIGTERM / 控制 deactivate → 全 scope dispose → exit 0。 */
  function shutdownPool(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await disposeAllScopes();
      process.exit(0);
    })();
  }

  process.on('SIGTERM', shutdownPool);

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let authenticated = false;
    let scopeRef: PoolScope | undefined;
    const codecWriter = createNdjsonWriter(socket, {
      maxBytes: ENGINE_MAX_MESSAGE_BYTES,
      onFrame: () => {},
      onViolation: () => {},
    });
    // 连接已销毁 → 静默丢弃（dispose 收口的迟到回包不写死 socket）。
    const writeFrame = (frame: Record<string, unknown>): boolean =>
      socket.destroyed ? false : codecWriter.writeFrame(frame);
    const writeResult = (id: unknown, result: unknown): void => {
      if (!writeFrame({ jsonrpc: '2.0', id, result })) {
        writeFrame({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'engine result exceeds the message size limit' },
        });
      }
    };
    const writeError = (id: unknown, code: number, message: string): void => {
      writeFrame({ jsonrpc: '2.0', id, error: { code, message } });
    };

    /** 控制连接方法面（S2 冻结）：hello / activate / ping / deactivate / health（进程级）；越面 close 4401。 */
    function handleControlFrame(frame: Record<string, unknown>): void {
      const id = frame.id;
      const method = typeof frame.method === 'string' ? frame.method : undefined;
      // 控制连接无出站请求；回包帧忽略。
      if (method === undefined) return;
      const isRequest = id !== undefined && id !== null;
      switch (method) {
        case 'plugin.hello':
          if (isRequest) writeResult(id, { protocol: 1, ok: true });
          return;
        case 'plugin.activate':
          // S19：自报 port（gateway loopback 复核；httpEndpoint 先例 child.ts）。
          if (isRequest) writeResult(id, { ok: true, port: boundPort });
          return;
        case 'ping':
          if (isRequest) writeResult(id, { pong: true });
          return;
        case 'plugin.deactivate':
          void (async () => {
            await disposeAllScopes();
            if (isRequest) writeResult(id, { ok: true });
            process.exit(0);
          })();
          return;
        case ENGINE_WIRE.health:
          if (isRequest) writeResult(id, processHealth());
          return;
        default:
          logger.warn('tools-engine pool: method outside control surface, closing connection', {
            closeCode: 4401,
            method,
          });
          socket.destroy();
          return;
      }
    }

    /** data 连接 = 一个 NodeScope；ENGINE_WIRE 分发复用现态 handleFrame 逻辑（按 scope）。 */
    function createDataScope(auth: EngineAuthFrame & { role: 'data' }): PoolScope {
      const pendingCallbacks = new Map<
        string,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
      >();
      let nextRequestId = 1;
      const sendNotification = (method: string, params: unknown): void => {
        // 超限 notification 直接丢弃（writeFrame 返回 false）。
        writeFrame({ jsonrpc: '2.0', method, params });
      };
      const sendRequest = (method: string, params: unknown): Promise<unknown> => {
        const id = nextRequestId++;
        const key = String(id);
        return new Promise<unknown>((resolve, reject) => {
          pendingCallbacks.set(key, { resolve, reject });
          if (!writeFrame({ jsonrpc: '2.0', id, method, params })) {
            pendingCallbacks.delete(key);
            reject(new Error('engine request exceeds the message size limit'));
          }
        });
      };
      const settleCallback = (id: unknown, frame: Record<string, unknown>): void => {
        const key = typeof id === 'number' ? String(id) : typeof id === 'string' ? id : undefined;
        if (key === undefined) return;
        const pending = pendingCallbacks.get(key);
        if (pending === undefined) return;
        pendingCallbacks.delete(key);
        const error = frame.error;
        if (error !== undefined) {
          const message =
            isRecord(error) && typeof error.message === 'string'
              ? error.message
              : 'tool.callback failed';
          pending.reject(new Error(message));
          return;
        }
        pending.resolve(frame.result);
      };
      // MCP 被动断开 → 本 scope health notification（per-scope，不跨连接）。
      const mcp = new McpConnectionManager({
        notifyHealth: () =>
          sendNotification(ENGINE_WIRE.health, {
            ...engine.health(),
            status: processHealth().status,
          }),
        logger,
      });
      // dirs 权威 = host 装配（S2）：只透传至 executeWorker（S13），不解析/不自决/不持久化/不设进程 env。
      const engine = new ToolsEngine({ request: sendRequest, notify: sendNotification }, mcp, {
        dataDir: auth.dirs.data_dir,
        toolOutputDir: auth.dirs.tool_output_dir,
      });
      const scope: PoolScope = {
        nodeId: auth.node_id,
        incarnation: auth.incarnation,
        socket,
        engine,
        pendingCallbacks,
        dispatch: (frame) => {
          const id = frame.id;
          const method = typeof frame.method === 'string' ? frame.method : undefined;

          // 回包帧（id + result/error，无 method）→ settle tool.callback pending。
          if (method === undefined) {
            if (
              id !== undefined &&
              id !== null &&
              (frame.result !== undefined || frame.error !== undefined)
            ) {
              settleCallback(id, frame);
            }
            return;
          }

          const isRequest = id !== undefined && id !== null;
          switch (method) {
            case 'plugin.hello':
            case 'plugin.activate':
            case 'plugin.deactivate':
              // S2 分权（解释 (a)）：进程生命周期方法 control-only；data 调 → close 4401。
              logger.warn('tools-engine pool: control-only method on data connection, closing', {
                closeCode: 4401,
                method,
              });
              socket.destroy();
              return;
            case 'ping':
              // ping 双角色（解释 (a)）：data 连接心跳应答。
              if (isRequest) writeResult(id, { pong: true });
              return;
            case ENGINE_WIRE.mcpControl:
              if (!isRequest) return;
              void (async () => {
                try {
                  writeResult(id, await engine.handleMcpControl(frame.params));
                } catch (error) {
                  writeError(id, -32000, errorMessage(error));
                }
              })();
              return;
            case ENGINE_WIRE.toolInvoke: {
              if (!isRequest) return;
              // S18：派发前准入；busy 折 error 回包（不折 content、不进模型）。
              const busy = busyMessage();
              if (busy !== undefined) {
                writeError(id, ENGINE_BUSY_CODE, busy);
                return;
              }
              void (async () => {
                try {
                  writeResult(id, await engine.handleInvoke(frame.params));
                } catch (error) {
                  writeError(id, -32000, errorMessage(error));
                }
              })();
              return;
            }
            case ENGINE_WIRE.registrySync:
              if (!isRequest) return;
              try {
                writeResult(id, engine.handleRegistrySync(frame.params));
              } catch (error) {
                writeError(id, -32000, errorMessage(error));
              }
              return;
            case ENGINE_WIRE.health:
              // S4：数据连接 = per-scope 形状（进程字段缺省）；status 透传进程级 degraded（S16 any-degraded 合并）。
              if (isRequest)
                writeResult(id, { ...engine.health(), status: processHealth().status });
              return;
            case ENGINE_WIRE.toolCancel:
              try {
                engine.handleCancel(frame.params);
              } catch (error) {
                logger.warn('tools-engine: tool.cancel rejected', { message: errorMessage(error) });
              }
              return;
            case ENGINE_WIRE.implReject:
              try {
                engine.handleImplReject(frame.params);
              } catch (error) {
                logger.warn('tools-engine: engine.impl.reject rejected', {
                  message: errorMessage(error),
                });
              }
              return;
            default:
              if (isRequest) writeError(id, -32601, `Unknown method: ${method}`);
              return;
          }
        },
      };
      return scope;
    }

    // 首行 auth（S2）：5s 未鉴权 / token 不符 → 4401；形状不过 → 4400；僵尸 incarnation → 4409。
    // TCP 无 close code：诊断标签只进 engine 日志（解释 (b)）；失败 = close，不返回错误帧。
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        logger.warn('tools-engine pool: auth timeout, closing connection', { closeCode: 4401 });
        socket.destroy();
      }
    }, POOL_AUTH_TIMEOUT_MS);

    let handleFrame: (frame: Record<string, unknown>) => void = (frame) => {
      let auth: EngineAuthFrame;
      try {
        auth = parseAuthFrame(frame);
      } catch (error) {
        logger.warn('tools-engine pool: malformed auth frame, closing connection', {
          closeCode: 4400,
          message: errorMessage(error),
        });
        socket.destroy();
        return;
      }
      if (auth.role === 'control') {
        if (auth.token !== controlToken) {
          logger.warn('tools-engine pool: control token mismatch, closing connection', {
            closeCode: 4401,
          });
          socket.destroy();
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        writeFrame({ ok: true });
        handleFrame = handleControlFrame;
        return;
      }
      if (auth.token !== dataToken) {
        logger.warn('tools-engine pool: data token mismatch, closing connection', {
          closeCode: 4401,
        });
        socket.destroy();
        return;
      }
      const existing = scopes.get(auth.node_id);
      if (existing !== undefined && auth.incarnation < existing.incarnation) {
        // 僵尸 fencing：旧代际重连只被拒，不污染 scope 状态。
        logger.warn('tools-engine pool: stale incarnation, closing connection', {
          closeCode: 4409,
          node_id: auth.node_id,
        });
        socket.destroy();
        return;
      }
      if (existing !== undefined) {
        // 取代（incoming ≥ current）：旧 scope dispose + 旧连接 close；
        // 旧连接 close 回调按代际同一性检查，不触新 scope。
        scopes.delete(auth.node_id);
        existing.socket.destroy();
        void disposeScope(existing);
      }
      authenticated = true;
      clearTimeout(authTimer);
      const scope = createDataScope(auth);
      scopeRef = scope;
      scopes.set(auth.node_id, scope);
      writeFrame({ ok: true });
      handleFrame = scope.dispatch;
    };

    attachNdjsonReader(socket, {
      maxBytes: ENGINE_MAX_MESSAGE_BYTES,
      onFrame: (frame) => handleFrame(frame),
      // 残留超限 = 协议违规（host 出站同限守卫在先）：fail-closed 关连接 → scope dispose。
      onViolation: () => {
        logger.warn('tools-engine pool: inbound frame exceeds the message size limit, closing');
        socket.destroy();
      },
    });

    socket.on('error', (error) => {
      logger.warn('tools-engine pool: connection error', { message: errorMessage(error) });
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      const scope = scopeRef;
      // 控制断 / 未鉴权断 → 不退出（S19：detached，等 adopt）。
      if (scope === undefined) return;
      // data 连接 close → scope dispose；只认当前代际（被取代的旧连接不触新 scope）。
      if (scopes.get(scope.nodeId) === scope) {
        scopes.delete(scope.nodeId);
        void disposeScope(scope);
      }
    });
  });

  server.on('error', (error) => {
    logger.error('tools-engine pool: server error', { message: errorMessage(error) });
    process.exit(1);
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    boundPort = address !== null && typeof address === 'object' ? address.port : 0;
    // S6：bind 后自写状态文件（atomicWrite 0600；gateway 读其 adopt/探测/发布；pid 复核带 started_at）。
    const state = {
      v: 1,
      id: engineId,
      pid: process.pid,
      port: boundPort,
      control_token: controlToken,
      data_token: dataToken,
      version: readPackageVersion(),
      started_at: startedAt,
    };
    void atomicWrite(
      join(poolDir, 'engines', `${engineId}.json`),
      `${JSON.stringify(state, null, 2)}\n`,
      { mode: 0o600, ensureDir: true },
    ).then(
      () => {
        logger.info('tools-engine pool: listening', { id: engineId, port: boundPort });
      },
      (error: unknown) => {
        logger.error('tools-engine pool: cannot write state file', {
          message: errorMessage(error),
        });
        process.exit(1);
      },
    );
  });
}

// 兜底：handler 异常已在分发处折回包；这里只防意外异常崩 child（诊断走 stderr）。
process.on('uncaughtException', (error) => {
  logger.error('tools-engine: uncaught exception', { message: errorMessage(error) });
});
process.on('unhandledRejection', (reason) => {
  logger.error('tools-engine: unhandled rejection', { message: errorMessage(reason) });
});
