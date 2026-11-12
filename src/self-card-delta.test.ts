/**
 * `self-card-delta` 的窄属性测试（0.52 #Bug2：Self Card 不热替换，改动走环境信息增量告知）。
 *
 * 为什么长成这样：仓库没有 test gate（见 AGENTS.md「验证纪律」），纯函数的窄属性测试是
 * 被允许的例外，形态照抄 `src/refs-notice-hook.test.ts`（`check()` + 计数 + 汇总），直接跑：
 *
 *   bun run src/self-card-delta.test.ts
 *
 * 判定看**输出文本**（`OK ... passed N / N` 或 `FAIL ...`）：本机 bun 是 Windows 版，
 * 退出码不可信。命名带 `.test.ts` 是为了 package.json 的 `files` 规则把它挡在发布包外，
 * 同时让 `bun run typecheck`（tsconfig 的 `src/` 范围）继续覆盖它。
 *
 * 断言的是**行为不变量**而不是整句文案：
 * - 注入通道：`role=user` + `name=vessel:notice`（与 runtime-notice / refs-notice 同一条），
 *   **不**写 system、不新造事件；
 * - 去重：同一变更只注入一次、字段没变不注入、没变更完全不注入、回滚（A→B→A）仍然报；
 * - 真话：model / system prompt 明确说「本具 body 用旧值、下一具才用新值」，且**不**把
 *   system prompt 正文（可能上千字）塞进上下文；
 * - Web 承接：`env-notice.ts` 能把这条消息解析成 scope `selfcard` 的卡片（能折叠、不是裸 JSON）。
 */

import { envNoticeCard, mergeEnvNoticeCards } from '../apps/web/src/domains/chat/env-notice';
import {
  createSelfCardDeltaHook,
  diffSelfCardIdentity,
  formatSelfCardDelta,
  SELF_CARD_DELTA_DETAIL_MARK,
  SELF_CARD_DELTA_MESSAGE_NAME,
  type SelfCardIdentity,
  selfCardIdentityOf,
} from '../packages/agent/src/self-card-delta';
import { type HookContext, HookType, type Message } from '../packages/core/src/index';
import { NOTICE_DETAIL_MARK } from './runtime-notice-hook';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/** 成员快照（只给 Self Card 相关的几个字段；其余字段与结论无关）。 */
function identity(patch: Partial<SelfCardIdentity> = {}): SelfCardIdentity {
  return { name: 'human-2', model: 'volcengine/deepseek-flash', ...patch };
}

/** 跑一轮 BeforeLlm，返回这一轮新增的消息（hook 每轮写进新的 ctx）。 */
async function runRound(
  hook: ReturnType<typeof createSelfCardDeltaHook>,
  sessionId = 's1',
): Promise<Message[]> {
  const ctx: HookContext = { run_id: 'r', session_id: sessionId };
  await hook.run(ctx);
  return ctx.messages ?? [];
}

/** 明细行（去掉线格式标记），用于断言「说了什么」。 */
function detailLines(content: string): string[] {
  return content
    .split('\n')
    .slice(1)
    .map((line) => line.replace(SELF_CARD_DELTA_DETAIL_MARK, ''));
}

