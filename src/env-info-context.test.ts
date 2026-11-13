/**
 * 「环境信息 · 上下文」的增量视图测试（0.52）。
 *
 * 两件事一起钉：
 * 1. **服务端**：`prompt.system_context` 的 additive `changed` / `previous_hash` —— 首次没有
 *    （没有可比对象），之后每次环境快照变了才带，值取自固定词表；
 * 2. **客户端**：有 `changed` ⇒ 卡片渲「N 项变更 + 只列变更项 + 展开全量快照」；
 *    缺省 ⇒ 退回全量快照卡（**绝不**渲成「0 项变更」）。
 *
 * 直接跑：`bun run src/env-info-context.test.ts`（看输出文本判定，本机 bun 是 Windows 版，
 * 退出码不可信）。
 */

import { contextChangeEntries, parseContextChange } from '../apps/web/src/domains/chat/env-notice';
import {
  promptContextOfEvent,
  sessionSystemContextOfDetail,
  textListOf,
} from '../apps/web/src/domains/chat/transcript-items';
import {
  createRunJournalFactory,
  ExecutionUnit,
  MemoryEventStream,
  MemoryLLMProvider,
  MemorySessionStore,
  MemoryWorkingContext,
  type RunEvent,
} from '../packages/core/src/index';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/** 最小事件载荷：只要能渲成一张卡（hash + 一段原文）。 */
function payload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: 'aaaaaaaaaaaaaaaa',
    system_prompt: 'system',
    model: 'm1',
    tools_count: 3,
    ...patch,
  };
}

function eventOf(data: Record<string, unknown>): RunEvent {
  return { type: 'prompt.system_context', run_id: 'r1', data, ts: 1_700_000_000_000 };
}

async function main(): Promise<void> {
  // ---- 1. 服务端：首次没有 changed / previous_hash ----
  const session = new MemorySessionStore();
  const stream = new MemoryEventStream();
  const seen: Array<Record<string, unknown>> = [];
  stream.subscribe((event: RunEvent) => {
    if (event.type !== 'prompt.system_context') return;
    if (typeof event.data !== 'object' || event.data === null) return;
    seen.push(event.data as Record<string, unknown>);
  });
  const eu = await ExecutionUnit.create({
    provider: new MemoryLLMProvider(),
    model: 'probe-model',
    contextFactory: () => new MemoryWorkingContext({ maxTokens: 200_000 }),
    events: stream,
    limits: {},
    termination: {},
    journalFactory: createRunJournalFactory({ session, eventLog: undefined }),
    session,
    systemPrompt: 'probe system prompt',
    retry: { maxRetries: 0 },
  });
  await eu.run('hello', 's1');
  check('首轮发了一份快照', seen.length === 1, String(seen.length));
  check('首次没有 changed', seen[0]?.changed === undefined, JSON.stringify(seen[0]?.changed));
  check(
    '首次没有 previous_hash',
    seen[0]?.previous_hash === undefined,
    JSON.stringify(seen[0]?.previous_hash),
  );
  check('首份快照仍全量', typeof seen[0]?.system_prompt === 'string');

  // 工具面变了（运行期注册一个工具）⇒ 环境快照变了 ⇒ 必须再发一份，且只报变了的项。
  eu.pluginHost.registerTool({
    name: 'probe_tool',
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: 'ok' }),
  });
  await eu.run('again', 's1');
  check('环境变了要再发一份', seen.length === 2, String(seen.length));
  check(
    'changed 只列工具这一项',
    JSON.stringify(seen[1]?.changed) === JSON.stringify(['tools: 0 → 1']),
    JSON.stringify(seen[1]?.changed),
  );
  check(
    'previous_hash = 上一份的 hash',
    seen[1]?.previous_hash === seen[0]?.hash,
    `${String(seen[1]?.previous_hash)} vs ${String(seen[0]?.hash)}`,
  );
  check('payload 仍全量（原文还在）', typeof seen[1]?.system_prompt === 'string');
  await eu.dispose();

  // ---- 2. 客户端：有 changed ⇒ 增量卡；缺省 ⇒ 全量卡（不是「0 项变更」）----
  const incremental = promptContextOfEvent(
    eventOf(
      payload({ changed: ['model: m1 → m2', 'tools: 3 → 4'], previous_hash: 'bbbbbbbbbbbbbbbb' }),
    ),
  );
  check('解析出 changed', incremental?.changed?.length === 2, String(incremental?.changed?.length));
  check('解析出 previousHash', incremental?.previousHash === 'bbbbbbbbbbbbbbbb');
  const entries = contextChangeEntries(incremental?.changed ?? []);
  check('增量条目逐条拆开', entries.length === 2, String(entries.length));
  check('键是 model', entries[0]?.key === 'model', entries[0]?.key);
  check('值原样保留（不被翻译）', entries[0]?.value === 'm1 → m2', entries[0]?.value);
  check('键是 tools', entries[1]?.key === 'tools', entries[1]?.key);

  const unknownKey = parseContextChange('brand_new_thing: 1', 0);
  check('认不出的键不吞掉', unknownKey?.key === 'brand_new_thing', unknownKey?.key);
  check('没有值时只有键', parseContextChange('system_prompt', 0)?.value === undefined);

  const first = promptContextOfEvent(eventOf(payload()));
  check('首次：没有 changed', first?.changed === undefined);
  check('首次：没有 previousHash', first?.previousHash === undefined);
  check('首次：仍有全量原文', first?.systemPrompt === 'system');

  // 空数组等价于「不知道」：线上不会发「没有变化」的事件，收到空数组说明载荷不成形。
  check('空数组 = 不知道', textListOf([]) === undefined);
  check('混了非字符串 = 不知道', textListOf(['ok', 3]) === undefined);
  check(
    'detail 路径同样认 changed',
    sessionSystemContextOfDetail({
      session_id: 's1',
      system_context: {
        hash: 'cccccccccccccccc',
        system_prompt: 'system',
        changed: ['system_prompt: replaced'],
        previous_hash: 'bbbbbbbbbbbbbbbb',
      },
    } as never)?.changed?.[0] === 'system_prompt: replaced',
  );
  check(
    'detail 路径缺省 = 不知道',
    sessionSystemContextOfDetail({
      session_id: 's1',
      system_context: { hash: 'cccccccccccccccc', system_prompt: 'system', changed: [] },
    } as never)?.changed === undefined,
  );

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK env-info-context: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED env-info-context: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
