/**
 * D7：`llm.request` / `context.changed` 的完整 payload 只进 raw 流与 trace；
 * serve 的广播摘要在下游完成，不得影响发布与 trace 落盘。
 *
 * 这两类事件属于 `NON_PERSISTED_EVENT_TYPES`（派生/观测），按设计不进会话事件日志。
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryContextManager } from '../src/context/context-manager';
import { MemoryEventStream } from '../src/events/event-stream';
import { readTraceEvents } from '../src/observability/read-trace';
import { FileTraceRecorder } from '../src/observability/trace-recorder';
import { AgentRuntime } from '../src/runtime/agent-runtime';
import { MemoryPluginHost } from '../src/runtime/plugin-host';
import { SessionEventLog } from '../src/session/session-event-log';
import type { LLMResponse, Message } from '../src/types/provider';

describe('event payload persistence (D7)', () => {
  it('keeps full messages/message in the raw stream and trace, and adds session_id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vessel-event-payload-'));
    const sessionsDir = join(root, 'sessions');
    const traceDir = join(root, 'trace');
    const log = new SessionEventLog({ dir: sessionsDir, durable: false });
    try {
      const events = new MemoryEventStream();
      const recorder = new FileTraceRecorder({ dir: traceDir, events, tenantId: 'default' });
      const runtime = await AgentRuntime.create({
        provider: {
          chat: async (): Promise<LLMResponse> => ({ content: 'answer', finish_reason: 'stop' }),
        },
        model: 'm',
        pluginHost: new MemoryPluginHost(),
        context: new MemoryContextManager(),
        events,
        limits: { requestLimit: 10, toolCallsLimit: 5 },
        termination: { maxIterations: 10 },
        eventLog: log,
      });
      await runtime.run('hello', 's1', { runId: 'run-1' });
      await recorder.flush('run-1');

      // raw 流（hub 之前）保留完整 payload，并补 session_id。
      const live = events.getHistory();
      const liveRequest = live.find((event) => event.type === 'llm.request');
      const liveRequestData = liveRequest?.data as Record<string, unknown>;
      expect(liveRequestData.session_id).toBe('s1');
      const liveMessages = liveRequestData.messages as Message[];
      expect(liveMessages.map((message) => message.content)).toContain('hello');

      const liveChange = live.find(
        (event) =>
          event.type === 'context.changed' &&
          (event.data as { message?: Message }).message?.content === 'hello',
      );
      expect(liveChange).toBeDefined();
      const liveChangeData = (liveChange?.data ?? {}) as { session_id?: string };
      expect(liveChangeData.session_id).toBe('s1');

      // trace 落盘同样保留完整 payload。
      const traced = await readTraceEvents(traceDir, { run_id: 'run-1' });
      const tracedRequest = traced.find((event) => event.type === 'llm.request');
      const tracedRequestData = (tracedRequest?.data ?? {}) as {
        session_id?: string;
        messages?: Message[];
      };
      expect(tracedRequestData.session_id).toBe('s1');
      expect(tracedRequestData.messages?.length).toBe(liveMessages.length);
      const tracedChange = traced.find((event) => event.type === 'context.changed');
      expect((tracedChange?.data as { message?: Message } | undefined)?.message).toBeDefined();

      // 派生事件按设计不进会话事件日志。
      const persisted = await log.read('s1');
      expect(persisted.some((event) => event.type === 'llm.request')).toBe(false);
      expect(persisted.some((event) => event.type === 'context.changed')).toBe(false);

      await recorder.close();
      await runtime.dispose();
    } finally {
      await log.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
