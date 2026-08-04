/**
 * Session 多轮记忆 / 跨进程 resume / listRich 测试
 *
 * 钉住 agent-runtime.run() 的历史恢复行为（不再无条件 clear）+
 * SessionBackend.listRich() 的过滤与排序。
 */
import { describe, expect, it } from 'bun:test';
import {
  AgentRuntime,
  type ChatRequest,
  type LLMProvider,
  type LLMResponse,
  MemoryContextManager,
  MemoryEventStream,
  MemorySessionBackend,
  MemoryToolRegistry,
  type Message,
  SQLiteSessionBackend,
} from '../src/index';

/** 记录每次收到的 messages，返回 stop */
class RecordingProvider implements LLMProvider {
  received: Message[][] = [];
  async chat(req: ChatRequest): Promise<LLMResponse> {
    this.received.push(req.messages.map((m) => ({ ...m })));
    return {
      content: `reply to: ${req.messages.filter((m) => m.role === 'user').pop()?.content ?? ''}`,
      finish_reason: 'stop',
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };
  }
}

function makeRuntime(
  provider: LLMProvider,
  session: MemorySessionBackend,
  context = new MemoryContextManager(),
) {
  return AgentRuntime.create({
    provider,
    model: 'test',
    tools: new MemoryToolRegistry(),
    context,
    events: new MemoryEventStream(),
    limits: { requestLimit: 10, toolCallsLimit: 5 },
    termination: { maxIterations: 5 },
    session,
    systemPrompt: 'sys',
  });
}

describe('session 多轮与恢复', () => {
  it('同会话多轮：第二次 run 看到第一次的交换（context 不再被 clear）', async () => {
    const provider = new RecordingProvider();
    const session = new MemorySessionBackend();
    const rt = await makeRuntime(provider, session);
    await rt.run('first message', 'sess1');
    await rt.run('second message', 'sess1');

    const second = provider.received[1];
    expect(second?.some((m) => m.role === 'user' && m.content.includes('first message'))).toBe(
      true,
    );
  });

  it('跨进程 resume：新 runtime 从 backend 加载历史', async () => {
    const session = new MemorySessionBackend();
    const rt1 = await makeRuntime(new RecordingProvider(), session);
    await rt1.run('remember this', 'sessX');

    // 新进程：新 runtime + 新 context（空），同一 backend
    const rec2 = new RecordingProvider();
    const rt2 = await makeRuntime(rec2, session);
    await rt2.run('continue', 'sessX');

    const first = rec2.received[0];
    expect(first?.some((m) => m.content.includes('remember this'))).toBe(true);
  });

  it('不同会话隔离：sessA 的历史不泄漏到 sessB', async () => {
    const provider = new RecordingProvider();
    const session = new MemorySessionBackend();
    const rt = await makeRuntime(provider, session);
    await rt.run('secret A', 'sessA');
    await rt.run('query B', 'sessB');

    const b = provider.received[1];
    expect(b?.some((m) => m.content.includes('secret A'))).toBe(false);
  });
});

describe('listRich', () => {
  it('过滤空会话，按 updated_at 倒序，带 preview', async () => {
    const backend = new SQLiteSessionBackend(':memory:');
    await backend.save({
      run_id: 'r1',
      session_id: 'empty',
      messages: [],
      started_at: 1000,
      status: 'completed',
    });
    await backend.save({
      run_id: 'r2',
      session_id: 'old',
      messages: [{ role: 'user', content: 'old msg' }],
      started_at: 1000,
      status: 'completed',
      updated_at: 2000,
    });
    await backend.save({
      run_id: 'r3',
      session_id: 'new',
      messages: [{ role: 'user', content: 'new msg' }],
      started_at: 1000,
      status: 'completed',
      updated_at: 5000,
    });

    const rich = await backend.listRich();
    expect(rich.length).toBe(2); // empty 被过滤
    expect(rich[0]?.session_id).toBe('new'); // updated_at 倒序
    expect(rich[1]?.session_id).toBe('old');
    expect(rich[0]?.preview).toBe('new msg');
    expect(rich[0]?.message_count).toBe(1);
  });

  it('MemorySessionBackend.listRich 同样过滤+排序', async () => {
    const backend = new MemorySessionBackend();
    await backend.save({
      run_id: 'r1',
      session_id: 'empty',
      messages: [],
      started_at: 1000,
      status: 'completed',
    });
    await backend.save({
      run_id: 'r2',
      session_id: 'a',
      messages: [{ role: 'user', content: 'hello' }],
      started_at: 1000,
      status: 'completed',
      updated_at: 3000,
    });
    const rich = await backend.listRich();
    expect(rich.length).toBe(1);
    expect(rich[0]?.session_id).toBe('a');
    expect(rich[0]?.preview).toBe('hello');
  });

  it('branch 字段持久化并出现在 listRich 中', async () => {
    const backend = new SQLiteSessionBackend(':memory:');
    await backend.save({
      run_id: 'r1',
      session_id: 'with-branch',
      messages: [{ role: 'user', content: 'test' }],
      started_at: 1000,
      status: 'completed',
      branch: 'feat/my-feature',
    });
    await backend.save({
      run_id: 'r2',
      session_id: 'no-branch',
      messages: [{ role: 'user', content: 'test2' }],
      started_at: 1000,
      status: 'completed',
    });

    const rich = await backend.listRich();
    const withBranch = rich.find((s) => s.session_id === 'with-branch');
    const noBranch = rich.find((s) => s.session_id === 'no-branch');
    expect(withBranch?.branch).toBe('feat/my-feature');
    expect(noBranch?.branch).toBeUndefined();
  });

  it('MemorySessionBackend branch 字段通过 toSessionInfo 传递', async () => {
    const backend = new MemorySessionBackend();
    await backend.save({
      run_id: 'r1',
      session_id: 's1',
      messages: [{ role: 'user', content: 'hello' }],
      started_at: 1000,
      status: 'completed',
      branch: 'main',
    });
    const rich = await backend.listRich();
    expect(rich[0]?.branch).toBe('main');
  });
});
