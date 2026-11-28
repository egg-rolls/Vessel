/**
 * 4.1：联邦出站 durable outbox —— peer down 不再即丢。
 *
 * 旧口径：`postFederation` 单 fetch，peer 不可达 → rejected → 消息永丢
 * （模型放弃即失）。本模块给运行时 send 端口一个持久化待投递队列：
 *
 * - **持久化**：`<dataDir>/federation-outbox.json`（0600、原子写、写串行化），
 *   进程重启后加载续投；条目只含 wire 消息（**不含 token**）+ 重试元数据。
 * - **bounded retry**：指数退避（1s 起、60s 封顶），`maxAttempts` 耗尽标
 *   `exhausted`（不再自动重试，保留供审计；事件可见），绝不无限重试。
 * - **重连补投**：向某 peer 的新投递成功 = 该 peer 重新可达 → 立即补投其积压；
 *   另有定时器按 `nextAttemptAt` 兜底（unref：不阻塞进程退出，盘上条目下次启动续）。
 * - **幂等去重**：enqueue 按 `message_id` 去重；补投恒用持久化的同一 wire 消息
 *   （`deliverFederationMessage`），对端按 `message_id` 幂等（`deduplicated`）。
 *
 * 策略（启用 / allowlist）每次补投现查（热应用移除 peer 即 fail-closed）；
 * 策略类拒绝（disabled / unknown_node / not_allowed）不入队（重试无意义）。
 * 事件回调只给稳定码 / 地址 / 计数，**不含 token、不含正文**。
 *
 * @module vessel/federation-outbox
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@vessel-agent/core';
import type { FederationMessage, FederationPostResult } from './federation-client';

export const FEDERATION_OUTBOX_FILE = 'federation-outbox.json';
const OUTBOX_VERSION = 1;

/** bounded retry 缺省参数（可注入覆盖；证据脚本用小值加速）。 */
export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_BACKOFF_BASE_MS = 1_000;
export const OUTBOX_BACKOFF_MAX_MS = 60_000;
/** 积压上限：peer 长期 down 时防无界堆积；满则拒绝新 enqueue（调用方如实 rejected）。 */
export const OUTBOX_MAX_ENTRIES = 500;

/** 一条待投递（wire 消息 + 重试元数据；不含 token）。 */
export interface FederationOutboxEntry {
  message: FederationMessage;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  /** 最近一次失败的稳定码（不含 token / 正文）。 */
  lastCode?: string;
  /** bounded retry 耗尽：不再自动重试，保留供审计。 */
  exhausted?: boolean;
}

/** outbox 事件（结构化日志用；不含 token / 正文）。 */
export interface FederationOutboxEvent {
  kind: 'enqueued' | 'delivered' | 'retry' | 'exhausted' | 'full' | 'load_failed';
  message_id?: string;
  to?: string;
  attempts?: number;
  code?: string;
  /**
   * q-error-e2 §3.7（additive）：correlation 根 = 既有 wire 字段 request_id ?? message_id
   * **本地派生，不上 wire**（main 2026-11-28 批准的设计字面偏离：接收侧严格顶层键
   * 白名单 serve/federation.ts:156-166/417，新键 → 旧 peer federation_invalid →
   * 非策略拒绝重试耗尽 = 丢用户正文；message_id 既是去重键又恒在 wire/盘上，
   * 设计意图「重试/去重/丢弃审计可关联」由派生达成）。
   */
  correlation_id?: string;
}

/** correlation 派生单源（request_id ?? message_id；二者均既有跨 wire 字段）。 */
function correlationOf(message: FederationMessage): string {
  return message.request_id ?? message.message_id;
}

export interface FederationOutboxOptions {
  /** 持久化目录（node dataDir）。 */
  dir: string;
  /** 投递接缝（端口注入：deliverFederationMessage + 当前 runtime/io）。 */
  deliver: (message: FederationMessage) => Promise<FederationPostResult>;
  now?: () => number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxEntries?: number;
  onEvent?: (event: FederationOutboxEvent) => void;
}

