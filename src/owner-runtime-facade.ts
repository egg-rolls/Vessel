/**
 * OwnerRuntimeFacade — 把 Host 的 owner `AgentHandle` 适配成 core 的 `RunnableAgent`。
 *
 * 0.2 装配层用它承接现有 `ReplContext.runtime` / headless / gateway 的消费面，
 * 不复制 AgentRuntime，也不做 `as unknown as AgentRuntime` 断言。
 *
 * 会话切换：core R2 的 `AgentHandle.run` 没有 sessionId 参数，
 * owner 的 sessionId 固定在 spawn 的 AgentSpec 上；因此当调用方传入不同的
 * sessionId 时，facade 关闭旧 owner 并按新 sessionId 重新 spawn。
 * 切换发生在两次 run 之间（REPL 的 /resume、/new 都会先清空共享 context）。
 */

import type {
  AgentHandle,
  EventStream,
  Message,
  PluginHost,
  RunnableAgent,
  RunOptions,
  RuntimeHost,
} from '../packages/core/src/index';

export interface OwnerRuntimeFacadeOptions {
  host: RuntimeHost;
  handle: AgentHandle;
  pluginHost: PluginHost;
  initialSessionId: string;
  /** 以指定 sessionId spawn 一个新的 owner handle */
  spawnOwner: (sessionId: string) => Promise<AgentHandle>;
}

export class OwnerRuntimeFacade implements RunnableAgent {
  readonly events: EventStream;
  readonly pluginHost: PluginHost;

  private handle: AgentHandle;
  private currentSessionId: string;
  private disposed = false;
  private switching: Promise<void> | null = null;

  constructor(private readonly options: OwnerRuntimeFacadeOptions) {
    this.events = options.host.events;
    this.pluginHost = options.pluginHost;
    this.handle = options.handle;
    this.currentSessionId = options.initialSessionId;
  }

  /** 当前 owner 的 sessionId（供测试/诊断） */
  get sessionId(): string {
    return this.currentSessionId;
  }

  async run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string> {
    this.assertAlive();

    const targetSessionId = sessionId ?? this.currentSessionId;
    if (targetSessionId !== this.currentSessionId) {
      await this.switchSession(targetSessionId);
      this.assertAlive();
    }

    const run = await this.handle.run(input, opts);
    return run.result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.options.host.close().catch(() => {
      // dispose 是同步契约；Host 关闭失败不阻断退出
    });
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('owner runtime is disposed');
  }

  /** 串行化会话切换，避免并发 run 各自 spawn 同一个 owner id */
  private async switchSession(sessionId: string): Promise<void> {
    this.switching ??= this.doSwitch(sessionId).finally(() => {
      this.switching = null;
    });
    await this.switching;
  }

  private async doSwitch(sessionId: string): Promise<void> {
    const previousSessionId = this.currentSessionId;
    const previous = this.handle;

    await previous.close();
    if (this.disposed) return;

    try {
      const next = await this.options.spawnOwner(sessionId);
      this.assertAlive();
      this.handle = next;
      this.currentSessionId = sessionId;
    } catch (error) {
      // 新会话 spawn 失败时恢复旧 owner，避免 facade 处于无 handle 状态
      if (!this.disposed) {
        this.handle = await this.options.spawnOwner(previousSessionId);
      }
      throw error;
    }
  }
}
