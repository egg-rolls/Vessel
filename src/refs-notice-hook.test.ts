/**
 * `refs-notice-hook` 的窄属性测试（0.51 #7：尾注 action 列表从宿主真实工具面收窄）。
 *
 * 为什么要单独一个文件、又为什么长成这样：仓库没有 test gate（见 AGENTS.md「验证纪律」），
 * 纯函数的窄属性测试是被允许的例外。文件形态沿用 `plugins/.../test/probe.ts` 的探针写法
 * （`check()` + 计数 + 汇总），直接跑：
 *
 *   bun run src/refs-notice-hook.test.ts
 *
 * 判定看**输出文本**（`OK ... passed N / N` 或 `FAIL ...`）：本机 bun 是 Windows 版，
 * 退出码不可信。命名带 `.test.ts` 是为了 package.json 的 `files` 排除规则把它挡在
 * 发布包外，同时让 `bun run typecheck`（tsconfig 的 `src/` 范围）继续覆盖它。
 *
 * 断言的是**行为不变量**而不是整句文案：动作名必须**等于 schema 里的 enum**（不许多、
 * 不许少，顺序照 schema）；读不到动作时不许点名任何动作、也不许谎称不可用；纯 `file`
 * 批次不许加尾注；同一批引用只注入一次，但下一批要用**当时**的工具面。
 */

import type { HookContext, MessageRef, ToolDefinition } from '../packages/core/src/index';
import {
  createRefsNoticeHook,
  formatRefsLine,
  MEDIA_SURFACE_ABSENT,
  MEDIA_SURFACE_UNKNOWN,
  type MediaSurface,
  readMediaSurface,
} from './refs-notice-hook';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/** 假工具面：本次判定只关心 `name` 与 `inputSchema`，其余字段与结论无关。 */
function fakeTool(name: string, inputSchema: Record<string, unknown>): ToolDefinition {
  return { name, description: '', inputSchema, handler: async () => '' };
}

/** media 的 schema 形状（照 `plugins/media/media/src/tool.ts`：action.enum = 动作全集）。 */
function mediaSchema(actions: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...actions], description: 'read | ocr | describe' },
      path: { type: 'string' },
    },
    required: ['action', 'path'],
  };
}

const mediaTool = (actions: readonly string[]): ToolDefinition =>
  fakeTool('media', mediaSchema(actions));

const image = (path: string): MessageRef => ({ kind: 'image', path });
const file = (path: string): MessageRef => ({ kind: 'file', path });

/** 摊平三档便于断言（`actions:<enum 用 | 拼>` / `absent` / `unknown`）。 */
function describeSurface(surface: MediaSurface): string {
  return surface.availability === 'actions'
    ? `actions:${surface.actions.join('|')}`
    : surface.availability;
}

/** 抽出尾注（第一个 `(` 起）：只看尾注，不让路径拼装的噪声混进断言。 */
function tailOf(line: string): string {
  const at = line.indexOf('(');
  return at === -1 ? '' : line.slice(at);
}

/** 跑一轮 BeforeLlm，返回这一轮新增的通知正文（hook 每轮写进新的 ctx）。 */
async function runRound(
  hook: ReturnType<typeof createRefsNoticeHook>,
  refs: readonly MessageRef[],
  sessionId = 's1',
): Promise<string[]> {
  const ctx: HookContext = { run_id: 'r', session_id: sessionId, refs };
  await hook.run(ctx);
  return (ctx.messages ?? []).map((message) => message.content);
}