export interface FederationOutbox {
  /** 入队（按 message_id 幂等）；满返回 false。入队即触发一次投递尝试。 */
  enqueue(message: FederationMessage): Promise<boolean>;
  /** 向某 peer 的新投递成功后补投其积压（重连补投）。 */
  flushPeer(to: { node_id: string; team_id: string }): Promise<void>;
  /** 当前条目数（诊断 / 证据用）。 */
  size(): number;
  /** 停止定时器（进程退出 seam；盘上条目不受影响）。 */
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 严格解析盘上条目（损坏条目丢弃，不让一条坏数据卡死整个队列）。 */
function parseEntry(raw: unknown): FederationOutboxEntry | undefined {
  if (!isRecord(raw) || !isRecord(raw.message)) return undefined;
  const m = raw.message;
  if (
    m.protocol !== 'vessel.federation/1' ||
    typeof m.message_id !== 'string' ||
    m.message_id === '' ||
    typeof m.conversation_id !== 'string' ||
    typeof m.content !== 'string' ||
    typeof m.ts !== 'number' ||
    typeof m.hop !== 'number' ||
    !isRecord(m.from) ||
    !isRecord(m.to) ||
    typeof m.from.node_id !== 'string' ||
    typeof m.from.team_id !== 'string' ||
    typeof m.to.node_id !== 'string' ||
    typeof m.to.team_id !== 'string'
  ) {
    return undefined;
  }
  const attempts = typeof raw.attempts === 'number' && raw.attempts >= 0 ? raw.attempts : 0;
  const nextAttemptAt = typeof raw.nextAttemptAt === 'number' ? raw.nextAttemptAt : 0;
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0;
  return {
    message: raw.message as unknown as FederationMessage,
    attempts,
    nextAttemptAt,
    createdAt,
    ...(typeof raw.lastCode === 'string' ? { lastCode: raw.lastCode } : {}),
    ...(raw.exhausted === true ? { exhausted: true } : {}),
  };
}

/** 策略类拒绝：重试无意义（配置不变则结果不变），不入队。 */
export function isPolicyRejection(result: FederationPostResult): boolean {
  return (
    result.status === 'rejected' &&
    (result.code === 'federation_disabled' ||
      result.code === 'federation_unknown_node' ||
      result.code === 'federation_not_allowed')
  );
}

/**
 * 构造 durable outbox。加载盘上积压并排定补投；缺省参数见常量。
 * 加载失败（损坏 / 不可读）不抛：从空队列开始 + load_failed 事件（best-effort，
 * 与 manifest / pid 记录同口径 —— 运行时状态损坏不阻断节点）。
 */
export function createFederationOutbox(options: FederationOutboxOptions): FederationOutbox {
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  const backoffBase = options.backoffBaseMs ?? OUTBOX_BACKOFF_BASE_MS;
  const backoffMax = options.backoffMaxMs ?? OUTBOX_BACKOFF_MAX_MS;
  const maxEntries = options.maxEntries ?? OUTBOX_MAX_ENTRIES;
  const file = path.join(options.dir, FEDERATION_OUTBOX_FILE);
  const emit = (event: FederationOutboxEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // 观察者抛错不影响投递。
    }
  };

