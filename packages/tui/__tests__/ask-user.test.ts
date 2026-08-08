/**
 * ask-user 交互能力测试（ADR-029：事件流交互）
 */

import { describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel/core';
import { AskUserEvent, createAskUserTool } from '../src/renderer/ask-user';

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
    if (event.type === AskUserEvent.Requested) {
      const data = event.data as unknown as { requestId: string };
      events.publish({
        type: AskUserEvent.Answered,
        run_id: event.run_id,
        data: { requestId: data.requestId, answers },
        ts: Date.now(),
      });
    }
  });
}

describe('createAskUserTool（事件流交互）', () => {
  it('creates ask_user tool with default:true and interactive:true', () => {
    const tool = createAskUserTool();

    expect(tool.name).toBe('ask_user');
    expect(tool.default).toBe(true);
    expect(tool.interactive).toBe(true);
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
      if (event.type === AskUserEvent.Requested) {
        captured = event.data as unknown as typeof captured;
        events.publish({
          type: AskUserEvent.Answered,
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

  it('handler normalizes missing header with a fallback', async () => {
    const events = new MemoryEventStream();
    events.subscribe((event) => {
      if (event.type === AskUserEvent.Requested) {
        const data = event.data as unknown as {
          requestId: string;
          questions: Array<{ header: string }>;
        };
        expect(data.questions[0]?.header).toBe('问题 1');
        events.publish({
          type: AskUserEvent.Answered,
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
      if (event.type === AskUserEvent.Requested) {
        const data = event.data as unknown as { requestId: string };
        events.publish({
          type: AskUserEvent.Answered,
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

  it('times out with error when no subscriber answers (headless fallback)', async () => {
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
});
