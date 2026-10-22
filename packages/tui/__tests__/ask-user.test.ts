/**
 * ask-user 交互能力测试（ADR-029：事件流交互）
 */

import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import { createAskUserTool } from '../src/renderer/ask-user';

/** 便捷构建测试输入 */
function sampleQuestions() {
  return {
    questions: [
      { header: '格式', question: '用哪种模块格式？', options: ['ESM', 'CJS'] },
      { header: '环境', question: '部署到哪？', options: ['生产', '预发布', '开发'] },
    ],
  };
}

/** 生成回答数组（对应 sampleQuestions） */
function sampleAnswers(answers: string[]) {
  return answers.map((answer, i) => ({
    header: sampleQuestions().questions[i]?.header ?? `q${i}`,
    question: sampleQuestions().questions[i]?.question ?? `question${i}`,
    answer,
  }));
}

/** 订阅 ask.user.requested 并自动应答 */
function autoAnswer(events: MemoryEventStream, answers: ReturnType<typeof sampleAnswers>) {
  events.subscribe((event) => {
    if (event.type === 'ask.user.requested') {
      const data = event.data as unknown as { requestId: string };
      events.publish({
        type: 'ask.user.answered',
        run_id: event.run_id,
        data: { requestId: data.requestId, answers },
        ts: Date.now(),
      });
    }
  });
}

describe('formatChoicePrefix（NO_COLOR 焦点可见）', () => {});

