/**
 * @vessel-agent/doc-subscription - 订阅生命周期（placeholder 耦合）
 * @module @vessel-agent/doc-subscription/lifecycle
 *
 * BeforeLlm（观察循环前，每 run 一次）消费会话壳的 `cleared_tool_call_ids` 冻结集：
 * 被 trim 换成占位符的 read 工具结果 ⇒ 释放对应 read 引用；origin='read' 且引用归零的
 * 条目过期删除。**过期只由清除驱动**：压缩/pop 导致输出离开窗口不触发过期
 * （passthrough 档 cleared 恒空 ⇒ 订阅不动，自洽）；edit/manual origin 永不自过期。
 *
 * 零新实体（CONTRACT-swarm-subscribe §0.3）：不新增 core 事件/port/字段，直接读
 * file-backend 文档化存储格式的壳 JSON（`<sessions_dir>/<encodeURIComponent(id)>.json`，
 * legacy 回落未编码文件名）。core 只做**函数**导入（resolveSingleTenantPaths /
 * normalizeClearedToolCallIds，recall 先例）；不做类/枚举/常量运行时导入，故不用
 * FileSessionStore 类，壳读取在这里 best-effort 实现。
 *
 * 时序（已核实）：段起点 freeze（execution-unit.ts:2950）→ 初始 saveSessionState（:3057）
 * → runToolCallingLoop（:3061）⇒ 首次 BeforeLlm 时盘上已是本段冻结集，无滞后。
 * `cleared_consumed` ledger 单调增长：pop/段重置后同 id 再现不重复释放。
 *
 * 已知局限：
 * - 仅 file backend 有壳文件；sqlite backend 会话无壳 ⇒ 生命周期跳过。
 * - 壳读取/解析任何失败 ⇒ 静默跳过（不抛进 hook 流、不删文件）。
 * - reads/cleared_consumed 随会话增长，无任意上限（宪法 10：测量需要时再加）。
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalPath, DEFAULT_READ_LIMIT } from '@vessel-agent/basic-tools';
import { normalizeClearedToolCallIds, resolveSingleTenantPaths } from '@vessel-agent/core';
import { type DocSubscriptionConfig, resolveInput } from './config.js';
import type { SessionSubscriptionState } from './store.js';

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Node errno 是否为「文件不存在」（file-backend isNotFound 同口径） */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** 旧版未编码壳路径（仅对无路径分隔符的 id 生效；file-backend legacyFilePath 同口径） */
function legacyShellPath(sessionsDir: string, sessionId: string): string | undefined {
  if (sessionId.length === 0) return undefined;
  if (sessionId === '.' || sessionId === '..') return undefined;
  if (sessionId.includes('/') || sessionId.includes('\\')) return undefined;
  return path.join(sessionsDir, `${sessionId}.json`);
}

/**
 * 读会话壳 JSON。主路径 ENOENT 才回落 legacy（file-backend load 同口径）；
 * 其余读取失败 / JSON 损坏 / 结构非法 ⇒ undefined（跳过生命周期，不删文件）。
 */
async function readSessionShell(
  sessionsDir: string,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(sessionsDir, `${encodeURIComponent(sessionId)}.json`), 'utf-8');
  } catch (error) {
    if (!isNotFound(error)) return undefined;
    const legacy = legacyShellPath(sessionsDir, sessionId);
    if (legacy === undefined) return undefined;
    try {
      raw = await readFile(legacy, 'utf-8');
    } catch {
      return undefined;
    }
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 顺扫壳 messages 建 tool_call 配对表。语义逐条 mirror core indexToolCalls
 * （cleared-tool-result.ts:96-101）：后出现的消息覆盖先出现的、消息内先出现的 call
 * 不被覆盖。需要可迭代 Map 所以插件内建表，不导入该函数。
 */
function indexShellToolCalls(messages: unknown): Map<string, { name: string; arguments: string }> {
  const index = new Map<string, { name: string; arguments: string }>();
  if (!Array.isArray(messages)) return index;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant') continue;
    if (!Array.isArray(message.tool_calls)) continue;
    const seenInMessage = new Set<string>();
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue;
      const id = call.id;
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seenInMessage.has(id)) continue;
      seenInMessage.add(id);
      const fn: Record<string, unknown> = isRecord(call.function) ? call.function : {};
      index.set(id, {
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
      });
    }
  }
  return index;
}

/**
 * 释放一条 read 引用：解析被清 read 的 args → canonical（config.cwd）→ 按规范化请求值
 * (offset, limit) 删**一条**匹配记录（相同请求的多次 read 记录可互换，删任一条语义等价）。
 * 守护①②：释放后 origin='read' 且 reads 归零 ⇒ 删条目；edit/manual 永不自过期。
 */
function releaseReadRef(
  state: SessionSubscriptionState,
  argsJson: string,
  config: DocSubscriptionConfig,
): void {
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return;
  }
  if (!isRecord(args)) return;
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  if (rawPath === '') return;
  // 规范化与 readSubscribePath 同口径（offset??1 / limit??DEFAULT_READ_LIMIT）；
  // 非法请求值匹配不到任何 ref（ref 只存合法值），天然 no-op。
  const rawOffset = args.offset;
  const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? rawOffset : 1;
  const rawLimit = args.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : DEFAULT_READ_LIMIT;
  const canonical = canonicalPath(resolveInput(config, rawPath));
  const entry = state.subscriptions[canonical];
  if (entry === undefined) return;
  const index = entry.reads.findIndex((ref) => ref.offset === offset && ref.limit === limit);
  if (index >= 0) entry.reads.splice(index, 1);
  if (entry.origin === 'read' && entry.reads.length === 0) {
    delete state.subscriptions[canonical];
  }
}

/**
 * 消费会话壳的清除集合（边缘触发）。返回状态是否有变（调用方与观察循环合并落盘）。
 *
 * 即使 subscriptions 为空也要消费 ledger：否则「remove 清空订阅 → 同段再 read」之后，
 * 旧 cleared id 会在新引用上误释放（新 read 发生在清除之后，其输出仍在窗口里）。
 * 任何失败静默（best-effort，不打断 run）。
 */
export async function consumeClearedToolResults(
  state: SessionSubscriptionState,
  sessionId: string,
  config: DocSubscriptionConfig,
): Promise<boolean> {
  let shell: Record<string, unknown> | undefined;
  try {
    const sessionsDir = resolveSingleTenantPaths(config.dataDir).sessions_dir;
    shell = await readSessionShell(sessionsDir, sessionId);
  } catch {
    return false;
  }
  if (shell === undefined) return false;

  const cleared = normalizeClearedToolCallIds(shell.cleared_tool_call_ids) ?? [];
  // 空集 ⇒ 整段跳过（passthrough 档 cleared 恒空 ⇒ 订阅不动）。
  if (cleared.length === 0) return false;
  const consumed = new Set(state.cleared_consumed);
  const newlyCleared = cleared.filter((id) => !consumed.has(id));
  if (newlyCleared.length === 0) return false;

  const calls = indexShellToolCalls(shell.messages);
  for (const id of newlyCleared) {
    const call = calls.get(id);
    if (call !== undefined && call.name === 'read') {
      releaseReadRef(state, call.arguments, config);
    }
    // 无论是否 read / 是否有条目，id 一律进 ledger（单调增长）。
    state.cleared_consumed.push(id);
  }
  return true;
}
