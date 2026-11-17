/**
 * 排队消息生命周期驱动（验收用，不是 gate、不进 CI）。
 *
 * 用户口径（0.56）：**一条消息同一时刻只能出现在一个地方**。
 *
 * | 状态 | 会话流 | 待处理条带 |
 * |---|---|---|
 * | `draft` | 输入框 | — |
 * | `sending` | 灰气泡 | — |
 * | `queued` | — | 那一行 |
 * | `sent` | 正常用户气泡（服务端回显） | 必须消失 |
 * | `failed` | — | 那一行 + 「重试 / 编辑」 |
 *
 * 这个脚本**不用自己的规则**：`after` 那一列来自生产模块
 * `apps/web/src/domains/chat/pending-placement.ts`（`TranscriptWindow` / `PendingStrip` /
 * 本次断言用的是同一份判据），`before` 那一列来自 `queued-lifecycle-legacy-rules.ts`
 * （改前两处渲染的真实规则）。两列吃的是**同一份状态快照**。
 *
 * 跑法：`bun apps/web/scripts/queued-lifecycle-driver.ts`
 *
 * @module scripts/queued-lifecycle-driver
 */

import {
  inConversationStream,
  inPendingStrip,
  onScreenCounts,
  type StripEntryLike,
  stateLabel,
} from '../src/domains/chat/pending-placement';
import {
  PENDING_ECHO_TIMEOUT_MS,
  PENDING_QUEUE_TIMEOUT_MS,
  PendingSendStore,
} from '../src/domains/chat/pending-sends';
import { legacyCounts } from './queued-lifecycle-legacy-rules';

const SESSION = 'sess-1';
const TEXT_ONE = '我这个消息测试一下inbox';
const TEXT_QUEUED = '排队里的第二条';
const TEXT_TIMEOUT = '排了三分钟还在等的那条';

let clock = 1_000_000;
const tick = (ms: number): void => {
  clock += ms;
};

const store = new PendingSendStore({
  now: () => clock,
  idFactory: (() => {
    let seq = 0;
    return () => {
      seq += 1;
      return `pending-${String(seq)}`;
    };
  })(),
});

/**
 * 服务端 inbox 里当前压着的条目（`agents.inbox{session_id}` 的读数）。
 *
 * **这是条带的缓存读数**：它只在轮询 / 触发器到来时更新，所以「那条已经被取用」之后它还会
 * 留着最多 2 s —— 那段时间要靠 `pendingSends.sentMessageIds` 把它滤掉（见下面路径 1/2 的
 * `stale` 那一步）。驱动照着这个时间差建模，不假装自己立刻就知道。
 */
let serverEntries: StripEntryLike[] = [];
/** 已经回显成正常用户气泡的那些 `message_id`（会话里各一份）。 */
const echoed: string[] = [];

/** 记录每一次读数，最后统一断言「<= 1」。 */
const readings: { scenario: string; step: string; after: number; before: number }[] = [];
/** 输入框与条带同时出现同一句话的次数（必须 0）。 */
let composerViolations = 0;

function summaryOf(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
}

/** 服务端把这条消息收进 inbox（`admit` 里的 `trackInbox`：held + 归属会话）。 */
function serverHolds(messageId: string, text: string): void {
  serverEntries = [
    ...serverEntries,
    { message_id: messageId, from: 'human', summary: summaryOf(text), session_id: SESSION },
  ];
}

/**
 * 该条被 run 取用：`user.message` 回显进会话。
 *
 * **缓存读数不动**：真实条带要等下一次轮询（≤2 s）才会看到「那条已经不在了」，驱动照着
 * 这个时间差建模 —— 那段窗口里靠 `sentMessageIds` 把旧行滤掉，否则就是两条并排。
 */
function serverEchoes(messageId: string): void {
  echoed.push(messageId);
}

/** 下一次轮询刷新了条带的缓存读数：那条真的不在了。 */
function serverRewinds(messageId: string): void {
  serverEntries = serverEntries.filter((entry) => entry.message_id !== messageId);
}

function row(text: string): string {
  return `    ${text}`;
}

/**
 * 输入框里当前那段字（草稿）。
 *
 * 它也算一个「展示位置」：条带上有一条**同样正文**的待处理行时，输入框里就不该还留着
 * 同一段字（「编辑」把它放回来、条带那行同时消失，才是唯一合法的一来一回）。
 */
let composerText = '';

