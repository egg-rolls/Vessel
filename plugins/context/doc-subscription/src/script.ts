/**
 * @vessel-agent/doc-subscription - 订阅脚本异步执行器（q-subscription-script）
 * @module @vessel-agent/doc-subscription/script
 *
 * 设计 §2.4：kickoff 严格 fire-and-forget（BeforeLlm hook 的 await 路径零子进程等待），
 * 结果入内存队列，完成后的下一个 BeforeLlm drain 消费（ambient 非打断）。
 *
 * 安全（fail-closed）：
 * - argv 数组 spawn，`shell: false`（命令本体只来自用户配置 allowlist，杜绝注入）；
 * - 超时 kill（POSIX 进程组 / Windows taskkill 进程树）；stdout 累计超上限截断 + 标记；
 * - 单飞：每 key（session_id + name）同时最多一个在飞进程；
 * - spawn 失败 / 崩溃 / 超时全部 catch ⇒ 不阻塞 run、不抛进 hook-runner。
 *
 * 生命周期（dispose）：kill 全部在飞 + 清 timer + 清队列。**不永久禁用**执行器：
 * 成员 runtime 在 spawn 时复制父 host 的 hook 引用（runtime.ts），热应用 dispose 旧
 * 实例后成员仍持旧 hook —— 旧 hook 经 live getter 读活配置继续工作（hot-gate 同族
 * 修复的题中之义）；dispose 只清当时的在飞进程（结果丢一次可接受，检测会重跑）。
 * 诚实标注：dispose 之后旧 hook 再发起的进程只受各自超时闸约束。
 *
 * env 继承：子进程继承 process.env（脚本是用户信任的命令，设计 §5 诚实标注；
 * env_allowlist 收紧留 P2）。
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ScriptSpec } from './config.js';

/** 一次脚本执行的结果（完成 / 超时 / 崩溃都产结果） */
export interface ScriptResult {
  /** 订阅名 */
  name: string;
  /** stdout（超 maxOutputBytes 截断） */
  stdout: string;
  /** stdout 是否被截断 */
  truncated: boolean;
  /** 退出码；null = spawn 失败 / 超时 kill / 信号终止 */
  exit: number | null;
  /** 是否超时被 kill */
  timedOut: boolean;
  /** spawn 失败 / 终止原因（诊断用；正常退出缺省） */
  error?: string;
  /** stderr 尾部（≤4KiB，诊断用；不进通知） */
  stderr: string;
  /** 发起时间（Unix ms） */
  startedAt: number;
  /** 完成时间（Unix ms） */
  completedAt: number;
  /** 执行时长（ms） */
  durationMs: number;
}

/** stderr 诊断上限 */
const MAX_STDERR_BYTES = 4096;
/** 每 key 结果队列上限（单飞 + 每请求 drain 下自然 ≤1-2；防异常堆积） */
const MAX_QUEUED_RESULTS = 8;
/** stdout 截断标记（英文：面向模型，与 notice 截断标记同口径） */
export const SCRIPT_OUTPUT_TRUNCATED = '… output truncated — inspect may be incomplete';

/** 在飞进程记录 */
interface InFlight {
  child: ReturnType<typeof spawn>;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

/** 单飞 / 结果队列的键：session_id + name（hook 实例被成员 runtime 共享引用） */
export function scriptFlightKey(sessionId: string, name: string): string {
  return `${sessionId}\u0000${name}`;
}

/** script 条目的状态键（与 file / health 键空间隔离，healthSubscriptionKey 同款） */
export function scriptSubscriptionKey(name: string): string {
  return `script:${name}`;
}

/** kill 进程树（Windows taskkill /T）或进程组（POSIX detached）；best-effort */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      // detached: true ⇒ 子进程是进程组长；负 pid 杀整组。
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程已退出
    }
  }
}

/**
 * 订阅脚本执行器：每个 hook 实例一份（成员共享引用 ⇒ 单飞按 session+name 键控）。
 * 全程同步 kickoff（spawn 即返回）+ 异步完成回调；drain 只读已完成结果。
 */
