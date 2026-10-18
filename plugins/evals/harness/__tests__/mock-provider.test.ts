import { describe, expect, it } from 'bun:test';
import { ScriptedProvider, SwitchableProvider } from '../src/mock-provider.js';

const request = { messages: [], model: 'm' };

describe('ScriptedProvider', () => {
  it('replays responses in order', async () => {
    const provider = new ScriptedProvider([{ content: 'one' }, { content: 'two' }]);
    expect((await provider.chat(request)).content).toBe('one');
    expect((await provider.chat(request)).content).toBe('two');
    expect(provider.callCount).toBe(2);
    expect(provider.exhausted).toBe(false);
  });

  it('returns empty content and marks exhausted after responses run out', async () => {
    const provider = new ScriptedProvider([{ content: 'one' }]);
    await provider.chat(request);
    const response = await provider.chat(request);
    expect(response.content).toBe('');
    expect(response.finish_reason).toBe('stop');
    expect(provider.exhausted).toBe(true);
  });

  it('returns tool_calls when present', async () => {
    const provider = new ScriptedProvider([
      {
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{}' } }],
      },
    ]);
    const response = await provider.chat(request);
    expect(response.finish_reason).toBe('tool_calls');
    expect(response.tool_calls?.[0]?.function.name).toBe('echo');
  });
});

describe('SwitchableProvider', () => {
  it('switches scripts and reports exhaustion', async () => {
    const provider = new SwitchableProvider();
    provider.set([{ content: 'a' }]);
    expect((await provider.chat(request)).content).toBe('a');
    expect(provider.exhausted).toBe(false);

    provider.set([{ content: 'b' }]);
    expect((await provider.chat(request)).content).toBe('b');
    await provider.chat(request);
    expect(provider.exhausted).toBe(true);
  });
});
