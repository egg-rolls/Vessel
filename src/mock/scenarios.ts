/**
 * 确定性 mock 场景 provider（0.8.6 G1）
 *
 * 场景名是冻结契约：echo / tools / permissions / error / multi-turn。
 * 默认 echo 的行为（文本、usage、流式分片）与 core 的 MemoryLLMProvider 一致。
 */

import type { ChatRequest, LLMProvider, LLMResponse } from '../../packages/core/src/index';

export const MOCK_SCENARIOS = ['echo', 'tools', 'permissions', 'error', 'multi-turn'] as const;

export type MockScenarioName = (typeof MOCK_SCENARIOS)[number];

/** tools / permissions 共用的无害命令：不写文件、不联网 */
export const DEMO_TOOL_COMMAND = 'echo vessel-demo-ok';

export interface ResolvedMockScenario {
  name: MockScenarioName;
  /** 原始 env 值（仅未知值时有），供入口层打印一次警告 */
  unknown?: string;
}

const SCENARIO_SET: ReadonlySet<string> = new Set(MOCK_SCENARIOS);

/** 解析 `VESSEL_MOCK_SCENARIO`：未设置 → echo；未知值 → echo + 原值 */
export function resolveMockScenario(raw: string | undefined): ResolvedMockScenario {
  if (raw === undefined || raw.trim() === '') return { name: 'echo' };
  if (SCENARIO_SET.has(raw)) return { name: raw as MockScenarioName };
  return { name: 'echo', unknown: raw };
}

/** 构造场景 provider */
export function createScenarioProvider(name: MockScenarioName): LLMProvider {
  return new ScenarioLLMProvider(name);
}

class ScenarioLLMProvider implements LLMProvider {
  private toolCallCount = 0;

  constructor(private readonly scenario: MockScenarioName) {}

  async chat(req: ChatRequest): Promise<LLMResponse> {
    if (this.scenario === 'error') {
      throw new Error('Mock scenario error: simulated provider failure.');
    }

    const resp = this.respond(req);
    emitChunks(req, resp);
    return resp;
  }

  private respond(req: ChatRequest): LLMResponse {
    const lastMessage = req.messages[req.messages.length - 1];

    switch (this.scenario) {
      case 'tools':
      case 'permissions':
        return this.respondToolRound(lastMessage);
      case 'multi-turn':
        return this.respondMultiTurn(req);
      default:
        return echoResponse(req);
    }
  }

  /** 首轮发 bash 调用；收到 tool 结果后收尾（同一会话下一轮可再次发起） */
  private respondToolRound(lastMessage: ChatRequest['messages'][number] | undefined): LLMResponse {
    if (lastMessage?.role === 'tool') {
      return {
        content: 'Tool call finished. The assistant received the tool result.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
      };
    }
    this.toolCallCount++;
    return {
      content: 'Running a harmless demo command.',
      tool_calls: [
        {
          id: `mock_call_${this.toolCallCount}`,
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: DEMO_TOOL_COMMAND }) },
        },
      ],
      finish_reason: 'tool_calls',
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    };
  }

  private respondMultiTurn(req: ChatRequest): LLMResponse {
    const userTurns = req.messages.filter((m) => m.role === 'user').length;
    const lastUser = findLastUserContent(req.messages);
    return {
      content: `Turn ${userTurns}: ${lastUser}`,
      finish_reason: 'stop',
      usage: {
        prompt_tokens: lastUser.length,
        completion_tokens: lastUser.length + 8,
        total_tokens: lastUser.length * 2 + 8,
      },
    };
  }
}

/** echo：与 MemoryLLMProvider 的默认分支逐字一致 */
function echoResponse(req: ChatRequest): LLMResponse {
  const lastMessage = req.messages[req.messages.length - 1];
  if (lastMessage?.role === 'tool') {
    return {
      content: lastMessage.content,
      finish_reason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
  }

  const userInput = findLastUserContent(req.messages);
  return {
    content: `Echo: ${userInput}`,
    finish_reason: 'stop',
    usage: {
      prompt_tokens: userInput.length,
      completion_tokens: userInput.length + 10,
      total_tokens: userInput.length * 2 + 10,
    },
  };
}

function findLastUserContent(messages: ChatRequest['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

/** 流式分片：与 MemoryLLMProvider.chat 的 on_chunk 行为一致 */
function emitChunks(req: ChatRequest, resp: LLMResponse): void {
  const onChunk = req.on_chunk;
  if (!onChunk) return;

  const text = resp.content;
  if (text.length > 2) {
    const mid = Math.max(1, Math.floor(text.length / 2));
    onChunk({ type: 'text_delta', delta: text.slice(0, mid) });
    onChunk({ type: 'text_delta', delta: text.slice(mid) });
  } else if (text.length > 0) {
    onChunk({ type: 'text_delta', delta: text });
  }

  if (resp.tool_calls) {
    for (let i = 0; i < resp.tool_calls.length; i++) {
      const tc = resp.tool_calls[i];
      if (!tc) continue;
      onChunk({
        type: 'tool_call_delta',
        tool_call_index: i,
        tool_call_id: tc.id,
        tool_call_name: tc.function.name,
        arguments_delta: tc.function.arguments,
      });
    }
  }

  onChunk({ type: 'finish', finish_reason: resp.finish_reason, usage: resp.usage });
}
