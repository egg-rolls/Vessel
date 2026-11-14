/**
 * 「工具卡参数摘要」窄属性测试（tool-card-args）。
 *
 * 背景（用户原话）：`inbox` / `agent` 渲染成消息卡片时有概率没有后面的工具参数部分
 * —— bash 卡有命令摘要，这两张后面是空的。
 *
 * 根因在 `apps/web/src/domains/chat/tool-cards.ts` 的 `toolSummary()`：它只认**标量**
 * 参数名（byTool 表 + command/path/pattern/query/task/url/name + KNOWN_ARG_NAMES），
 * 而这两个工具的首个必填参数是 `action`，目标 / 条数是结构化字段（`to` / `members[]` /
 * `messages[]` / `ids[]` / `message_ids[]`）——一个都不在名单里，于是摘要返回空串，
 * 卡片头只剩工具名。
 *
 * 被测的是真实的 `toolSummary`（纯函数，无 IO）。断言的是行为，不是实现：
 * 1. agent：send 显示 action + 目标（地址只留 principal），create 显示人数 / 名字，
 *    无目标的动作只显示 action；`messages` 只报条数，正文绝不进摘要；
 * 2. inbox：action + 条数 / 首个 id / 正文首段（截断）；
 * 3. subscribe / ask 同样不再丢摘要；
 * 4. 入参缺失、空对象、action 缺失或非字符串时不抛异常、不输出垃圾摘要，
 *    也不回退到 `Object.values` 全盘扫（`preview` / `truncated` 不会被当摘要）；
 * 5. bash 取首行的既有行为不变，其它标量工具（read / grep）摘要不变；
 * 6. 摘要始终受 maxLength 约束。
 *
 * 判定看**输出文本**（`OK ... passed N / N` 或 `FAIL ...`）：本机 bun 是 Windows 版，
 * 退出码不可信。跑法：`bun run src/tool-card-args.test.ts`。
 */