/** 打一拍：打印状态 + 两套规则的「屏上出现次数」。 */
function report(scenario: string, step: string): void {
  const pendings = store.list();
  const sentMessageIds = store.sentMessageIds();
  const after = onScreenCounts({ pendings, entries: serverEntries, echoed, sentMessageIds });
  const before = legacyCounts({ pendings, entries: serverEntries, echoed });
  const afterMax = after.reduce((max, cell) => Math.max(max, cell.total), 0);
  const beforeMax = before.reduce((max, cell) => Math.max(max, cell.total), 0);
  const stripTexts = pendings.filter(inPendingStrip).map((item) => summaryOf(item.text));
  const composerDup = composerText.trim() !== '' && stripTexts.includes(composerText.trim());
  readings.push({ scenario, step, after: afterMax, before: beforeMax });
  const states = pendings.map((item) => `${item.id}=${stateLabel(item.state)}`).join(' · ');
  console.log(row(`[${step}] 状态：${states.length > 0 ? states : '（无 pending）'}`));
  for (const cell of after) {
    console.log(
      row(
        `  改后 ${cell.key} → 会话 ${String(cell.conversation)} · 条带 ${String(cell.strip)} · 合计 ${String(cell.total)}`,
      ),
    );
  }
  for (const cell of before) {
    console.log(
      row(
        `  改前 ${cell.key} → 会话 ${String(cell.conversation)} · 条带 ${String(cell.strip)} · 合计 ${String(cell.total)}`,
      ),
    );
  }
  console.log(
    row(`  同一条消息最多出现：改前 ${String(beforeMax)} 处 · 改后 ${String(afterMax)} 处`),
  );
  if (composerDup) {
    console.log(row('  ✗ 输入框里那段字与条带上某一行相同 ⇒ 同一句话出现在两个地方'));
    composerViolations += 1;
  } else if (composerText.trim() !== '') {
    console.log(row(`  输入框草稿：${composerText}`));
  }
}

function scenario(title: string): void {
  console.log(`\n=== ${title}`);
}

// ─── 路径 1：无 run 时发消息 ⇒ draft → sent（会话一条，条带 0） ───────────────
scenario('路径 1：无 run 时发消息（sending → sent）');
const id1 = store.create({ sessionId: SESSION, text: TEXT_ONE });
report('路径1', 't0 点击发送：sending（会话灰气泡）');
tick(80);
store.attachRun(id1, 'run-1', 'running');
// 服务端 admit 已经把这条写进 inbox（held）—— 与灰色气泡同一条消息。
serverHolds('msg-1', TEXT_ONE);
report('路径1', 't80 runs.start 返回 running + 服务端 inbox 落条（认领生效，条带不重复）');
tick(120);
// 队列事件把服务端 message_id 带给客户端（`agent.message.queued`）。
store.noteQueued({ messageId: 'msg-1', sessionId: SESSION, from: 'human', delivery: 'input' });
report('路径1', 't200 收到 agent.message.queued（拿到 message_id）');
tick(200);
serverEchoes('msg-1');
store.noteEvent({ type: 'user.message', runId: 'run-1', sessionId: SESSION, text: TEXT_ONE });
report('路径1', 't400 被 run 取用：会话出现正常气泡（条带缓存还留着，sentMessageIds 立刻滤掉）');
tick(2_000);
serverRewinds('msg-1');
report('路径1', 't2400 条带下一次轮询：缓存读数也空了');

// ─── 路径 2：有 run 在跑时发消息 ⇒ queued（条带 1、会话 0） ───────────────────
scenario('路径 2：有 run 在跑时发消息（queued）');
const id2 = store.create({ sessionId: SESSION, text: TEXT_QUEUED });
report('路径2', 't0 点击发送：sending（会话灰气泡）');
tick(60);
store.attachRun(id2, 'run-2', 'queued');
serverHolds('msg-2', TEXT_QUEUED);
report('路径2', 't60 runs.start 返回 queued：会话气泡消失、条带接手（服务端那条被认领）');
tick(60);
store.noteQueued({ messageId: 'msg-2', sessionId: SESSION, from: 'human', delivery: 'input' });
report('路径2', 't120 拿到 message_id（顶替变成精确匹配）');
tick(30_000);
report('路径2', '前一轮跑完之前（排队 30s）');
serverEchoes('msg-2');
store.noteEvent({ type: 'user.message', runId: 'run-2', sessionId: SESSION, text: TEXT_QUEUED });
report('路径2', 'run 结束被取用：条带 0、会话 1（缓存读数仍是旧的那份）');
tick(2_000);
serverRewinds('msg-2');
report('路径2', '条带下一次轮询：0 条');