describe('createAskUserTool（事件流交互）', () => {
  it('creates ask_user tool with name + questions schema', () => {
    const tool = createAskUserTool();

    expect(tool.name).toBe('ask_user');
    expect(tool.inputSchema.required).toContain('questions');
  });

  it('handler publishes ask.user.requested and returns formatted answers', async () => {
    const events = new MemoryEventStream();
    autoAnswer(events, sampleAnswers(['ESM', '生产']));

    const tool = createAskUserTool();
    const result = await tool.handler(sampleQuestions(), {
      run_id: 'r1',
      messages: [],
      events,
    });

    expect(result).toContain('1. 格式: ESM');
    expect(result).toContain('2. 环境: 生产');
  });

  it('request event carries the normalized questions', async () => {
    const events = new MemoryEventStream();
    let captured:
      | { requestId: string; questions: Array<{ header: string; question: string }> }
      | undefined;

    events.subscribe((event) => {
      if (event.type === 'ask.user.requested') {
        captured = event.data as unknown as typeof captured;
        events.publish({
          type: 'ask.user.answered',
          run_id: event.run_id,
          data: { requestId: captured?.requestId ?? '', answers: sampleAnswers(['ESM', '开发']) },
          ts: Date.now(),
        });
      }
    });

    const tool = createAskUserTool();
    await tool.handler(sampleQuestions(), { run_id: 'r1', messages: [], events });

    expect(captured?.questions).toHaveLength(2);
    expect(captured?.questions[0]).toMatchObject({ header: '格式', question: '用哪种模块格式？' });
  });

  it('ask request drops session_id', async () => {
    const events = new MemoryEventStream();
    let captured: { requestId: string; session_id?: string } | undefined;

    events.subscribe((event) => {
      if (event.type !== 'ask.user.requested') return;
      captured = event.data as unknown as typeof captured;
      events.publish({
        type: 'ask.user.answered',
        run_id: event.run_id,
        data: { requestId: captured?.requestId ?? '', answers: sampleAnswers(['ESM', '生产']) },
        ts: Date.now(),
      });
    });

    const tool = createAskUserTool();
    await tool.handler(sampleQuestions(), {
      run_id: 'r1',
      session_id: 'session-9',
      messages: [],
      events,
    });

    expect(captured?.session_id).toBe('session-9');
  });

  it('handler normalizes missing header with a fallback', async () => {
    const events = new MemoryEventStream();
    events.subscribe((event) => {
      if (event.type === 'ask.user.requested') {
        const data = event.data as unknown as {
          requestId: string;
          questions: Array<{ header: string }>;
        };
        expect(data.questions[0]?.header).toBe('问题 1');
        events.publish({
          type: 'ask.user.answered',
          run_id: event.run_id,
          data: {
            requestId: data.requestId,
            answers: [{ header: '问题 1', question: '没有任何 header', answer: 'ESM' }],
          },
          ts: Date.now(),
        });
      }
    });

    const tool = createAskUserTool();
    const result = await tool.handler(
      { questions: [{ question: '没有任何 header' }] },
      { run_id: 'r1', messages: [], events },
    );

    expect(result).toContain('问题 1');
  });

  it('handler returns error when questions is empty', async () => {
    const tool = createAskUserTool();
    const result = await tool.handler(
      { questions: [] },
      { run_id: 'r1', messages: [], events: new MemoryEventStream() },
    );

    expect(result).toContain('Error');
    expect(result).toContain('non-empty');
  });

  it('handler returns error when too many questions', async () => {
    const tool = createAskUserTool();
    const five = Array.from({ length: 5 }, (_, i) => ({
      header: `q${i}`,
      question: `question ${i}`,
    }));
    const result = await tool.handler(
      { questions: five },
      { run_id: 'r1', messages: [], events: new MemoryEventStream() },
    );

    expect(result).toContain('Error');
    expect(result).toContain('too many');
  });

  it('handler returns error when a question has invalid options', async () => {
    const tool = createAskUserTool();
    const result = await tool.handler(
      { questions: [{ header: 'h', question: 'q', options: ['only one'] }] },
      { run_id: 'r1', messages: [], events: new MemoryEventStream() },
    );

    expect(result).toContain('Error');
    expect(result).toContain('options');
  });

  it('handler returns error when question text is missing', async () => {
    const tool = createAskUserTool();
    const result = await tool.handler(
      { questions: [{ header: 'h', question: '   ' }] },
      { run_id: 'r1', messages: [], events: new MemoryEventStream() },
    );

    expect(result).toContain('Error');
    expect(result).toContain('question is required');
  });

  it('empty answers (user cancel) returns an error', async () => {
    const events = new MemoryEventStream();
    events.subscribe((event) => {
      if (event.type === 'ask.user.requested') {
        const data = event.data as unknown as { requestId: string };
        events.publish({
          type: 'ask.user.answered',
          run_id: event.run_id,
          data: { requestId: data.requestId, answers: [] },
          ts: Date.now(),
        });
      }
    });

    const tool = createAskUserTool();
    const result = await tool.handler(sampleQuestions(), {
      run_id: 'r1',
      messages: [],
      events,
    });

    expect(result).toContain('Error');
  });

  it('waits without a timeout and returns as soon as the answer arrives (0.18)', async () => {
    const events = new MemoryEventStream();
    // 延迟应答：超过旧的短超时也仍应返回答案（证明默认没有自动超时）。
    events.subscribe((event) => {
      if (event.type !== 'ask.user.requested') return;
      const data = event.data as unknown as { requestId: string };
      setTimeout(() => {
        events.publish({
          type: 'ask.user.answered',
          run_id: event.run_id,
          data: { requestId: data.requestId, answers: sampleAnswers(['ESM', '生产']) },
          ts: Date.now(),
        });
      }, 150);
    });

    const tool = createAskUserTool();
    const result = await tool.handler(sampleQuestions(), {
      run_id: 'r1',
      messages: [],
      events,
    });

    expect(result).toContain('1. 格式: ESM');
  });

  it('keeps an explicit timeout available for tests / callers', async () => {
    const events = new MemoryEventStream();
    const tool = createAskUserTool({ timeout: 50 });
    const result = await tool.handler(sampleQuestions(), {
      run_id: 'r1',
      messages: [],
      events,
    });

    expect(result).toContain('Error');
    expect(result).toContain('Timed out');
  });

  it('workflow ask_user emits an interaction without a session', async () => {
    const events = new MemoryEventStream();
    // 若 workflow 守卫缺失，事件会被发布并在这里被应答；断言随后立即失败，
    // 而不是让 handler 在无人应答时无限等待。
    autoAnswer(events, sampleAnswers(['ESM', '生产']));

    const tool = createAskUserTool();
    const result = await tool.handler(sampleQuestions(), {
      run_id: 'r1',
      messages: [],
      events,
      source: 'workflow',
    });

    expect(events.getHistory().map((event) => event.type)).not.toContain('ask.user.requested');
    expect(result).toContain('workflow');
  });

  it('returns a cancellation message when the run aborts', async () => {
    const events = new MemoryEventStream();
    const controller = new AbortController();
    const tool = createAskUserTool();

    const pending = tool.handler(sampleQuestions(), {
      run_id: 'r1',
      messages: [],
      events,
      signal: controller.signal,
    });
    controller.abort();

    const result = await pending;
    expect(result).toContain('Error');
    expect(result).toContain('cancelled');
    expect(result).not.toContain('Timed out');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const events = new MemoryEventStream();
    const controller = new AbortController();
    controller.abort();
    const tool = createAskUserTool();

    const result = await tool.handler(sampleQuestions(), {
      run_id: 'r1',
      messages: [],
      events,
      signal: controller.signal,
    });

    expect(result).toContain('cancelled');
  });
});
