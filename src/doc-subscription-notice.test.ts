/**
 * 订阅变更通知并进环境信息词表（scope `files`）+ `ask` / `agent send` 口径的窄属性测试。
 *
 * 形态照抄 `src/self-card-delta.test.ts`（`check()` + 计数 + 汇总），直接跑：
 *
 *   bun run src/doc-subscription-notice.test.ts
 *
 * 为什么只断言 `notice.ts`（纯模块）而不真跑 hook：hook 引了 `@vessel-agent/basic-tools`，
 * 而本 worktree 不该 `bun install`，真跑 hook 会把测试变成「必须先装依赖」。线格式搬到了
 * 零依赖的 `notice.ts`，最该被验证的那一段因此任何时候都能验。同理，`packages/agent` 的
 * 两处 `agent` 工具描述只能**读源码**断言（import `tool.ts` 会拖进 service 与 core）。
 *
 * 断言的是**行为不变量**而不是整句文案：
 * - 通道：`vessel:notice`（不再自造 `vessel:subscription`）；老消息不做特判，走「未登记
 *   kind」的兜底仍然是一条可读卡（不是裸文本、不抛、不变成裸 JSON）；
 * - 形状：首行 `files: …`、明细行 `  · …`、总行数不超过 Web 卡的渲染上限（不靠渲染侧截断）；
 * - 标签：中英两侧都有 `chat.env.scope.files`；
 * - 口径：`ask` 只在「只有人能决定 / 完全卡住」时才用，能自己处理的与该让父级知晓的走
 *   `agent send`（父级通道是默认，问人是例外）。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ENV_NOTICE_DETAILS_MAX,
  ENV_NOTICE_SCOPES,
  envNoticeCard,
  isEnvNoticeKind,
} from '../apps/web/src/domains/chat/env-notice';
import { buildTranscriptItems } from '../apps/web/src/domains/chat/transcript-items';
import { messages as enMessages } from '../apps/web/src/i18n/messages/en';
import { messages as zhMessages } from '../apps/web/src/i18n/messages/zh-CN';
import { ENV_INFO_DETAIL_MARK, ENV_INFO_SCOPES } from '../packages/agent/src/env-info-scope';
import { createAskUserTool } from '../packages/tui/src/renderer/ask-user';
import {
  formatSubscriptionNotice,
  SUBSCRIPTION_NOTICE_DETAIL_MARK,
  SUBSCRIPTION_NOTICE_DETAILS_MAX,
  SUBSCRIPTION_NOTICE_MESSAGE_NAME,
  SUBSCRIPTION_NOTICE_SCOPE,
} from '../plugins/context/doc-subscription/src/notice';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

const REPO = join(import.meta.dir, '..');

async function contains(path: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(join(REPO, path), 'utf8')).includes(needle);
  } catch {
    return false;
  }
}

/** 一条文件变更行（与 hook 的 `noticeLine` 同形：只有元数据，没有正文）。 */
function fileLine(path: string): string {
  return `<file path="${path}" id="${path}" rev="sha256:0123456789ab" bytes="42" />`;
}

// ── 1. 线格式：files: 首行 + `  · ` 明细 ─────────────────────────

check('通道名是 vessel:notice', SUBSCRIPTION_NOTICE_MESSAGE_NAME === 'vessel:notice');
check('scope 词是 files', SUBSCRIPTION_NOTICE_SCOPE === 'files');
check(
  '明细标记与 ENV_INFO_DETAIL_MARK 逐字相同',
  SUBSCRIPTION_NOTICE_DETAIL_MARK === ENV_INFO_DETAIL_MARK,
  SUBSCRIPTION_NOTICE_DETAIL_MARK,
);
check(
  'files 在生产者词表里',
  (ENV_INFO_SCOPES as readonly string[]).includes('files'),
  ENV_INFO_SCOPES.join(','),
);
check(
  'files 在 Web 词表里',
  (ENV_NOTICE_SCOPES as readonly string[]).includes('files'),
  ENV_NOTICE_SCOPES.join(','),
);

const single = formatSubscriptionNotice([fileLine('docs/a.md')], 1);
const singleLines = single.split('\n');
check('首行是 files: 摘要', singleLines[0] === 'files: 1 subscribed files changed', singleLines[0]);
check(
  '明细行以明细标记开头',
  singleLines.slice(1).every((line) => line.startsWith(SUBSCRIPTION_NOTICE_DETAIL_MARK)),
  singleLines.slice(1).join(' | '),
);
check('单文件通知带上了那条元数据行', single.includes('path="docs/a.md"'));
check('通知不含文件正文（只有元数据）', single.includes('bytes="42"'));

const many = Array.from({ length: 20 }, (_, index) => fileLine(`docs/${String(index)}.md`));
const crowded = formatSubscriptionNotice(many, many.length);
check('超出上限时用 … and N more 概括', crowded.includes('… and 12 more'), crowded);
check(
  `通知总行数不超过 Web 卡上限（${String(ENV_NOTICE_DETAILS_MAX)}）`,
  crowded.split('\n').length <= ENV_NOTICE_DETAILS_MAX,
  String(crowded.split('\n').length),
);
check(
  '列出 8 个文件',
  crowded.split('\n').filter((line) => line.includes('<file ')).length ===
    SUBSCRIPTION_NOTICE_DETAILS_MAX,
);