import { toolSummary } from '../apps/web/src/domains/chat/tool-cards';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${JSON.stringify(got)}`);
}

/** 断言摘要 = 期望文本（失败时把真实摘要打出来）。 */
function expectSummary(label: string, actual: string, expected: string): void {
  check(label, actual === expected, actual);
}

/** 断言摘要非空，且不含不该出现的片段（正文 / 预览文本）。 */
function expectClean(label: string, actual: string, forbidden: string[]): void {
  check(`${label}（非空）`, actual.length > 0, actual);
  for (const piece of forbidden) {
    check(`${label} 不含 ${piece}`, !actual.includes(piece), actual);
  }
}

// ---- 1. agent：结构化入参 → action + 目标 / 人数 --------------------------------

// 真实地址形如 <principal>@<node_id>:<team_id>，摘要只要「发给谁」。
expectSummary(
  '① agent send → 目标（只留 principal）',
  toolSummary('agent', {
    action: 'send',
    to: 'main@7181ed6c-5ec2-479e-9400-fcd54b480de5:vessel',
    content: '请把 X 改成 Y',
    interrupt: true,
  }),
  'send → main',
);

expectSummary(
  '① agent send 多个 messages 只报条数',
  toolSummary('agent', {
    action: 'send',
    to: 'main@x:y',
    messages: [
      { to: 'a@x:y', content: 'SECRET-BODY-1' },
      { to: 'b@x:y', content: 'SECRET-BODY-2' },
    ],
  }),
  'send → main（2 条）',
);

expectClean(
  '① agent send 不带 messages 正文',
  toolSummary('agent', {
    action: 'send',
    to: 'main@x:y',
    messages: [{ to: 'a@x:y', content: 'SECRET-BODY-1' }],
  }),
  ['SECRET-BODY', 'content'],
);

expectSummary(
  '① agent create 用人数',
  toolSummary('agent', {
    action: 'create',
    members: [{ name: 'scout' }, { name: 'builder' }, { name: 'reviewer' }],
  }),
  'create → 3 名成员',
);

expectSummary(
  '① agent create 单人用名字',
  toolSummary('agent', { action: 'create', name: 'scout', visibility: 'team' }),
  'create → scout',
);

expectSummary(
  '① agent hire 单人用名字',
  toolSummary('agent', { action: 'hire', name: 'scout', members: [{ name: 'scout' }] }),
  'hire → scout',
);

expectSummary(
  '① agent list 无目标只显示 action',
  toolSummary('agent', { action: 'list', visibility: 'team' }),
  'list',
);

expectSummary(
  '① agent close 多名成员',
  toolSummary('agent', { action: 'close', members: ['m1', 'm2', 'm3'] }),
  'close → m1（共 3 名）',
);

expectSummary(
  '① agent read 用 to',
  toolSummary('agent', { action: 'read', to: 'main@x:y', limit: 5, includeHeld: true }),
  'read → main',
);

expectSummary(
  '① agent rotate 用 member',
  toolSummary('agent', { action: 'rotate', member: 'm-7', startup_prompt: 'x' }),
  'rotate → m-7',
);

// 旧实现的兜底只按 KNOWN_ARG_NAMES 找名字，绝不吃 serve 注入的 preview / truncated。
expectSummary(
  '① agent 不把 preview / truncated 当摘要',
  toolSummary('agent', { action: 'list', preview: 'PREVIEW-TEXT', truncated: true }),
  'list',
);

// ---- 2. inbox：action + 条数 / 首个 id / 正文首段 --------------------------------

expectSummary('② inbox read 无参数只显示 action', toolSummary('inbox', { action: 'read' }), 'read');
expectSummary(
  '② inbox read limit → 条数',
  toolSummary('inbox', { action: 'read', limit: 2 }),
  'read → 最多 2 条',
);
expectSummary(
  '② inbox claim 多条 → 条数',
  toolSummary('inbox', { action: 'claim', message_ids: ['msg_1', 'msg_2'] }),
  'claim → 2 条',
);
expectSummary(
  '② inbox claim 单条 → id',
  toolSummary('inbox', { action: 'claim', message_ids: ['msg_1'] }),
  'claim → msg_1',
);
expectSummary(
  '② inbox delete 多条 → 条数',
  toolSummary('inbox', { action: 'delete', ids: ['a', 'b', 'c'] }),
  'delete → 3 条',
);
expectSummary(
  '② inbox list 只显示 action',
  toolSummary('inbox', { action: 'list', includeHeld: true }),
  'list',
);

{
  const insert = toolSummary('inbox', {
    action: 'insert',
    content: `这是一条${'很长的正文'.repeat(30)}`,
  });
  check('② inbox insert 取正文首段', insert.startsWith('insert → 这是一条'), insert);
  // 'insert → ' 是 9 个字符，首段最多 40 字 + 一个省略号。
  check('② inbox insert 首段截断（不超过 40 字 + 省略号）', insert.length <= 50, insert);
}

{
  const single = toolSummary('inbox', { action: 'insert', content: '就一句话' });
  expectSummary('② inbox insert 短正文不截断', single, 'insert → 就一句话');
}

// ---- 3. 同样受影响的 subscribe / ask -------------------------------------------

expectSummary(
  '③ subscribe add 多文件 → 个数',
  toolSummary('subscribe', { action: 'add', paths: ['/a/x.ts', '/a/y.ts'] }),
  'add → 2 个文件（/a/x.ts 等）',
);
expectSummary(
  '③ subscribe add 单文件 → 路径',
  toolSummary('subscribe', { action: 'add', path: '/a/x.ts' }),
  'add → /a/x.ts',
);
expectSummary(
  '③ subscribe remove → id',
  toolSummary('subscribe', { action: 'remove', id: 'sub_1' }),
  'remove → sub_1',
);
expectSummary(
  '③ subscribe list 只显示 action',
  toolSummary('subscribe', { action: 'list' }),
  'list',
);

expectSummary(
  '③ ask 单问题 → header',
  toolSummary('ask', {
    mode: 'sync',
    questions: [{ header: '确认部署', question: '要部署到 prod 吗？' }],
  }),
  'ask → 确认部署',
);
expectSummary(
  '③ ask 多问题 → header + 总数',
  toolSummary('ask', {
    questions: [
      { header: 'A', question: 'qa' },
      { header: 'B', question: 'qb' },
    ],
  }),
  'ask → A（共 2 个问题）',
);
expectSummary(
  '③ ask 缺 header 时用正文首段',
  toolSummary('ask', { questions: [{ question: '要不要跑测试' }] }),
  'ask → 要不要跑测试',
);

// ---- 4. 入参缺失 / 空 / 畸形：不崩、不输出垃圾摘要 --------------------------------

expectSummary('④ agent 无入参 → 空串', toolSummary('agent', undefined), '');
expectSummary('④ inbox 无入参 → 空串', toolSummary('inbox', undefined), '');
expectSummary('④ agent null 入参 → 空串', toolSummary('agent', null), '');
expectSummary('④ agent 空对象 → 空串', toolSummary('agent', {}), '');
expectSummary('④ inbox 空对象 → 空串', toolSummary('inbox', {}), '');
expectSummary(
  '④ agent 缺 action 不猜目标',
  toolSummary('agent', { to: 'main@x:y', members: ['a'] }),
  '',
);
expectSummary('④ inbox 缺 action 不猜条数', toolSummary('inbox', { ids: ['a', 'b'] }), '');
expectSummary(
  '④ agent action 非字符串 → 不猜',
  toolSummary('agent', { action: 42, to: 'main@x:y' }),
  '',
);
expectSummary(
  '④ inbox action 空白串 → 不猜',
  toolSummary('inbox', { action: '   ', ids: ['a'] }),
  '',
);
expectSummary(
  '④ agent members 非数组不推算人数',
  toolSummary('agent', { action: 'create' }),
  'create',
);
expectSummary(
  '④ inbox ids 非数组不推算条数',
  toolSummary('inbox', { action: 'claim', ids: 'msg_1' }),
  'claim',
);

{
  // 非对象入参走的是 parseToolArgs 的既有 stringify 分支（对所有工具一致，本单不改），
  // 这里只钉「不抛异常 + 返回字符串 + 结构化规则没有凭空造 action 摘要」。
  const junk: Array<[string, unknown]> = [
    ['数组', [1, 2, 3]],
    ['数字', 42],
    ['布尔', true],
    ['空串', ''],
    ['坏 JSON 串', '{not json'],
  ];
  for (const [label, args] of junk) {
    for (const tool of ['agent', 'inbox']) {
      let text = '';
      let threw = '';
      try {
        text = toolSummary(tool, args);
      } catch (error) {
        threw = String(error);
      }
      check(`④ ${tool} ${label} 入参不抛异常`, threw === '', threw);
      check(`④ ${tool} ${label} 入参返回字符串`, typeof text === 'string', typeof text);
      check(`④ ${tool} ${label} 入参没有 action 箭头摘要`, !text.includes(' → '), text);
    }
  }
}

// ---- 5. 既有工具行为不变 -------------------------------------------------------

expectSummary('⑤ bash 仍取首行', toolSummary('bash', { command: 'ls -la\nsecond-line' }), 'ls -la');
expectSummary(
  '⑤ bash 缺 command 仍为空',
  toolSummary('bash', { preview: 'x', truncated: true }),
  '',
);
expectSummary('⑤ read 仍显示 path', toolSummary('read', { path: '/a/b.ts' }), '/a/b.ts');
expectSummary('⑤ grep 仍显示 pattern', toolSummary('grep', { pattern: 'foo(' }), 'foo(');
expectSummary('⑤ 无摘要的工具仍为空', toolSummary('mcp_call', { server: 'x', tool: 'y' }), '');

// ---- 6. maxLength 约束 --------------------------------------------------------

{
  const capped = toolSummary('agent', { action: 'create', name: 'x'.repeat(500) }, 20);
  check('⑥ maxLength 生效（agent）', capped.length <= 21, capped);
  const cappedInbox = toolSummary('inbox', { action: 'insert', content: 'y'.repeat(500) }, 20);
  check('⑥ maxLength 生效（inbox）', cappedInbox.length <= 21, cappedInbox);
  const defaultCap = toolSummary('agent', { action: 'create', name: 'x'.repeat(500) });
  check('⑥ 默认 maxLength 96', defaultCap.length <= 97, defaultCap);
}

const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`OK tool-card-args: passed ${String(passed)} / ${String(total)} checks`);
} else {
  console.log(`FAILED tool-card-args: passed ${String(passed)} / ${String(total)} checks`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
}
