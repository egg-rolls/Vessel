import {
  type AgentMessage,
  type AgentService,
  type AgentServiceOptions,
  createAgentService,
  type MemberRuntimeMember,
  type MemberRuntimePort,
  type MemberTurnResult,
} from '../src/index.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出若干轮事件循环，等后台 turn 收口 */
export async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** 记录调用的假执行内核；不联网、不启子进程 */
export class FakeRuntime implements MemberRuntimePort {
  readonly spawned: MemberRuntimeMember[] = [];
  /** spawn 过的 Body session（rotate 断言用；与 spawned 同序） */
  readonly spawnedSessions: string[] = [];
  readonly cancelled: string[] = [];
  readonly cancelledSessions: string[] = [];
  readonly disposed: string[] = [];
  readonly disposedSessions: string[] = [];
  readonly turns: { member: MemberRuntimeMember; message: AgentMessage }[] = [];
  spawnError: Error | undefined;
  handler: (member: MemberRuntimeMember, message: AgentMessage) => Promise<MemberTurnResult> =
    async () => ({});

  async spawn(member: MemberRuntimeMember): Promise<void> {
    if (this.spawnError) throw this.spawnError;
    this.spawned.push(member);
    this.spawnedSessions.push(member.session_id);
  }

  async runTurn(member: MemberRuntimeMember, message: AgentMessage): Promise<MemberTurnResult> {
    this.turns.push({ member, message });
    return this.handler(member, message);
  }

  cancel(member: MemberRuntimeMember): void {
    this.cancelled.push(member.id);
    this.cancelledSessions.push(member.session_id);
  }

  dispose(member: MemberRuntimeMember): void {
    // 仍按 id 记录（兼容既有断言），另记 session 供 rotate / close 断言
    this.disposed.push(member.id);
    this.disposedSessions.push(member.session_id);
  }
}

export function makeService(overrides: Partial<AgentServiceOptions> = {}): {
  service: AgentService;
  runtime: FakeRuntime;
} {
  const runtime = new FakeRuntime();
  let counter = 0;
  const service = createAgentService({
    tenantId: 'default',
    runtime,
    newId: () => `id-${++counter}`,
    ...overrides,
  });
  return { service, runtime };
}