export class ScriptRunner {
  private readonly inFlight = new Map<string, InFlight>();
  private readonly results = new Map<string, ScriptResult[]>();

  /** 是否有在飞进程（单飞判据） */
  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** 是否有在飞 / 待投递结果（hook 便宜路径：无工作不额外 load 状态） */
  hasWork(): boolean {
    return this.inFlight.size > 0 || this.results.size > 0;
  }

  /**
   * 发起一次执行（fire-and-forget）。在飞 ⇒ 跳过返回 false；spawn 失败 ⇒ 产失败结果
   * 入队（drain 记 last_exit），返回 true。任何异常不抛给调用方。
   */
  kickoff(key: string, spec: ScriptSpec, cwd: string): boolean {
    if (this.inFlight.has(key)) return false;
    const startedAt = Date.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command[0] as string, spec.command.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        // POSIX：独立进程组（超时杀整组）；Windows：taskkill /T 杀树。
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      this.enqueue(key, {
        name: spec.name,
        stdout: '',
        truncated: false,
        exit: null,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
        stderr: '',
        startedAt,
        completedAt: Date.now(),
        durationMs: 0,
      });
      return true;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, spec.timeoutMs);
    // timer 不该独自撑住进程（fire-and-forget 语义）。
    timer.unref?.();

    this.inFlight.set(key, { child, timer, startedAt });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const remaining = spec.maxOutputBytes - stdoutBytes;
      if (chunk.byteLength <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.byteLength;
        return;
      }
      if (remaining > 0) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
      }
      truncated = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // 只留尾部诊断（滚动丢弃最旧）。
      stderrChunks.push(chunk);
      stderrBytes += chunk.byteLength;
      while (stderrBytes > MAX_STDERR_BYTES && stderrChunks.length > 1) {
        const dropped = stderrChunks.shift();
        stderrBytes -= dropped?.byteLength ?? 0;
      }
    });

    const settle = (exit: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.inFlight.delete(key);
      const completedAt = Date.now();
      let stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      if (truncated) stdout = `${stdout}\n${SCRIPT_OUTPUT_TRUNCATED}\n`;
      const result: ScriptResult = {
        name: spec.name,
        stdout,
        truncated,
        exit,
        timedOut,
        ...(error !== undefined ? { error } : {}),
        stderr: Buffer.concat(stderrChunks).toString('utf-8').slice(-MAX_STDERR_BYTES),
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
      };
      this.enqueue(key, result);
    };

    child.on('error', (error) => {
      // spawn 失败（ENOENT / EACCES）：'close' 可能不来，这里兜底产结果。
      settle(null, error.message);
    });
    child.on('close', (code, signal) => {
      settle(code, signal !== null ? `killed by ${signal}` : undefined);
    });
    return true;
  }

  /** 取走一个 key 的全部已完成结果（drain 用；只读已完成，绝不等待子进程） */
  drain(key: string): ScriptResult[] {
    const queued = this.results.get(key);
    if (queued === undefined || queued.length === 0) return [];
    this.results.delete(key);
    return queued;
  }

  /** 最近一次已完成结果（inspect 诊断用；不消费队列） */
  peek(key: string): ScriptResult | undefined {
    const queued = this.results.get(key);
    return queued !== undefined && queued.length > 0 ? queued[queued.length - 1] : undefined;
  }

  /** dispose：kill 全部在飞 + 清 timer + 清队列（不永久禁用，见模块注释） */
  dispose(): void {
    for (const { child, timer } of this.inFlight.values()) {
      clearTimeout(timer);
      killTree(child);
    }
    this.inFlight.clear();
    this.results.clear();
  }

  /** 结果入队（bounded；溢出丢最旧 —— 检测会重跑，丢一次可接受） */
  private enqueue(key: string, result: ScriptResult): void {
    let queued = this.results.get(key);
    if (queued === undefined) {
      queued = [];
      this.results.set(key, queued);
    }
    queued.push(result);
    while (queued.length > MAX_QUEUED_RESULTS) queued.shift();
  }
}
