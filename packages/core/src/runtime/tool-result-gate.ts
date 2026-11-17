/**
 * 工具结果出口闸（单条 ≤ 16k token）
 * @module @vessel-agent/core/runtime
 *
 * 每一条工具结果回给模型之前都过这里：预算内原样放行；超预算先落盘全文，再按
 * 「头 30% / 尾 70% + 一行省略标注（含落盘路径）」裁切。
 *
 * ## 为什么在 core（闸上移）
 * 闸原先长在 `plugins/tools/basic-tools` 里，是那个模块的**私有函数** —— 于是只有
 * bash / read / edit 三个 handler 在闸内，web_fetch / MCP / 未来插件的返回值原样进
 * 上下文：一条 100k 字符的结果就能把对话历史、系统提示、Self Card 挤出去。
 * 闸是「回给模型的每一条工具结果」的共同约束，不属于某个插件，所以上移到 core，
 * 由 loop 在写回上下文前**一处收口**（`tool-calling-loop.ts` 的 `gateToolResult`）。
 *
 * ## 三道闸的分工没变
 * token（本模块，第一道）→ 行数 2000 / 字节 2 MiB（`basic-tools` 的兜底）。
 * token 口径**只有一份**：直接用 `estimateTokens`（ASCII 0.25 / CJK 0.5 token 每字符，
 * `context/context-manager.ts`）。这里不另写一份实现 —— 口径漂移会让「上下文压缩」和
 * 「工具结果截断」互相打架（一个说装得下、一个说装不下）。
 *
 * ## 幂等（本模块的重点）
 * 已经裁过的结果**不能**被裁第二次：第二轮会把「… 省略 N 行 / M 字符 · 完整输出：<path>」
 * 那一行自己裁掉，模型只知道「中间有东西被省略」，却再也找不到落盘路径。
 *
 * 做法是**显式信封 + 回执**，不是正则嗅探省略标注行：
 * 1. handler 自己裁过 ⇒ `markToolResultBounded(ctx, originalChars)` 在 `ToolContext` 上
 *    登记一张回执（WeakMap，随 ctx 生命周期回收；handler 的签名仍是返回 string，不扩协议）；
 * 2. 工具管道认领回执（`takeToolResultGateReceipt`），带成 `ToolPipelineResult.bounded`；
 * 3. `ExecutionUnit` 带成 `ToolExecutionOutcome.bounded`；
 * 4. loop 见到 `bounded === true` 就原样写回，不再进闸。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { estimateTokens } from '../context/context-manager.js';
import type { ToolContext } from '../types/tool.js';

/**
 * 单条工具结果回给模型的 **token 上限**（第一道闸）。
 *
 * 取值理由：16k token ≈ 64k ASCII 字符，是「一轮完整问答」的量级；再高就会把对话历史、
 * 系统提示、self card 挤出去。事故校准：一条 bash 输出 1,344 行 / 423,386 字符
 * （平均每行 315 字符）≈ 106k token，**行数闸（2000 行）与字节闸（2 MiB）都没碰到**，
 * 于是原文整块进了上下文、直接撑爆 1M 窗口。所以闸必须按 token 计，不能只按行 / 字节计。
 */
export const MAX_TOOL_RESULT_TOKENS = 16_000;

/** 超预算时头部保留的预算比例（30%） */
const RESULT_HEAD_SHARE = 0.3;

/** 超预算时尾部保留的预算比例（70%）：错误信息、结论、汇总表通常压在尾部 */
const RESULT_TAIL_SHARE = 0.7;

/**
 * 省略标注行预留的 token（含落盘路径）。
 * 实测标注（中文 + 路径）< 150 token；取 256 是为了让「标注 + 头 + 尾」不越上限。
 */
const OMIT_MARKER_RESERVE_TOKENS = 256;

/**
 * 标注重切的最大轮数。收敛条件是预算单调下降（每轮按实测溢出量收缩），
 * 正常情况下第 1 轮就够；留 4 轮是防御 CJK 占比极端 + 标注异常长的输入。
 */
const RESULT_BUDGET_ATTEMPTS = 4;

/** 统计换行数（省略行数与行边界对齐共用；不 split，避免为计数复制整串） */
function countNewlines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

/**
 * 头部保留长度：求最大的 `end` 使 `estimateTokens(text.slice(0, end)) <= budget`。
 *
 * 搜索窗口 `maxChars = ceil(budget / 0.25)`：0.25 是每字符最便宜的计价（纯 ASCII），
 * 所以长度超过它的前缀必然超预算 —— 窗口把一次搜索的代价封在 O(budget) 字符内
 * （16k 预算 ≈ 64k 字符窗口 × log2 轮二分），与输出总长无关。
 */
