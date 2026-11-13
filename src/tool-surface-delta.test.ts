/**
 * `tool-surface-delta` 的窄属性测试（0.52：工具面变更走「环境信息」增量告知）。
 *
 * 形态照抄 `src/refs-notice-hook.test.ts` / `src/self-card-delta.test.ts`（`check()` + 计数 +
 * 汇总），直接跑：
 *
 *   bun run src/tool-surface-delta.test.ts
 *
 * 判定看**输出文本**（`OK ... passed N / N` 或 `FAIL ...`）：本机 bun 是 Windows 版，退出码
 * 不可信。命名带 `.test.ts` 是为了 package.json 的 `files` 规则把它挡在发布包外，同时让
 * `bun run typecheck`（tsconfig 的 `src/` 范围）继续覆盖它。
 *
 * 断言的是**行为不变量**而不是整句文案：
 * - 通道：`role=user` + `name=vessel:notice`（与 runtime-notice / refs-notice 同一条），
 *   **不**写 system、不新造事件；
 * - scope = `tools`，且 Web 的词表认得出它（卡头标签是「工具」而不是兜底「上下文」）；
 * - 去重：同一变更只注入一次、没变不注入、回滚（A→B→A）仍然报；
 * - 文案报的是**名字**（+ subscribe / - fs_write），不是数字 —— 报个数字等于什么都没说；
 * - 长清单收口：超过明细上限时折成「and N more」，不让卡片静默吞掉。
 */

import { ENV_NOTICE_SCOPES, envNoticeCard } from '../apps/web/src/domains/chat/env-notice';
import {
  ENV_INFO_DETAIL_MARK,
  ENV_INFO_DETAILS_MAX,
  ENV_INFO_SCOPES,
} from '../packages/agent/src/env-info-scope';
import {
  createToolSurfaceDeltaHook,
  diffToolSurface,
  formatToolSurfaceDelta,
  isEmptyToolSurfaceChange,
} from '../packages/agent/src/tool-surface-delta';
import { type HookContext, HookType, type Message } from '../packages/core/src/index';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/** 跑一轮 BeforeLlm，返回这一轮新增的消息（hook 每轮写进新的 ctx）。 */
async function runRound(
  hook: ReturnType<typeof createToolSurfaceDeltaHook>,
  sessionId = 's1',
): Promise<Message[]> {
  const ctx: HookContext = { run_id: 'r', session_id: sessionId };
  await hook.run(ctx);
  return ctx.messages ?? [];
}

/** 明细行（去掉线格式标记）。 */
function detailLines(content: string): string[] {
  return content
    .split('\n')
    .slice(1)
    .map((line) => line.replace(ENV_INFO_DETAIL_MARK, ''));
}