async function main(): Promise<void> {
  // ---- 1. 动作名 = schema 里的 enum（不多不少，顺序照 schema） ----
  const allThree = readMediaSurface([mediaTool(['read', 'ocr', 'describe'])]);
  const allKind = describeSurface(allThree);
  check('全 action 档', allKind === 'actions:read|ocr|describe', allKind);

  const allLine = formatRefsLine([image('/a.png')], allThree);
  const allTail = tailOf(allLine);
  check('全 action 尾注', allTail === '(use media: action=read|ocr|describe)', allTail);
  check('不写 media.read', !allLine.includes('media.read'), allLine);

  // 没装 tesseract：插件 `supportedActions` 已把 ocr 从 enum 滤掉，尾注也不许出现它
  const noOcr = readMediaSurface([mediaTool(['read', 'describe'])]);
  const noOcrTail = tailOf(formatRefsLine([image('/a.png')], noOcr));
  check('缺 ocr 尾注', noOcrTail === '(use media: action=read|describe)', noOcrTail);
  check('缺 ocr 不提 ocr', !noOcrTail.includes('ocr'), noOcrTail);

  const readOnly = readMediaSurface([mediaTool(['read'])]);
  const readOnlyTail = tailOf(formatRefsLine([image('/a.png')], readOnly));
  check('只剩 read', readOnlyTail === '(use media: action=read)', readOnlyTail);

  // 顺序由 schema 决定（本模块不排序）
  const reordered = readMediaSurface([mediaTool(['describe', 'read'])]);
  const reorderedTail = tailOf(formatRefsLine([image('/a.png')], reordered));
  check('顺序沿用 schema', reorderedTail === '(use media: action=describe|read)', reorderedTail);

  // ---- 2. 没有 media 工具 → 「不可用」档 ----
  const absent = readMediaSurface([fakeTool('read', mediaSchema(['read']))]);
  const absentKind = describeSurface(absent);
  check('没有 media 工具', absentKind === 'absent', absentKind);
  const absentTail = tailOf(formatRefsLine([image('/a.png')], absent));
  check('不可用档不点名工具', !absentTail.includes('use media'), absentTail);
  check('不可用档说怎么开', absentTail.includes('enable the media plugin'), absentTail);

  // ---- 3. 工具在但读不到动作 → 中性档（读不到就不猜） ----
  const noEnumSchema = { type: 'object', properties: { path: { type: 'string' } } };
  const noEnum = readMediaSurface([fakeTool('media', noEnumSchema)]);
  const noEnumKind = describeSurface(noEnum);
  check('schema 没有 enum', noEnumKind === 'unknown', noEnumKind);

  const enumNotArray = readMediaSurface([
    fakeTool('media', { properties: { action: { enum: 'read' } } }),
  ]);
  const enumNotArrayKind = describeSurface(enumNotArray);
  check('enum 不是数组', enumNotArrayKind === 'unknown', enumNotArrayKind);

  const emptyEnum = readMediaSurface([mediaTool([])]);
  const emptyEnumKind = describeSurface(emptyEnum);
  check('enum 是空数组', emptyEnumKind === 'unknown', emptyEnumKind);

  const dirtyEnum = readMediaSurface([
    fakeTool('media', { properties: { action: { enum: ['read', 3, '', 'ocr'] } } }),
  ]);
  const dirtyKind = describeSurface(dirtyEnum);
  check('enum 脏值被滤掉', dirtyKind === 'actions:read|ocr', dirtyKind);

  // schema 是插件自描述对象：读的时候抛错也只退中性档
  const hostileSchema = Object.defineProperty({}, 'name', {
    get(): string {
      throw new Error('hostile schema');
    },
  }) as unknown as ToolDefinition;
  const hostileKind = describeSurface(readMediaSurface([hostileSchema]));
  check('工具面读时抛错', hostileKind === 'unknown', hostileKind);

  const unknownTail = tailOf(formatRefsLine([image('/a.png')], MEDIA_SURFACE_UNKNOWN));
  check('中性档不点名动作', !unknownTail.includes('use media'), unknownTail);
  check('中性档不谎称不可用', !unknownTail.includes('media plugin'), unknownTail);
  check('中性档提示自己读', unknownTail.includes('read it with your tools'), unknownTail);
  check('三档互不相同', absentTail !== unknownTail, absentTail + ' / ' + unknownTail);

  const noProbeTail = tailOf(formatRefsLine([image('/a.png')]));
  check('没给三档也中性', noProbeTail === unknownTail, noProbeTail);

  // ---- 4. 纯 file 批次：任何档都不加尾注 ----
  const fileOnly = '[refs] 2 attachments: file /a.md, file /b.ts';
  for (const surface of [allThree, absent, MEDIA_SURFACE_UNKNOWN, undefined]) {
    const line = formatRefsLine([file('/a.md'), file('/b.ts')], surface);
    const kind = surface?.availability ?? 'undefined';
    check(`纯 file 不加尾注 ${kind}`, line === fileOnly, line);
  }

  // ---- 5. 折叠与「尾注看全部引用」都不变 ----
  const many = [image('/a.png'), image('/b.png'), image('/c.png'), image('/d.png')];
  const five = [...many, image('/e.png')];
  const fiveLine = formatRefsLine(five, readOnly);
  check('5 条计数', fiveLine.startsWith('[refs] 5 attachments: '), fiveLine);
  check('折叠 +2 more', fiveLine.includes('+2 more'), fiveLine);
  check('折叠后仍有尾注', tailOf(fiveLine) === '(use media: action=read)', fiveLine);

  const late = [file('/a.md'), file('/b.md'), file('/c.md'), file('/d.md'), image('/e.png')];
  const lateTail = tailOf(formatRefsLine(late, readOnly));
  check('尾注看全部引用', lateTail === '(use media: action=read)', lateTail);

  // ---- 6. hook：探针每轮实时求值 + 同一批引用只注入一次 ----
  let tools: readonly ToolDefinition[] = [mediaTool(['read', 'ocr', 'describe'])];
  const live = createRefsNoticeHook({ mediaSurface: () => readMediaSurface(tools) });

  const firstRound = await runRound(live, [image('/a.png')]);
  check('第一轮一条注入', firstRound.length === 1, String(firstRound.length));
  const firstTail = tailOf(firstRound[0] ?? '');
  check('第一轮用当时 schema', firstTail === '(use media: action=read|ocr|describe)', firstTail);

  const sameRound = await runRound(live, [image('/a.png')]);
  check('同批引用不重复', sameRound.length === 0, String(sameRound.length));

  // 热应用：后端变了（tesseract 没了），schema 的 enum 跟着变窄
  tools = [mediaTool(['read'])];
  const hotRound = await runRound(live, [image('/b.png')]);
  check('热应用后一条注入', hotRound.length === 1, String(hotRound.length));
  const hotTail = tailOf(hotRound[0] ?? '');
  check('热应用不残留旧 enum', hotTail === '(use media: action=read)', hotTail);

  // 工具被热应用摘掉：退「不可用」档（而不是继续点名 media）
  tools = [];
  const removedRound = await runRound(live, [image('/c.png')]);
  check('摘掉后一条注入', removedRound.length === 1, String(removedRound.length));
  const removedTail = tailOf(removedRound[0] ?? '');
  check('摘掉后退不可用档', removedTail === absentTail, removedTail);

  // 换 session 各自独立去重
  const otherRound = await runRound(live, [image('/c.png')], 's2');
  check('另一 session 自己算', otherRound.length === 1, String(otherRound.length));

  // ---- 7. 探针抛错 / 没有探针：不许让一轮请求失败，也不许猜 ----
  const throwing = createRefsNoticeHook({
    mediaSurface: () => {
      throw new Error('probe boom');
    },
  });
  let threw = false;
  let thrownRound: string[] = [];
  try {
    thrownRound = await runRound(throwing, [image('/a.png')]);
  } catch {
    threw = true;
  }
  check('探针抛错不冒泡', !threw);
  check('探针抛错一条注入', thrownRound.length === 1, String(thrownRound.length));
  const thrownTail = tailOf(thrownRound[0] ?? '');
  check('探针抛错走中性档', thrownTail === unknownTail, thrownTail);

  const bare = createRefsNoticeHook();
  const bareRound = await runRound(bare, [image('/a.png')]);
  check('没有探针一条注入', bareRound.length === 1, String(bareRound.length));
  const bareTail = tailOf(bareRound[0] ?? '');
  check('没有探针走中性档', bareTail === unknownTail, bareTail);

  const emptyRound = await runRound(bare, []);
  check('没有引用不注入', emptyRound.length === 0, String(emptyRound.length));

  // 共享常量确实是那两档（防有人把 MEDIA_SURFACE_ABSENT 改成 actions）
  const constantsOk =
    describeSurface(MEDIA_SURFACE_ABSENT) === 'absent' &&
    describeSurface(MEDIA_SURFACE_UNKNOWN) === 'unknown';
  check('常量档位没串味', constantsOk);

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK refs-notice-hook: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED refs-notice-hook: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