function fitHeadLength(text: string, budget: number): number {
  const maxChars = Math.min(text.length, Math.ceil(budget / 0.25));
  let low = 0;
  let high = maxChars;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * 尾部保留起点：求最小的 `start` 使 `estimateTokens(text.slice(start)) <= budget`。
 * 窗口同上，从尾部量。
 */
function fitTailStart(text: string, budget: number): number {
  const maxChars = Math.ceil(budget / 0.25);
  const floor = Math.max(0, text.length - maxChars);
  let low = floor;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(mid)) <= budget) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * 头部切点退到行边界（丢掉被切断的半行）。
 * 只在新边界不低于「字符切点的一半」时才对齐 —— 否则（比如整份输出就是一行 200 万字符）
 * 退让会把头部退空，那还不如保留字符级切点。
 */
function snapHeadToLine(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const newline = text.lastIndexOf('\n', end - 1);
  if (newline < 0) return end;
  return newline + 1 >= Math.floor(end / 2) ? newline + 1 : end;
}

/** 尾部切点前进到行边界（丢掉被切断的半行）；同样带「不超过一半」的退让保护 */
function snapTailToLine(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return start;
  const newline = text.indexOf('\n', start);
  if (newline < 0) return start;
  const room = text.length - start;
  return newline + 1 - start <= Math.ceil(room / 2) ? newline + 1 : start;
}

/** 一次 token 裁剪的结果 */
export interface TokenCut {
  /** 头部保留内容 */
  head: string;
  /** 尾部保留内容 */
  tail: string;
  /** 被省略的字符数 */
  omittedChars: number;
  /** 被省略的行数（切点落在行中时，那一行也算被省略） */
  omittedLines: number;
}

/** 把文本按「头 30% / 尾 70%」的 token 预算切一刀（切点尽量对齐行边界） */
export function cutToTokenBudget(text: string, contentBudget: number): TokenCut {
  const headEnd = snapHeadToLine(text, fitHeadLength(text, contentBudget * RESULT_HEAD_SHARE));
  const fittedTail = snapTailToLine(text, fitTailStart(text, contentBudget * RESULT_TAIL_SHARE));
  // 防御：两侧预算之和 < 100%（预留标注）时不该重叠；真重叠就退化成不留尾部
  const tailStart = Math.max(fittedTail, headEnd);
  const omitted = text.slice(headEnd, tailStart);
  return {
    head: text.slice(0, headEnd),
    tail: text.slice(tailStart),
    omittedChars: omitted.length,
    omittedLines: countNewlines(omitted) + (omitted !== '' && !omitted.endsWith('\n') ? 1 : 0),
  };
}

/** 省略标注行：行数 / 字符数 / 落盘路径（落盘失败也要说清，别让模型以为输出就这么多） */
export function omitMarker(cut: TokenCut, persistPath: string | undefined): string {
  const counts = `省略 ${cut.omittedLines} 行 / ${cut.omittedChars} 字符`;
  return persistPath !== undefined
    ? `… ${counts} · 完整输出：${persistPath}`
    : `… ${counts} · 完整输出落盘失败（写入不可用）`;
}

/** 过闸的显式信封：`bounded` 是幂等标记，`originalChars` 让调用方知道原本多大 */
export interface BoundedToolResult {
  /** 回给模型的文本；预算内 = 原文（同一个字符串引用，逐字节不变） */
  content: string;
  /** 是否真的裁过；`true` 表示 content 已 ≤ MAX_TOOL_RESULT_TOKENS */
  bounded: boolean;
  /** 裁剪前的字符数（未裁时 = content.length） */
  originalChars: number;
}

/** 出口闸的落盘钩子：只有真的超预算才会被调用 */
export interface ToolResultGateOptions {
  /** 触顶时把**完整**结果写盘；返回落盘路径，失败返回 undefined */
  persist: () => Promise<string | undefined>;
}

/**
 * **出口闸本体**：所有工具结果回给模型之前都过这里（loop 一处收口，见 `tool-calling-loop.ts`）。
 *
 * 行为：
 * 1. 预算内（`estimateTokens <= MAX_TOOL_RESULT_TOKENS`）**原样返回**，逐字节不变 ——
 *    小输出零改动（`content` 就是同一个字符串引用，调用方可用 `bounded` 或引用比较判定）；
 * 2. 超预算 ⇒ 先落盘完整结果，再按「头 30% / 尾 70% + 中间一行省略标注（含路径）」裁切；
 * 3. 无论输入多畸形，返回值都 ≤ MAX_TOOL_RESULT_TOKENS：标注预留 256 token，仍超就按
 *    实测溢出量收缩预算重切，最多 RESULT_BUDGET_ATTEMPTS 轮。
 *
 * 幂等提醒：拿到 `bounded === true` 的结果后**不要再调一次**（第二遍会把省略标注裁掉）；
 * 而要 `markToolResultBounded(ctx, originalChars)` 登记回执，让下游跳过。
 *
 * 为什么尾部>头部：错误信息、失败原因、汇总行几乎总在末尾，砍掉尾部的代价远大于砍中间。
 */