async function main(): Promise<void> {
  // ---- 1. 文案形状：首行 scope 词 + 一行一条明细 ----
  const added = formatToolSurfaceDelta(diffToolSurface(['read'], ['read', 'ask', 'subscribe']));
  const addedLines = added.split('\n');
  check('首行 scope 词是 tools', addedLines[0]?.startsWith('tools: ') === true, addedLines[0]);
  check('摘要报新增条数', addedLines[0]?.includes('2 added') === true, addedLines[0]);
  check('明细一行一条', addedLines.length === 3, String(addedLines.length));
  check('明细带线格式标记', addedLines[1]?.startsWith(ENV_INFO_DETAIL_MARK) === true);
  check(
    '明细报的是名字（新增）',
    detailLines(added).join('|') === '+ ask|+ subscribe',
    detailLines(added).join('|'),
  );
  check(
    '摘要说明旧清单已过期',
    added.includes('tool list sent in earlier requests of this body is out of date') === true,
    addedLines[0],
  );

  // ---- 2. 删除方向也要报，且顺序稳定（同一批变更永远同一个字符串）----
  const removedOnly = formatToolSurfaceDelta(diffToolSurface(['bash', 'read'], ['read']));
  check('摘要报删除条数', removedOnly.includes('1 removed') === true, removedOnly.split('\n')[0]);
  check('明细带减号', detailLines(removedOnly)[0] === '- bash', detailLines(removedOnly)[0]);
  const both = diffToolSurface(['fs_write', 'read'], ['read', 'subscribe']);
  const bothText = formatToolSurfaceDelta(both);
  check(
    '新增与删除同时报',
    bothText.split('\n')[0]?.includes('1 added, 1 removed') === true,
    bothText.split('\n')[0],
  );
  check('新增在前、删除在后', detailLines(bothText).join('|') === '+ subscribe|- fs_write');

  // ---- 3. diff 是纯函数：同一输入永远同一输出，且不重复计数 ----
  const duplicated = diffToolSurface(['read', 'read'], ['read', 'ask', 'ask']);
  check('集合语义（去重）', duplicated.added.join('|') === 'ask', duplicated.added.join('|'));
  check('空变更可判定', isEmptyToolSurfaceChange(diffToolSurface(['a'], ['a'])) === true);
  check('非空变更可判定', isEmptyToolSurfaceChange(diffToolSurface(['a'], ['b'])) === false);

  // ---- 4. 长清单收口：超过上限折成「and N more」，不静默吞 ----
  const many = Array.from({ length: 25 }, (_unused, index) => `tool-${String(index)}`);
  const manyText = formatToolSurfaceDelta(diffToolSurface([], many));
  const manyLines = manyText.split('\n');
  check(
    '明细被收口到上限+1',
    manyLines.length === ENV_INFO_DETAILS_MAX + 2,
    String(manyLines.length),
  );
  check('最后一行说还有多少', manyLines[manyLines.length - 1]?.includes('more') === true);

  // ---- 5. hook：没变更完全不注入 ----
  let current: readonly string[] = ['read'];
  const hook = createToolSurfaceDeltaHook({ baseline: ['read'], current: () => current });
  check('hook 阶段 = HookType.BeforeLlm', hook.type === HookType.BeforeLlm, String(hook.type));
  check('没变更不注入', (await runRound(hook)).length === 0);

  // ---- 6. hook：工具面变了注入一条（通道 = vessel:notice 尾消息，不写 system）----
  current = ['read', 'ask'];
  const injected = await runRound(hook);
  check('变更后注入一条', injected.length === 1, String(injected.length));
  check('通道是 user 消息', injected[0]?.role === 'user', injected[0]?.role);
  check('通道是 vessel:notice', injected[0]?.name === 'vessel:notice', injected[0]?.name);
  check('正文是环境信息形状', injected[0]?.content.startsWith('tools: ') === true);
  check('不写 system', !('systemPrompt' in (injected[0] ?? {})));

  // ---- 7. hook：同一变更不重复注入（同一 run 的后续 LLM 请求也一样）----
  check('同一变更不重复注入', (await runRound(hook)).length === 0);

  // ---- 8. hook：回滚（A→B→A）仍然要报 ----
  current = ['read'];
  const rolledBack = await runRound(hook);
  check('回滚再报一条', rolledBack.length === 1, String(rolledBack.length));
  check(
    '回滚报的是删除方向',
    detailLines(rolledBack[0]?.content ?? '')[0] === '- ask',
    detailLines(rolledBack[0]?.content ?? '')[0],
  );

  // ---- 9. hook：探针抛错不冒泡、也不注入 ----
  const boom = createToolSurfaceDeltaHook({
    baseline: ['read'],
    current: () => {
      throw new Error('probe boom');
    },
  });
  let threw = false;
  let boomRound: Message[] = [];
  try {
    boomRound = await runRound(boom);
  } catch {
    threw = true;
  }
  check('探针抛错不冒泡', !threw);
  check('探针抛错不注入', boomRound.length === 0, String(boomRound.length));

  // ---- 10. hook：每具 body 各自去重（换具 body 要重新报）----
  const bodyA = createToolSurfaceDeltaHook({ baseline: ['read'], current: () => ['read', 'ask'] });
  const bodyB = createToolSurfaceDeltaHook({ baseline: ['read'], current: () => ['read', 'ask'] });
  check('body A 报', (await runRound(bodyA)).length === 1);
  check('body B 独立报', (await runRound(bodyB)).length === 1);

  // ---- 11. Web 承接 + 词表对拍 ----
  const card = envNoticeCard(injected[0]?.content ?? '');
  check('Web 解析出卡片', card !== undefined);
  check('卡片 scope = tools', card?.scope === 'tools', card?.scope);
  check('卡片首行是摘要', card?.lines[0]?.text.startsWith('tools: ') === true);
  check('明细不被误认成别的 scope', card?.lines[1]?.scope === 'context', card?.lines[1]?.scope);
  const web = new Set<string>(ENV_NOTICE_SCOPES);
  for (const scope of ENV_INFO_SCOPES) {
    check(`Web 词表认得出 ${scope}`, web.has(scope));
  }

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK tool-surface-delta: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED tool-surface-delta: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