  let entries: FederationOutboxEntry[] = [];
  let loadPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** 写串行化 + flush 串行化（并发 enqueue / flushPeer 不互相覆盖）。 */
  let writes: Promise<void> = Promise.resolve();
  let flushes: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const body = `${JSON.stringify({ v: OUTBOX_VERSION, entries }, null, 2)}\n`;
    writes = writes
      .then(() => atomicWrite(file, body, { mode: 0o600, ensureDir: true }))
      .catch(() => undefined);
    return writes;
  }

  function backoffMs(attempts: number): number {
    return Math.min(backoffMax, backoffBase * 2 ** Math.max(0, attempts - 1));
  }

  function schedule(): void {
    if (closed) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const pending = entries.filter((entry) => entry.exhausted !== true);
    if (pending.length === 0) return;
    const earliest = Math.min(...pending.map((entry) => entry.nextAttemptAt));
    const delay = Math.max(0, earliest - now());
    timer = setTimeout(() => {
      timer = undefined;
      void flushDue();
    }, delay);
    // 不阻塞进程退出：盘上条目下次启动续投。
    timer.unref?.();
  }

  function load(): Promise<void> {
    // 共享同一加载 Promise：并发 enqueue / flush 不会在加载完成前操作空队列。
    if (loadPromise === undefined) {
      loadPromise = (async () => {
        try {
          const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
          if (isRecord(raw) && raw.v === OUTBOX_VERSION && Array.isArray(raw.entries)) {
            entries = raw.entries
              .map(parseEntry)
              .filter((entry): entry is FederationOutboxEntry => entry !== undefined);
          }
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== 'ENOENT') emit({ kind: 'load_failed', code: code ?? 'parse_error' });
          entries = [];
        }
        schedule();
      })();
    }
    return loadPromise;
  }

  /** 投递一条到期条目并按结果更新元数据（成功摘除 / 失败退避 / 耗尽标记）。 */
  async function attempt(entry: FederationOutboxEntry): Promise<void> {
    let result: FederationPostResult;
    try {
      result = await options.deliver(entry.message);
    } catch (error) {
      // 配置错误（CA 不可读等）：按瞬时失败退避，bounded 耗尽后停。
      result = {
        status: 'rejected',
        code: 'federation_error',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const to = `${entry.message.to.node_id}:${entry.message.to.team_id}`;
    if (result.status !== 'rejected') {
      entries = entries.filter((item) => item !== entry);
      emit({
        kind: 'delivered',
        message_id: entry.message.message_id,
        to,
        attempts: entry.attempts,
        correlation_id: correlationOf(entry.message),
      });
      await persist();
      return;
    }
    entry.attempts += 1;
    entry.lastCode = result.code;
    if (entry.attempts >= maxAttempts || isPolicyRejection(result)) {
      entry.exhausted = true;
      emit({
        kind: 'exhausted',
        message_id: entry.message.message_id,
        to,
        attempts: entry.attempts,
        code: result.code,
        correlation_id: correlationOf(entry.message),
      });
    } else {
      // 退避至少 1ms：注入零退避 + 假时钟时防 flushDue 原地重选死循环。
      entry.nextAttemptAt = now() + Math.max(1, backoffMs(entry.attempts));
      emit({
        kind: 'retry',
        message_id: entry.message.message_id,
        to,
        attempts: entry.attempts,
        code: result.code,
        correlation_id: correlationOf(entry.message),
      });
    }
    await persist();
  }

  /** 串行 flush：所有到期（nextAttemptAt <= now）且未耗尽的条目，FIFO。 */
  function flushDue(): Promise<void> {
    flushes = flushes.then(async () => {
      await load();
      for (;;) {
        const at = now();
        const due = entries.find((entry) => entry.exhausted !== true && entry.nextAttemptAt <= at);
        if (due === undefined) break;
        await attempt(due);
      }
      schedule();
    });
    return flushes;
  }

  void load();

  return {
    async enqueue(message: FederationMessage): Promise<boolean> {
      await load();
      if (entries.some((entry) => entry.message.message_id === message.message_id)) {
        // 幂等：同一 message_id 已在队（重试 / 重复调用不产生第二条）。
        return true;
      }
      if (entries.length >= maxEntries) {
        emit({
          kind: 'full',
          message_id: message.message_id,
          correlation_id: correlationOf(message),
        });
        return false;
      }
      const at = now();
      entries.push({ message, attempts: 0, nextAttemptAt: at, createdAt: at });
      emit({
        kind: 'enqueued',
        message_id: message.message_id,
        to: `${message.to.node_id}:${message.to.team_id}`,
        correlation_id: correlationOf(message),
      });
      await persist();
      // 入队即试一次（peer 可能只是瞬时抖动）；失败进退避。
      await flushDue();
      return true;
    },
    async flushPeer(to: { node_id: string; team_id: string }): Promise<void> {
      await load();
      flushes = flushes.then(async () => {
        // 每条条目本次补投至多试一次：失败进退避后不得被同轮再选（防死循环）。
        const tried = new Set<FederationOutboxEntry>();
        for (;;) {
          const due = entries.find(
            (entry) =>
              entry.exhausted !== true &&
              !tried.has(entry) &&
              entry.message.to.node_id === to.node_id &&
              entry.message.to.team_id === to.team_id,
          );
          if (due === undefined) break;
          tried.add(due);
          // 重连补投不受退避时钟约束（peer 刚被证实可达）。
          await attempt(due);
        }
        schedule();
      });
      return flushes;
    },
    size(): number {
      return entries.length;
    },
    close(): void {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
