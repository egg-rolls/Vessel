#!/usr/bin/env bun

/**
 * ask 草稿 / 已答记录门禁（0.51）。
 *
 * 这一单的两条用户体感都很脆：草稿只是「人还没提交的一口气」，已答记录只是一条服务端
 * 落盘记录，任何一层被顺手改掉都**不会报错**，只会静默回到「切页就没了」「答完没有卡」。
 * 所以这里把四条判据钉成 fixture（每个 fixture 都写清「为什么这条不能退」）：
 *
 * - A 草稿能跨「切页 / 刷新」活下来：内存 → 落盘载荷 → 重新解析，读回同一份选择与自定义答复；
 * - B 清理：请求从 pending 集合里消失（别处已答 / run 终态）时草稿必须被删；而
 *   「第一帧还没有基线」时一条都不许删（刷新后 hydration 完成前 pending 是空的，
 *   那条判据会把刚恢复的草稿剃掉）；
 * - C 不串台：两条请求的同一题号是两个槽，互不覆盖；键能反解出 requestId（requestId 里
 *   允许带分隔符，反解按最后一个分隔符切）；
 * - D 已答记录能重建出一张可读的答复卡（原问题 + 答案），且不再重复画 async 那张卡；
 * - E 静态接线：组件真的接上了 store / 插槽 / answered 查询，i18n 两侧都有文案
 *   （这两层是「改了代码但没接上」的典型漏点，fixture 测不到）。
 *
 * 用法：bun run scripts/check-ask-drafts.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  answeredAsk,
  answeredAsks,
  ANSWERED_ASKS_VISIBLE,
  recentAnsweredAsks,
} from '../apps/web/src/domains/chat/ask-answered';
import {
  askDraftKey,
  askDraftOf,
  askDraftRequestIds,
  askDraftsPrunable,
  ASK_DRAFT_STORAGE_VERSION,
  type AskDrafts,
  collectAskSlots,
  dropAskDrafts,
  EMPTY_ASK_DRAFTS,
  isAskDraftEmpty,
  parseAskDraftKey,
  parseAskDrafts,
  pruneAskDrafts,
  setAskDraft,
  vanishedAskRequests,
} from '../apps/web/src/domains/pending/ask-drafts';
import type { ListedInteraction } from '../apps/web/src/gateway/interaction-hydration';

const REPO = join(import.meta.dir, '..');

const failures: string[] = [];
let checked = 0;

/** 一个 fixture：name 说断言什么，why 说为什么它不能退。 */
interface Fixture {
  name: string;
  why: string;
  check: () => boolean;
}

function run(fixture: Fixture): void {
  checked += 1;
  let ok = false;
  try {
    ok = fixture.check();
  } catch (error) {
    failures.push(`${fixture.name} 抛出 ${String(error)}`);
    return;
  }
  if (!ok) failures.push(`${fixture.name} 不成立 —— ${fixture.why}`);
}

const cache = new Map<string, string>();

/** 读源码（带缓存）；读不到就是 FAIL —— 门禁不能因为文件消失而静默放行。 */
async function source(path: string): Promise<string> {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  try {
    const text = await readFile(join(REPO, path), 'utf8');
    cache.set(path, text);
    return text;
  } catch {
    failures.push(`${path} 读不到这个文件（改名 / 删除？门禁需要它存在）`);
    cache.set(path, '');
    return '';
  }
}

const NOW = 1_700_000_000_000;

/** 落盘再解析一次：模拟「刷新」（内存清空，只剩 sessionStorage 那份 JSON）。 */
function roundTrip(drafts: AskDrafts, savedAt: Record<string, number> = {}): AskDrafts {
  const slots = collectAskSlots(drafts, savedAt, NOW);
  const raw = JSON.stringify({ v: ASK_DRAFT_STORAGE_VERSION, slots });
  return parseAskDrafts(raw, NOW) ?? {};
}

