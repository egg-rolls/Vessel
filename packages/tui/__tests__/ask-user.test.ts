/**
 * ask-user 交互能力测试
 * @module @vessel/tui/__tests__
 */

import { describe, expect, it } from 'bun:test';
import { AskUserBridge, createAskUserTool } from '../src/renderer/ask-user';

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

describe('AskUserBridge', () => {
  it('prompt() returns answers after respond()', async () => {
    const bridge = new AskUserBridge();
    const expected = sampleAnswers(['ESM', '生产']);

    bridge.onPrompt = (event) => {
      bridge.respond(event.id, expected);
    };

    const result = await bridge.prompt(sampleQuestions());
    expect(result).toEqual(expected);
  });

  it('prompt() passes questions in the event', async () => {
    const bridge = new AskUserBridge();
    let capturedEvent: unknown;

    bridge.onPrompt = (event) => {
      capturedEvent = event;
      bridge.respond(event.id, sampleAnswers(['ESM', '开发']));
    };

    await bridge.prompt(sampleQuestions());

    const evt = capturedEvent as { id: string; questions: unknown[] };
    expect(evt.questions).toHaveLength(2);
    expect(evt.questions[0]).toMatchObject({ header: '格式', question: '用哪种模块格式？' });
  });

  it('prompt() rejects on cancel()', async () => {
    const bridge = new AskUserBridge();

    bridge.onPrompt = (event) => {
      bridge.cancel(event.id, 'Changed my mind');
    };

    await expect(bridge.prompt(sampleQuestions())).rejects.toThrow('Changed my mind');
  });

  it('respond() on non-existent id is a no-op', () => {
    const bridge = new AskUserBridge();
    bridge.respond('non-existent', sampleAnswers(['x']));
  });

  it('cancelAll() rejects all pending prompts', async () => {
    const bridge = new AskUserBridge();
    // 注入 onPrompt 但保持 pending（不 respond），验证 cancelAll 能清理全部
    bridge.onPrompt = () => {};
    const p1 = bridge.prompt(sampleQuestions());
    const p2 = bridge.prompt(sampleQuestions());
    p1.catch(() => {});
    p2.catch(() => {});

    bridge.cancelAll('Shutdown');

    await expect(p1).rejects.toThrow('Shutdown');
    await expect(p2).rejects.toThrow('Shutdown');
  });

  it('prompt() throws immediately when no frontend injected onPrompt (no hang)', async () => {
    const bridge = new AskUserBridge();
    // 不设置 onPrompt，模拟非 TTY 简单模式等无前端场景
    await expect(bridge.prompt(sampleQuestions())).rejects.toThrow('no interactive frontend');
  });
});

describe('createAskUserTool', () => {
  it('creates ask_user tool with default:true', () => {
    const bridge = new AskUserBridge();
    const tool = createAskUserTool(bridge);

    expect(tool.name).toBe('ask_user');
    expect(tool.default).toBe(true);
    expect(tool.inputSchema.required).toContain('questions');
  });

  it('handler invokes bridge.prompt() and returns formatted answers', async () => {
    const bridge = new AskUserBridge();
    bridge.onPrompt = (event) => {
      bridge.respond(event.id, sampleAnswers(['ESM', '生产']));
    };

    const tool = createAskUserTool(bridge);
    const result = await tool.handler(sampleQuestions(), { run_id: 'r1', messages: [] });

    expect(result).toContain('1. 格式: ESM');
    expect(result).toContain('2. 环境: 生产');
  });

  it('handler normalizes missing header with a fallback', async () => {
    const bridge = new AskUserBridge();
    bridge.onPrompt = (event) => {
      // 断言归一化后的 header 已回退
      expect(event.questions[0]?.header).toBe('问题 1');
      bridge.respond(event.id, [{ header: '问题 1', question: '没有任何 header', answer: 'ESM' }]);
    };

    const tool = createAskUserTool(bridge);
    const result = await tool.handler(
      { questions: [{ question: '没有任何 header' }] },
      { run_id: 'r1', messages: [] },
    );

    expect(result).toContain('问题 1');
  });

  it('handler returns error when questions is empty', async () => {
    const bridge = new AskUserBridge();
    const tool = createAskUserTool(bridge);
    const result = await tool.handler({ questions: [] }, { run_id: 'r1', messages: [] });

    expect(result).toContain('Error');
    expect(result).toContain('non-empty');
  });

  it('handler returns error when too many questions', async () => {
    const bridge = new AskUserBridge();
    const tool = createAskUserTool(bridge);

    const five = Array.from({ length: 5 }, (_, i) => ({
      header: `q${i}`,
      question: `question ${i}`,
    }));
    const result = await tool.handler({ questions: five }, { run_id: 'r1', messages: [] });

    expect(result).toContain('Error');
    expect(result).toContain('too many');
  });

  it('handler returns error when a question has invalid options', async () => {
    const bridge = new AskUserBridge();
    const tool = createAskUserTool(bridge);
    const result = await tool.handler(
      { questions: [{ header: 'h', question: 'q', options: ['only one'] }] },
      { run_id: 'r1', messages: [] },
    );

    expect(result).toContain('Error');
    expect(result).toContain('options');
  });

  it('handler returns error when question text is missing', async () => {
    const bridge = new AskUserBridge();
    const tool = createAskUserTool(bridge);
    const result = await tool.handler(
      { questions: [{ header: 'h', question: '   ' }] },
      { run_id: 'r1', messages: [] },
    );

    expect(result).toContain('Error');
    expect(result).toContain('question is required');
  });

  it('without bridge (headless), handler returns error', async () => {
    const tool = createAskUserTool(); // no bridge
    const result = await tool.handler(sampleQuestions(), { run_id: 'r1', messages: [] });

    expect(result).toContain('Error');
    expect(result).toContain('no interactive frontend');
  });
});