async function main(): Promise<void> {
  // ---- 1. 文案形状：首行带 scope 词，明细一行一条，顺序稳定 ----
  const one = formatSelfCardDelta(
    diffSelfCardIdentity(identity(), identity({ name: 'Minelog-main' })),
  );
  const oneLines = one.split('\n');
  check('单字段一条明细', oneLines.length === 2, String(oneLines.length));
  check('首行 scope 词', oneLines[0]?.startsWith('selfcard: 1 field changed') === true, oneLines[0]);
  check('明细行带线格式标记', oneLines[1]?.startsWith(SELF_CARD_DELTA_DETAIL_MARK) === true);
  check(
    '改名行有旧值与新值',
    oneLines[1]?.includes('name: human-2 → Minelog-main') === true,
    oneLines[1],
  );
  check('改名说是立即生效', oneLines[1]?.includes('rename is already effective') === true);

  const two = formatSelfCardDelta(
    diffSelfCardIdentity(identity(), identity({ name: 'Minelog-main', model: 'other-model' })),
  );
  const twoLines = two.split('\n');
  check('两字段两条明细', twoLines.length === 3, String(twoLines.length));
  check('首行复数', twoLines[0]?.includes('2 fields changed') === true, twoLines[0]);
  // 顺序固定（name 在 model 之前），否则同一批变更会拼出两种字符串、去重就不可靠了
  check('顺序按 SELF_CARD_FIELDS', twoLines[1]?.includes('name: ') === true, twoLines[1]);
  check('model 在后', twoLines[2]?.includes('model: ') === true, twoLines[2]);
  check('model 说下一具 body 才生效', twoLines[2]?.includes('next body uses the new one') === true);

  // ---- 2. system prompt：只说「加了 / 换了 / 去了」，绝不贴正文 ----
  const longPrompt = 'S'.repeat(4000);
  const replaced = formatSelfCardDelta(
    diffSelfCardIdentity(
      identity({ system_prompt: 'old prompt' }),
      identity({ system_prompt: longPrompt }),
    ),
  );
  check('system prompt 换掉', replaced.includes('system prompt: replaced') === true, replaced);
  check('不贴 prompt 正文', !replaced.includes(longPrompt.slice(0, 80)), replaced.slice(0, 120));
  const added = formatSelfCardDelta(
    diffSelfCardIdentity(identity(), identity({ system_prompt: 'x' })),
  );
  check('system prompt 新加', added.includes('system prompt: added') === true, added);
  const removed = formatSelfCardDelta(
    diffSelfCardIdentity(identity({ system_prompt: 'x' }), identity()),
  );
  check('system prompt 去掉', removed.includes('system prompt: removed') === true, removed);

  // ---- 3. 权限档也是一行（Team 成员被强制 bridge 就是这种变化）----
  const modeChange = formatSelfCardDelta(
    diffSelfCardIdentity(
      identity({ permission_mode: 'allow' }),
      identity({ permission_mode: 'bridge' }),
    ),
  );
  check('权限档出现', modeChange.includes('permission mode: allow → bridge') === true, modeChange);
  check('权限档说明生效点', modeChange.includes('next body applies the new mode') === true);

  // ---- 4. 归一化：空串 / 空白不算变更（否则每次 update 都会凭空报一条）----
  // 走生产入口 `selfCardIdentityOf`（归一化就在那里），而不是手搓快照。
  const baseMember = { name: 'human-2', model: 'volcengine/deepseek-flash' };
  const baseNorm = selfCardIdentityOf(baseMember, 'allow');
  const emptyTeam = diffSelfCardIdentity(
    baseNorm,
    selfCardIdentityOf({ ...baseMember, team_id: '   ' }, 'allow'),
  );
  check('空白 team 不算变更', emptyTeam.length === 0, String(emptyTeam.length));
  const sameName = diffSelfCardIdentity(
    baseNorm,
    selfCardIdentityOf({ ...baseMember, name: '  human-2  ' }, 'allow'),
  );
  check('首尾空白不算改名', sameName.length === 0, String(sameName.length));
  // name 去掉 ≠ 没变：Self Card 的 role 行会退化成 `member`
  const droppedName = diffSelfCardIdentity(
    baseNorm,
    selfCardIdentityOf({ model: baseMember.model }, 'allow'),
  );
  check('字段被清空算变更', droppedName.length === 1, String(droppedName.length));

  // ---- 5. 长值裁断（防脏数据把卡片撑爆）----
  const longName = formatSelfCardDelta(
    diffSelfCardIdentity(identity(), identity({ name: 'n'.repeat(200) })),
  );
  check('长值裁断', longName.includes('…') === true, longName.slice(0, 160));

  // ---- 6. 明细标记必须与 Web 解析的那份逐字相同 ----
  check(
    'details 线格式与 runtime-notice 同源',
    SELF_CARD_DELTA_DETAIL_MARK === NOTICE_DETAIL_MARK,
    JSON.stringify(SELF_CARD_DELTA_DETAIL_MARK),
  );

  // ---- 7. hook：没变更完全不注入 ----
  let current = identity();
  const hook = createSelfCardDeltaHook({ baseline: identity(), current: () => current });
  // 模块内为了让测试在「没装依赖」的 checkout 里也能跑，`type` 用的是字面量 + 类型断言
  // （见 self-card-delta.ts 的 BEFORE_LLM 注释）。这里用 core 的真枚举对拍一次值。
  check('hook 阶段 = HookType.BeforeLlm', hook.type === HookType.BeforeLlm, String(hook.type));
  const quiet = await runRound(hook);
  check('没变更不注入', quiet.length === 0, String(quiet.length));

  // ---- 8. hook：改名后注入一条（通道 = vessel:notice 尾消息）----
  current = identity({ name: 'Minelog-main' });
  const renamed = await runRound(hook);
  check('改名后注入一条', renamed.length === 1, String(renamed.length));
  check('通道是 vessel:notice', renamed[0]?.name === SELF_CARD_DELTA_MESSAGE_NAME, renamed[0]?.name);
  check('通道是 user 消息', renamed[0]?.role === 'user', renamed[0]?.role);
  check('注入的是环境信息卡形状', renamed[0]?.content.startsWith('selfcard: ') === true);
  check('不写 system', !('systemPrompt' in (renamed[0] ?? {})));

  // ---- 9. hook：同一变更不重复注入（同一 run 的后续 LLM 请求也一样）----
  const again = await runRound(hook);
  check('同一变更不重复注入', again.length === 0, String(again.length));

  // ---- 10. hook：字段没变（值相同）不注入 ----
  const hook2 = createSelfCardDeltaHook({
    baseline: identity(),
    current: () => identity({ name: 'human-2', model: 'volcengine/deepseek-flash' }),
  });
  const unchanged = await runRound(hook2);
  check('字段未变不注入', unchanged.length === 0, String(unchanged.length));

  // ---- 11. hook：回滚（A→B→A）仍然要报（只按 spawn 快照去重会静默吞掉）----
  current = identity({ name: 'human-2' });
  const rolledBack = await runRound(hook);
  check('回滚再报一条', rolledBack.length === 1, String(rolledBack.length));
  check(
    '回滚报的是新方向',
    rolledBack[0]?.content.includes('name: Minelog-main → human-2') === true,
    rolledBack[0]?.content.split('\n')[1],
  );

  // ---- 12. hook：多字段一次性变更合并成一条消息（不是 N 条）----
  let multi = identity();
  const hook3 = createSelfCardDeltaHook({ baseline: identity(), current: () => multi });
  multi = identity({ name: 'Minelog-main', team_id: 'minelog', model: 'm2' });
  const merged = await runRound(hook3);
  check('多字段只注入一条', merged.length === 1, String(merged.length));
  check(
    '多字段明细齐全',
    detailLines(merged[0]?.content ?? '').length === 3,
    String(detailLines(merged[0]?.content ?? '').length),
  );

  // ---- 13. hook：每具 body 各自去重（同一次变更换具 body 要重新报）----
  const bodyA = createSelfCardDeltaHook({ baseline: identity(), current: () => multi });
  const bodyB = createSelfCardDeltaHook({ baseline: identity(), current: () => multi });
  check('body A 报', (await runRound(bodyA)).length === 1);
  check('body B 独立报', (await runRound(bodyB)).length === 1);

  // ---- 14. hook：探针抛错不冒泡、也不注入（一条提示不许拖垮一轮请求）----
  const boom = createSelfCardDeltaHook({
    baseline: identity(),
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

  // ---- 15. selfCardIdentityOf：快照只收 Self Card 相关的行 ----
  const snapshot = selfCardIdentityOf(
    { name: 'human-2', model: 'm', team_id: '', system_prompt: ' ' },
    'bridge',
  );
  check('unbound 不伪造 team', snapshot.team_id === undefined, String(snapshot.team_id));
  check('空白 prompt 视为没设置', snapshot.system_prompt === undefined);
  check('权限档进快照', snapshot.permission_mode === 'bridge', snapshot.permission_mode);

  // ---- 16. Web 承接：同一段文本必须解析成一张能折叠的环境信息卡 ----
  const card = envNoticeCard(merged[0]?.content ?? '');
  check('Web 解析出卡片', card !== undefined);
  check('卡片 scope = selfcard', card?.scope === 'selfcard', card?.scope);
  check('卡片首行是摘要', card?.lines[0]?.text.startsWith('selfcard: ') === true, card?.lines[0]?.text);
  check('卡片明细逐行', card?.lines.length === 4, String(card?.lines.length));
  check('明细不再带 · 标记', card?.lines[1]?.text.startsWith('·') !== true, card?.lines[1]?.text);
  check('明细不被误认成别的 scope', card?.lines[1]?.scope === 'context', card?.lines[1]?.scope);
  check('卡片全部生效', card?.ok === true);
  const folded = card === undefined ? undefined : mergeEnvNoticeCards(card, card);
  check('同 scope 折叠成一张（2 条）', folded?.count === 2, String(folded?.count));
  check('折叠后仍是 selfcard', folded?.scope === 'selfcard', folded?.scope);

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK self-card-delta: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED self-card-delta: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();