/** 一条 sync 已答记录（服务端 interactions-*.json 里的形状）。 */
function answeredRecord(overrides: Partial<ListedInteraction> = {}): ListedInteraction {
  return {
    kind: 'ask',
    request_id: 'req-1',
    run_id: 'run-1',
    session_id: 'session-1',
    questions: [
      { header: '部署目标', question: '这次要部署到哪个环境？', options: ['staging', 'prod'] },
    ],
    created_at: NOW - 5000,
    status: 'answered',
    answer: {
      decision: 'allow',
      scope: 'once',
      answers: [{ header: '部署目标', question: '这次要部署到哪个环境？', answer: 'prod' }],
      answered_at: NOW,
    },
    ...overrides,
  };
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'A1 勾选 + 自定义答复跨刷新仍在',
    why: '用户实测「切页 / 刷新后，正在勾选但还没提交的选项没了」——草稿必须能跨一次刷新复原',
    check: () => {
      const key = askDraftKey('req-1', 0);
      const written = setAskDraft(EMPTY_ASK_DRAFTS, key, {
        selected: ['staging'],
        custom: '先在灰度里跑十分钟',
        include: true,
      });
      const restored = roundTrip(written);
      const draft = askDraftOf(restored, 'req-1', 0);
      return (
        draft.selected.join('|') === 'staging' &&
        draft.custom === '先在灰度里跑十分钟' &&
        draft.include === true
      );
    },
  },
  {
    name: 'A2 空草稿不落盘（勾上又取消不留垃圾）',
    why: '空槽既不该进内存也不该进载荷，否则长期使用会攒出一堆无用槽',
    check: () => {
      const key = askDraftKey('req-1', 0);
      const selected = setAskDraft(EMPTY_ASK_DRAFTS, key, {
        selected: ['staging'],
        custom: '',
        include: false,
      });
      const cleared = setAskDraft(selected, key, { selected: [], custom: '', include: false });
      return (
        Object.keys(cleared).length === 0 &&
        Object.keys(roundTrip(selected)).length === 1 &&
        isAskDraftEmpty({ selected: [], custom: '', include: false })
      );
    },
  },
  {
    name: 'A3 判据自检：写错键就读不到草稿',
    why: '如果「随便查都能查到」，「跨刷新仍在」就是假绿；先证明错位寻址真的读不到',
    check: () => {
      const drafts = setAskDraft(EMPTY_ASK_DRAFTS, askDraftKey('req-1', 0), {
        selected: ['staging'],
        custom: '答复 A',
        include: false,
      });
      return (
        askDraftOf(drafts, 'req-2', 0).custom === '' &&
        askDraftOf(drafts, 'req-1', 1).custom === '' &&
        askDraftOf(drafts, 'req-1', 0).custom === '答复 A'
      );
    },
  },
  {
    name: 'B1 请求消失 ⇒ 它的草稿被清掉',
    why: '请求在别处被答 / run 终态 / 服务端 not_found 后，草稿不能跟着标签页活到关掉',
    check: () => {
      const key = askDraftKey('req-1', 0);
      const drafts = setAskDraft(EMPTY_ASK_DRAFTS, key, {
        selected: ['prod'],
        custom: '',
        include: true,
      });
      const vanished = vanishedAskRequests(['req-1'], []);
      if (vanished.join(',') !== 'req-1') return false;
      const after = dropAskDrafts(drafts, vanished);
      return Object.keys(after).length === 0 && askDraftRequestIds(after).length === 0;
    },
  },
  {
    name: 'B2 首帧没有基线时一条草稿都不删',
    why: '刷新 / 重连后 pending 集合在 hydration 完成前是空的，按「不在集合里就删」会剃掉刚恢复的草稿',
    check: () => {
      const empty = vanishedAskRequests([], []);
      const added = vanishedAskRequests([], ['req-9']);
      return empty.length === 0 && added.length === 0;
    },
  },
  {
    name: 'B3 仍在 pending 的草稿不被 prune 误删',
    why: 'prune 只清「已知可信的 pending 全集」之外的槽；活着的那条必须留下',
    check: () => {
      const alive = setAskDraft(EMPTY_ASK_DRAFTS, askDraftKey('req-live', 0), {
        selected: ['staging'],
        custom: '',
        include: false,
      });
      const both = setAskDraft(alive, askDraftKey('req-dead', 1), {
        selected: [],
        custom: '写了一半',
        include: false,
      });
      const pruned = pruneAskDrafts(both, ['req-live']);
      return (
        askDraftOf(pruned, 'req-live', 0).selected.join('|') === 'staging' &&
        askDraftRequestIds(pruned).join(',') === 'req-live'
      );
    },
  },
  {
    name: 'B4 空集合 / 无基线时不许当作「请求都答完了」',
    why: '断线、换 token、节点切换会把 interactionStore reset 成空；重连后 hydration 回来前集合也是空的。这两种「空」若当成「请求消失」，重连就把人写了一半的答复删掉',
    check: () => {
      const reset = askDraftsPrunable(['req-1'], []);
      const firstFrame = askDraftsPrunable(null, ['req-1']);
      const partial = askDraftsPrunable(['req-1', 'req-2'], ['req-1']);
      const dropped = askDraftsPrunable([], ['req-1']);
      return reset === false && firstFrame === false && partial === true && dropped === true;
    },
  },
  {
    name: 'C1 两条请求的同一题号不串台',
    why: '同时可能压着多条 ask；只按题号匹配（不带 requestId）会让两条请求互相覆盖',
    check: () => {
      const one = setAskDraft(EMPTY_ASK_DRAFTS, askDraftKey('req-1', 0), {
        selected: ['prod'],
        custom: '',
        include: false,
      });
      const two = setAskDraft(one, askDraftKey('req-2', 0), {
        selected: ['staging'],
        custom: '再等一会',
        include: true,
      });
      const restored = roundTrip(two);
      const first = askDraftOf(restored, 'req-1', 0);
      const second = askDraftOf(restored, 'req-2', 0);
      return (
        first.selected.join('|') === 'prod' &&
        first.custom === '' &&
        second.selected.join('|') === 'staging' &&
        second.custom === '再等一会' &&
        second.include === true
      );
    },
  },
  {
    name: 'C2 键能反解（requestId 里带分隔符也不错位）',
    why: '反解要靠它做清理；按第一个分隔符切会把带 # 的 requestId 切成两半，清错别人的草稿',
    check: () => {
      const parsed = parseAskDraftKey(askDraftKey('req#1:dev', 3));
      return (
        parsed !== undefined &&
        parsed.requestId === 'req#1:dev' &&
        parsed.index === 3 &&
        parseAskDraftKey('garbage') === undefined &&
        parseAskDraftKey('req-1#x') === undefined
      );
    },
  },
  {
    name: 'D1 sync 已答记录能重建出「问了什么 + 答了什么」',
    why: 'sync（工具默认模式）答完不产生任何答复卡；服务端 answered 记录是刷新后唯一的身份来源',
    check: () => {
      const record = answeredAsk(answeredRecord());
      if (record === undefined) return false;
      const row = record.card.rows[0];
      return (
        record.requestId === 'req-1' &&
        record.answeredAt === NOW &&
        row !== undefined &&
        row.question === '这次要部署到哪个环境？' &&
        row.text === 'prod' &&
        record.card.summary.length > 0
      );
    },
  },
  {
    name: 'D2 async 已答记录不重复画卡',
    why: 'async 的答案已经是时间线上那条 ask:answer 消息卡（同一份数据），再画一张就是两张一样的卡',
    check: () => {
      const deferred = answeredRecord({ mode: 'async' });
      const blocking = answeredRecord({ mode: 'sync' });
      return answeredAsk(deferred) === undefined && answeredAsk(blocking) !== undefined;
    },
  },
  {
    name: 'D3 没答 / 没内容的记录不成卡',
    why: '人点取消（answers=[]）或被 policy 收口时没有「答了什么」，画出来只会是一张空卡',
    check: () => {
      const cancelled = answeredRecord({
        answer: { decision: 'allow', scope: 'once', answers: [], answered_at: NOW },
      });
      const stillPending = answeredRecord({ status: 'pending', answer: undefined });
      const permission = answeredRecord({ kind: 'permission' });
      return (
        answeredAsk(cancelled) === undefined &&
        answeredAsk(stillPending) === undefined &&
        answeredAsk(permission) === undefined
      );
    },
  },
  {
    name: 'D4 同一份落盘记录重建结果稳定（刷新不闪、不漏）',
    why: '刷新后读的是同一份 JSON；映射必须是确定性的（含排序与去重），否则每次刷新卡的顺序都可能变',
    check: () => {
      const items = [
        answeredRecord({
          request_id: 'req-b',
          created_at: NOW - 1000,
          answer: {
            decision: 'allow',
      scope: 'once',
            answers: [{ header: 'B', question: 'B?', answer: 'b' }],
            answered_at: NOW - 500,
          },
        }),
        answeredRecord({
          request_id: 'req-a',
          created_at: NOW - 3000,
          answer: {
            decision: 'allow',
      scope: 'once',
            answers: [{ header: 'A', question: 'A?', answer: 'a' }],
            answered_at: NOW - 9000,
          },
        }),
        answeredRecord({
          request_id: 'req-a',
          created_at: NOW - 3000,
          answer: {
            decision: 'allow',
      scope: 'once',
            answers: [{ header: 'A', question: 'A?', answer: 'a' }],
            answered_at: NOW - 9000,
          },
        }),
      ];
      const once = answeredAsks(items);
      const again = answeredAsks(items);
      const ids = once.map((item) => item.requestId).join(',');
      return (
        once.length === 2 &&
        ids === 'req-a,req-b' &&
        ids === again.map((item) => item.requestId).join(',')
      );
    },
  },
  {
    name: 'D6 别的会话的已答记录不串到本会话',
    why: '旧 gateway 可能忽略未识别的 session_id 过滤而返回全部已答记录；显示层必须自己再断一次，否则别人的问答会挂在当前会话里',
    check: () => {
      const mine = answeredRecord({ request_id: 'req-mine' });
      const other = answeredRecord({
        request_id: 'req-other',
        session_id: 'session-2',
        answer: {
          decision: 'allow',
      scope: 'once',
          answers: [{ header: '别人的题', question: '别人的问题？', answer: '别人的答案' }],
          answered_at: NOW + 1,
        },
      });
      const noSession = answeredRecord({ request_id: 'req-nobody', session_id: undefined });
      const cards = answeredAsks([mine, other, noSession], 'session-1');
      return cards.length === 1 && cards[0]?.requestId === 'req-mine';
    },
  },
  {
    name: 'D5 只画最近几条（长会话不被占满）',
    why: '会话底部不是回答历史页面；默认只给最近 ANSWERED_ASKS_VISIBLE 条，更早的收在展开里',
    check: () => {
      const items = Array.from({ length: ANSWERED_ASKS_VISIBLE + 2 }, (_, index) =>
        answeredRecord({
          request_id: `req-${String(index)}`,
          answer: {
            decision: 'allow',
      scope: 'once',
            answers: [{ header: `H${String(index)}`, question: `Q${String(index)}`, answer: 'a' }],
            answered_at: NOW + index,
          },
        }),
      );
      const cards = answeredAsks(items);
      const folded = recentAnsweredAsks(cards);
      const lastId = `req-${String(ANSWERED_ASKS_VISIBLE + 1)}`;
      const last = folded.shown[folded.shown.length - 1];
      return (
        cards.length === ANSWERED_ASKS_VISIBLE + 2 &&
        folded.shown.length === ANSWERED_ASKS_VISIBLE &&
        folded.hidden === 2 &&
        last?.requestId === lastId
      );
    },
  },
];

