/**
 * tools-engine child 入口（P2 seams 契约 §2.4）。
 *
 * stdout **只走 NDJSON JSON-RPC 协议帧**；诊断一律 stderr（core createStderrLogger）。
 * settings 从 VESSEL_PLUGIN_CONFIG 读 → 先于任何工具执行设落盘 env。
 * 出站单行 8 MiB 守卫（超限折 error 回包 / 丢弃 notification）；
 * handler 异常折 -32000 回包，不崩 child；stdin end → dispose + 退出。
 *
 * @module tools-engine/entry
 */

import * as readline from 'node:readline';
import { createStderrLogger } from '@vessel-agent/core';
import { ENGINE_ERROR, ENGINE_MAX_MESSAGE_BYTES, ENGINE_WIRE } from '@vessel-agent/engine-client';
import { ToolsEngine } from './engine.js';

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

applySettingsEnv();

// ── 出站协议帧（单行 8 MiB 守卫） ─────────────────────────────

const encoder = new TextEncoder();

function writeFrame(frame: Record<string, unknown>): boolean {
  const line = JSON.stringify(frame);
  if (encoder.encode(line).byteLength > ENGINE_MAX_MESSAGE_BYTES) return false;
  process.stdout.write(`${line}\n`);
  return true;
}

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
      isRecord(error) && typeof error.message === 'string' ? error.message : 'tool.callback failed';
    pending.reject(new Error(message));
    return;
  }
  pending.resolve(frame.result);
}

const engine = new ToolsEngine({ request: sendRequest, notify: sendNotification });

// ── 入站分发 ─────────────────────────────────────────────────

function handleLine(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    logger.warn('tools-engine: ignored non-JSON stdin line');
    return;
  }
  if (!isRecord(parsed)) return;
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
      engine.dispose();
      if (isRequest) writeResult(id, { ok: true });
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
        logger.warn('tools-engine: engine.impl.reject rejected', { message: errorMessage(error) });
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
  engine.dispose();
  for (const pending of pendingCallbacks.values()) {
    pending.reject(new Error(ENGINE_ERROR.unavailable));
  }
  pendingCallbacks.clear();
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed !== '') handleLine(trimmed);
});
lines.on('close', shutdown);

// 兜底：handler 异常已在分发处折回包；这里只防意外异常崩 child（诊断走 stderr）。
process.on('uncaughtException', (error) => {
  logger.error('tools-engine: uncaught exception', { message: errorMessage(error) });
});
process.on('unhandledRejection', (reason) => {
  logger.error('tools-engine: unhandled rejection', { message: errorMessage(reason) });
});