export async function boundToolResult(
  text: string,
  options: ToolResultGateOptions,
): Promise<BoundedToolResult> {
  const originalChars = text.length;
  if (estimateTokens(text) <= MAX_TOOL_RESULT_TOKENS) {
    return { content: text, bounded: false, originalChars };
  }

  // 落盘只在这里触发一次；路径进省略标注，模型据此回头读全文。
  const persistPath = await options.persist();

  let contentBudget = MAX_TOOL_RESULT_TOKENS - OMIT_MARKER_RESERVE_TOKENS;
  let bounded = text;
  for (let attempt = 0; attempt < RESULT_BUDGET_ATTEMPTS; attempt += 1) {
    const cut = cutToTokenBudget(text, contentBudget);
    // 理论上不可达（上面已确认超预算）：退化成不裁，也不声称自己裁过。
    if (cut.omittedChars === 0) return { content: text, bounded: false, originalChars };
    bounded = `${cut.head}\n${omitMarker(cut, persistPath)}\n${cut.tail}`;
    const tokens = estimateTokens(bounded);
    if (tokens <= MAX_TOOL_RESULT_TOKENS) {
      return { content: bounded, bounded: true, originalChars };
    }
    // 实测溢出（标注比预留的更贵 / 舍入）：按溢出量收缩内容预算再切
    contentBudget -= tokens - MAX_TOOL_RESULT_TOKENS;
    if (contentBudget <= 1024) break;
  }
  return { content: bounded, bounded: true, originalChars };
}

// ── 幂等回执（handler → 管道 → loop） ───────────────────────
//
// 为什么用 WeakMap 挂在 ctx 上，而不是让 handler 返回对象：
// `ToolHandler` 的返回类型是 `Promise<string>`，被测试与插件直接读取；改成联合类型会让
// 所有既有调用点都要收窄（回归面太大），而回执本来就只对「这一次调用」有效 —— 挂在
// 每次调用新建的 `ToolContext` 上是它的自然生命周期，ctx 一回收回执就没了。

/** handler 自己裁过时登记的回执 */
export interface ToolResultGateReceipt {
  /** 已过闸：下游见到就不再裁 */
  bounded: true;
  /** 裁剪前字符数 */
  originalChars: number;
}

const gateReceipts = new WeakMap<ToolContext, ToolResultGateReceipt>();

/** 登记「这次工具结果已经过闸」（由自己裁剪的 handler 调用，幂等标记的唯一来源） */
export function markToolResultBounded(ctx: ToolContext, originalChars: number): void {
  gateReceipts.set(ctx, { bounded: true, originalChars });
}

/** 认领回执（工具管道用；取走即删，避免同一次调用被漏判成「没裁过」） */
export function takeToolResultGateReceipt(ctx: ToolContext): ToolResultGateReceipt | undefined {
  const receipt = gateReceipts.get(ctx);
  if (receipt !== undefined) gateReceipts.delete(ctx);
  return receipt;
}

// ── 落盘（唯一实现；loop 与 basic-tools 共用同一份） ──────────

/** 输出落盘根目录：显式 env → data_dir → 默认数据目录 */
export function toolOutputRoot(): string {
  const explicit = process.env.VESSEL_TOOL_OUTPUT_DIR;
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit);
  const dataDir = process.env.VESSEL_DATA_DIR;
  if (typeof dataDir === 'string' && dataDir.trim() !== '') {
    return path.join(path.resolve(dataDir), 'tool-output');
  }
  return path.join(os.homedir(), '.vessel', 'data', 'tool-output');
}

/** 目录名安全化：只保留字母数字与 ._- */
export function safeSegment(value: string | undefined): string {
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return cleaned === '' ? 'no-session' : cleaned;
}

/**
 * 把一次工具结果的**全文**写进 `<输出根>/<session>/<tool>-<ts>-<rand>.log`。
 * 失败返回 undefined（调用方把标注降级成「落盘失败」，但截断照做 ——
 * 一次 IO 失败不能变成「那就把整块原文塞回模型」）。
 */
export async function writeToolOutput(payload: {
  tool: string;
  body: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const dir = path.join(toolOutputRoot(), safeSegment(payload.sessionId));
    await mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      `${safeSegment(payload.tool)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
    );
    await writeFile(file, payload.body, 'utf-8');
    return file;
  } catch {
    return undefined;
  }
}
