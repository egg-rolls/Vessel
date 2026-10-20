/**
 * Evals 测试夹具：临时目录、suite 文件、fake runtime/provider。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ChatRequest,
  type LLMProvider,
  type LLMResponse,
  MemoryEventStream,
  MemoryPluginHost,
  type RunnableAgent,
} from '@vessel-agent/core';

export interface TempWorkspace {
  root: string;
  suites: string;
  out: string;
  cleanup(): Promise<void>;
}

export async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vessel-evals-'));
  const suites = path.join(root, 'suites');
  const out = path.join(root, 'out');
  await fs.mkdir(suites, { recursive: true });
  return {
    root,
    suites,
    out,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeSuite(
  dir: string,
  name: string,
  source: string,
  extension: 'yaml' | 'yml' | 'json' = 'yaml',
): Promise<string> {
  const target = path.join(dir, `${name}.${extension}`);
  await fs.writeFile(target, source, 'utf8');
  return target;
}

export function fakeProvider(content: string): LLMProvider {
  return {
    async chat(_req: ChatRequest): Promise<LLMResponse> {
      return {
        content,
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      };
    },
  };
}

export interface FakeRuntimeOptions {
  output?: string;
  /** 不 resolve，直到 signal abort。 */
  waitForAbort?: boolean;
  onRun?: (input: string, sessionId: string | undefined) => void;
}

export function fakeRuntime(options: FakeRuntimeOptions = {}): RunnableAgent {
  return {
    events: new MemoryEventStream(),
    pluginHost: new MemoryPluginHost(),
    async run(input, sessionId, runOptions) {
      options.onRun?.(typeof input === 'string' ? input : input.content, sessionId);
      if (options.waitForAbort === true) {
        return await new Promise<string>((_resolve, reject) => {
          runOptions?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return options.output ?? 'ok';
    },
    dispose() {
      // no-op
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