// ── 2. Web 承接：解析成「文件变更」卡 ─────────────────────────────

const card = envNoticeCard(single);
check('Web 把通知解析成环境信息卡', card !== undefined);
check('卡头 scope 是 files', card?.scope === 'files', card?.scope);
check('卡正文保留原文（不剥 scope 前缀）', card?.lines[0]?.text === singleLines[0]);
check('明细没有被渲染侧截断', card?.droppedLines === undefined);
check(
  '通知行数没超过卡的渲染上限',
  (card?.lines.length ?? 0) <= ENV_NOTICE_DETAILS_MAX,
  String(card?.lines.length),
);
check('source / limit 不是环境信息', !isEnvNoticeKind('source') && !isEnvNoticeKind('limit'));
check('notice 是环境信息', isEnvNoticeKind('notice'));
check('老通道 subscription 不再被特判成环境信息', !isEnvNoticeKind('subscription'));

// ── 2b. 历史消息兜底：老 `vessel:subscription` 仍是一条可读卡（不是裸文本 / 不抛）──

const legacyBody = [
  '<subscription-notice>',
  'Subscribed files changed: 2',
  '<file path="docs/a.md" id="docs/a.md" rev="sha256:0123456789ab" bytes="42" />',
  '</subscription-notice>',
].join('\n');
/** 与 `state/runtime-visibility.ts#runtimeMessageKind` 同口径（那个模块要 React，这里现算）。 */
function noticeKindOf(message: { name?: string }): string | undefined {
  const name = message.name;
  if (typeof name !== 'string' || !name.startsWith('vessel:')) return undefined;
  const suffix = name.slice('vessel:'.length);
  return suffix.length > 0 ? suffix : 'other';
}
const legacyItems = buildTranscriptItems({
  messages: [
    { role: 'user', name: 'vessel:subscription', content: legacyBody, timestamp: 1 },
    { role: 'user', content: 'hello', timestamp: 2 },
  ],
  messageIndexOffset: 0,
  liveGroups: [],
  noticeKindOf,
});
const legacyItem = legacyItems[0];
check('历史消息仍是 notice 类 item（不进用户气泡）', legacyItem?.kind === 'runtime-notice');
// 旧通道名不再解析成环境卡（按未登记 kind 兜底）： 上没有 env 字段，
// 有 env 的会是环境卡 item —— 这里按结构断言「没有 env」。
check(
  '历史消息不解析成环境卡（按未登记 kind 兜底）',
  (legacyItem as { env?: unknown } | undefined)?.env === undefined,
);
check(
  '历史消息原文保留（不是裸 JSON）',
  legacyItem?.kind === 'runtime-notice' && legacyItem.text === legacyBody,
  legacyItem?.kind === 'runtime-notice' ? legacyItem.text : legacyItem?.kind,
);
check(
  '历史消息记录下当初的 kind（调试旧 trace 还能看懂）',
  legacyItem?.kind === 'runtime-notice' && legacyItem.noticeKind === 'subscription',
);
check('历史消息之后的普通消息没被影响', legacyItems[1]?.kind === 'message');

// ── 3. 标签：中英两侧都有 ────────────────────────────────────────

const enLabel = (enMessages as Record<string, string>)['chat.env.scope.files'];
const zhLabel = (zhMessages as Record<string, string>)['chat.env.scope.files'];
check('en 有卡头标签', typeof enLabel === 'string' && enLabel.length > 0, enLabel);
check('zh-CN 有卡头标签', zhLabel === '文件变更', zhLabel);

// ── 4. ask / send 口径（只改文案，不改机制）────────────────────────

const ask = createAskUserTool();
const askDescription = ask.description ?? '';
check('ask 描述把「最后手段」写成硬口径', /last resort/i.test(askDescription));
check('ask 描述点名 agent send 是默认通道', askDescription.includes('agent send'));
check(
  'ask 描述要求先自己决定（能判断的确认类问题）',
  /handle yourself/i.test(askDescription) && /decide it/i.test(askDescription),
);
check(
  'ask 描述保留「卡住才问」这一条',
  /completely stuck/i.test(askDescription) || /completely\s+stuck/i.test(askDescription),
);
check(
  '旧的「凡是要人说一句的都问人」口径已删掉',
  !askDescription.includes('Anything that needs a human to say one line belongs here'),
);
check(
  'ask 的工具名与 schema 没变',
  ask.name === 'ask' && Array.isArray((ask.inputSchema as { required?: string[] }).required),
);

check(
  '父侧 agent 工具把 send 写成默认上报通道',
  await contains('packages/agent/src/tool.ts', 'default channel for reporting to your parent'),
);
check(
  '成员侧 agent 工具同步同一句',
  await contains('packages/agent/src/runtime.ts', 'default channel for reporting to'),
);
check(
  '成员侧仍保留 send 的 interrupt / notify 说明',
  await contains('packages/agent/src/runtime.ts', 'notify:true to append to the target inbox'),
);

// ── 汇总 ────────────────────────────────────────────────────────

const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`OK doc-subscription-notice: passed ${String(passed)} / ${String(total)} checks`);
} else {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED doc-subscription-notice: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}