// ─── 路径 3：排队中断线 ⇒ 回条带 + 重试/编辑；编辑 ⇒ 输入框有内容、条带 0 ────
scenario('路径 3：排队中 RPC 断线（failed 回流条带）');
const id3 = store.create({ sessionId: SESSION, text: TEXT_ONE });
tick(50);
store.attachRun(id3, 'run-3', 'queued');
serverHolds('msg-3', TEXT_ONE);
store.noteQueued({ messageId: 'msg-3', sessionId: SESSION, from: 'human', delivery: 'input' });
report('路径3', 't0 排队中（条带 1）');
tick(200);
store.markFailed(id3, 'offline');
report('路径3', 't200 断线：failed（条带 1，带「重试 / 编辑」）');
// 「编辑」：先撤服务端那条（不然改完再发就是两份），再把内容放回输入框 + 删掉这一行。
const editTarget = store.find(id3);
if (editTarget?.messageId !== undefined)
  serverEntries = serverEntries.filter((entry) => entry.message_id !== editTarget.messageId);
store.remove(id3);
composerText = editTarget?.text ?? '';
report('路径3', `t400 点「编辑」：输入框有内容（${String(composerText.length)} 字）、条带 0`);

// ─── 路径 4：排队 3 分钟未取用 ⇒「未发送 · 排队超时」并可重试 ────────────────
scenario('路径 4：排队 3 分钟未被取用（排队超时）');
const id4 = store.create({ sessionId: SESSION, text: TEXT_TIMEOUT });
tick(50);
store.attachRun(id4, 'run-4', 'queued');
serverHolds('msg-4', TEXT_TIMEOUT);
store.noteQueued({ messageId: 'msg-4', sessionId: SESSION, from: 'human', delivery: 'input' });
report('路径4', 't0 排队中（条带 1）');
tick(PENDING_QUEUE_TIMEOUT_MS - 1_000);
const early = store.sweep();
report(
  '路径4',
  `t${String(Math.round((PENDING_QUEUE_TIMEOUT_MS - 1_000) / 1000))}s 还没到阈值（sweep 命中 ${String(early)} 条）`,
);
tick(2_000);
const swept = store.sweep();
const late = store.find(id4);
report(
  '路径4',
  `t${String(Math.round((PENDING_QUEUE_TIMEOUT_MS + 1_000) / 1000))}s sweep 命中 ${String(swept)} 条 ⇒ 文案「未发送 · 排队超时」（failure=${String(late?.failure)}）`,
);
// 「重试」：先撤服务端那条旧的（同一句话不能执行两次），再用同一个 pending id 重发。
serverEntries = serverEntries.filter((entry) => entry.message_id !== 'msg-4');
const reuse = store.find(id4);
if (reuse !== undefined) store.create({ sessionId: SESSION, text: reuse.text, reuseId: reuse.id });
report('路径4', '点「重试」：回到 sending（会话灰气泡），条带 0');

// ─── 断言 ───────────────────────────────────────────────────────────────
console.log('\n=== 断言：同一条消息在屏上出现次数 ≤ 1');
let violations = 0;
for (const reading of readings) {
  const ok = reading.after <= 1;
  if (!ok) violations += 1;
  console.log(
    row(
      `${ok ? 'PASS' : 'FAIL'} ${reading.scenario} · ${reading.step} → 改前 ${String(reading.before)} · 改后 ${String(reading.after)}`,
    ),
  );
}
console.log(
  row(
    `改前最大重复：${String(Math.max(...readings.map((item) => item.before)))} 处 · 改后最大重复：${String(Math.max(...readings.map((item) => item.after)))} 处`,
  ),
);
console.log(
  row(
    `超时口径：sending ${String(PENDING_ECHO_TIMEOUT_MS / 1000)}s · queued ${String(PENDING_QUEUE_TIMEOUT_MS / 1000)}s`,
  ),
);

// 顺带把「这条消息此刻在哪」的两种判据打印一遍，确认它们互补（不会同时为真）。
const overlap = store.list().filter((item) => inConversationStream(item) && inPendingStrip(item));
console.log(row(`会话流与条带同时渲染的 pending：${String(overlap.length)} 条（必须 0）`));
if (overlap.length > 0 || violations > 0 || composerViolations > 0) {
  console.log('\nRESULT: FAIL');
  process.exitCode = 1;
} else {
  console.log('\nRESULT: PASS');
}