for (const fixture of FIXTURES) run(fixture);

// ---------------------------------------------------------------- E 静态接线

/** 探针只能看到纯函数，接线漏了（改了代码没接上界面）只有静态判据能抓。 */
const WIRING: readonly { path: string; must: readonly string[] }[] = [
  {
    // 会话槽的 ask 草稿必须来自 store，不能再回退成组件 state。
    path: 'apps/web/src/domains/chat/PromptSlots.tsx',
    must: ['useAskDrafts()', 'useSetAskDraft()', 'askDraftOf(drafts, request.requestId'],
  },
  {
    path: 'apps/web/src/domains/pending/PendingClusterCard.tsx',
    must: ['useAskDrafts()', 'useDropAskDrafts()', 'dropDrafts(requestIds)'],
  },
  {
    // 草稿的持久面必须是 sessionStorage（localStorage 是长期副本，草稿不该进永久层）。
    path: 'apps/web/src/domains/pending/ask-draft-store.ts',
    must: ['sessionStorage', 'vessel.askDraft', 'PERSIST_DEBOUNCE_MS', 'useAskDraftPrune'],
  },
  {
    // 「请求消失 ⇒ 草稿清理」必须真的被会话页 / 待批页接上。
    path: 'apps/web/src/domains/chat/ChatView.tsx',
    must: ['useAskDraftPrune(pendingAskIds, connected)', 'AnsweredAsks'],
  },
  {
    path: 'apps/web/src/domains/pending/PendingView.tsx',
    must: ['useAskDraftPrune(askIds, connected)'],
  },
  {
    // 已答卡的数据来源只能是服务端 answered 记录（落盘真相），不是前端内存；
    // 会话归属还要在客户端再过一遍（旧 gateway 可能忽略 session_id 过滤）。
    path: 'apps/web/src/domains/chat/AnsweredAsks.tsx',
    must: ["status: 'answered'", 'session_id: sessionId', 'answeredAsks(items, sessionId)'],
  },
  {
    path: 'apps/web/src/domains/chat/AskCard.tsx',
    must: ['useAskDrafts()', 'askDraftOf(drafts'],
  },
  {
    // 时间线之后的插槽：已答卡要在滚动区里（不是常驻块）。
    path: 'apps/web/src/domains/chat/TranscriptWindow.tsx',
    must: ['afterItems'],
  },
];

for (const wiring of WIRING) {
  const text = await source(wiring.path);
  checked += 1;
  for (const needle of wiring.must) {
    if (!text.includes(needle)) {
      failures.push(`${wiring.path} 里找不到 ${needle} —— 接线被删 / 改名了`);
    }
  }
}

// i18n 两侧都要有：缺 key 时 t() 静默回退成裸键，界面直接露出 chat.askAnswered.xxx。
const I18N_KEYS = [
  'chat.askAnswered.title',
  'chat.askAnswered.aria',
  'chat.askAnswered.source',
  'chat.askAnswered.label',
  'chat.askAnswered.more',
  'chat.askAnswered.less',
];

for (const file of ['apps/web/src/i18n/messages/zh-CN.ts', 'apps/web/src/i18n/messages/en.ts']) {
  const text = await source(file);
  checked += 1;
  for (const key of I18N_KEYS) {
    if (!text.includes(`'${key}'`)) {
      failures.push(`${file} 缺 i18n key ${key}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`check-ask-drafts: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-ask-drafts: OK（${String(checked)} 项：草稿持久化 / 清理 / 不串台 / 已答卡 + 接线 + i18n）`,
);
