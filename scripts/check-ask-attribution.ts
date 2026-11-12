#!/usr/bin/env bun

/**
 * ask 归属门禁：`承接: 'card'` 必须真的**有消费点**，且卡片的取数字段与生产/传输/落盘
 * 三层对齐（0.51 回归的防复发线）。
 *
 * 这一单的教训（`docs/dev/reports/0.51/ask-card-regression.md` §4.3）：事件可见性表里
 * 写着 `ask.user.requested → 承接: 'card'`，但那条「卡」的取数链（父会话归属字段 +
 * 服务端落盘 / list 透传 + 客户端映射）没人校验，于是字段语义一错就是半年多的静默失效：
 * 工具调到了、事件也落盘了，卡片却永远进不了该进的会话 / 待批归属。
 *
 * 检查项：
 *
 * A. `承接: 'card'` ⇒ 必须在本脚本的 `CARD_CONSUMERS` 里登记消费点；登记的文件必须
 *    真的存在、且真的提到这个事件名（防「登记了但早已改名 / 删掉」）。
 * B. 取数字段对齐：`parent_agent_id` / `parent_session_id` 必须同时出现在生产（bridge）、
 *    记录、list DTO、客户端两条读路径（实时事件 / hydrate）与归属解析模块里 ——
 *    缺任何一层，卡片就是「有字段名、没有值」。
 * C. 反混用：`bridge` 不许再把父 **agent** id 写进 `parent_session_id`（旧那一行
 *    `data.parent_session_id = member.parent_id` 是本次回归的根）。
 * D. 会话页守卫：`pendingForSession` 必须走 `pendingOwnedBySession`，且这两处的判定
 *    都不许再引用父级归属 —— 用户裁定 contractor 的 ask 不在父会话页渲染。
 *
 * 用法：bun run scripts/check-ask-attribution.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EVENT_TIERS } from '../apps/web/src/state/event-visibility';

const REPO = join(import.meta.dir, '..');

const failures: string[] = [];

function fail(where: string, message: string): void {
  failures.push(`${where} ${message}`);
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
    fail(path, '[F 文件] 读不到这个文件（改名 / 删除？门禁需要它存在）');
    cache.set(path, '');
    return '';
  }
}

/** 断言某文件里出现某个字符串（取数字段必须一层不缺）。 */
async function expectContains(path: string, needle: string, why: string): Promise<void> {
  const text = await source(path);
  if (!text.includes(needle)) fail(path, `[B 取数] 缺 ${needle} —— ${why}`);
}

/** 断言某文件里**不出现**某个字符串（防混用 / 防守卫被放回去）。 */
async function expectAbsent(path: string, needle: string, why: string): Promise<void> {
  const text = await source(path);
  if (text.includes(needle)) fail(path, `[C 反混用] 不该出现 ${needle} —— ${why}`);
}

/** 取一个函数的函数体文本（从 `function name(` / `function name<` 到配对的 `}`）；取不到返回 ''。 */
async function functionBody(path: string, name: string): Promise<string> {
  const text = await source(path);
  const match = new RegExp(`function ${name}\\s*[<(]`).exec(text);
  if (match === null) {
    fail(path, `[D 守卫] 找不到函数 ${name}（改名了？门禁要跟着改）`);
    return '';
  }
  const start = match.index;
  const open = text.indexOf('{', text.indexOf(')', text.indexOf('(', start)));
  if (open === -1) return '';
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return '';
}

/** 扫描根（与 check-event-visibility 同口径：只看 web 源码，跳过构建产物）。 */
const SCAN_ROOT = 'apps/web/src';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'web', 'build', 'coverage']);

/** 递归收集 `apps/web/src` 下的源码文件（相对路径）。 */
async function walkWebSource(dir = SCAN_ROOT): Promise<string[]> {
  const entries = await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...(await walkWebSource(relative)));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    files.push(relative);
  }
  return files;
}

/**
 * 通用层（除登记过的**卡片**之外的所有 `承接: 'card'`）：事件名必须真的被
 * 某个 web 源码文件引用（时间线分组 / 卡片组件都算）。
 *
 * 树表本身（`state/event-visibility.ts`）不算消费点：它只是登记册。这一条挡的是
 * 「表里认了这张卡，代码里没人接」——本次回归的同族问题。
 */
async function checkGenericCardConsumers(carded: readonly string[]): Promise<void> {
  const unregistered = carded.filter((name) => CARD_CONSUMERS[name] === undefined);
  if (unregistered.length === 0) return;
  const files = await walkWebSource();
  const texts = await Promise.all(files.map(async (file) => ({ file, text: await source(file) })));
  for (const name of unregistered) {
    const needle = `'${name}'`;
    const hit = texts.some(
      (entry) =>
        entry.file !== 'apps/web/src/state/event-visibility.ts' && entry.text.includes(needle),
    );
    if (!hit) {
      fail(
        'apps/web/src/state/event-visibility.ts',
        `[A 承接] "${name}" 写了 承接: 'card'，但 ${SCAN_ROOT} 里没有任何文件引用它` +
          '（承接写了一张卡，就得有人真去接它）',
      );
    }
  }
}

/**
 * A：`承接: 'card'` 的消费点登记表。
 *
 * 登记的是「这条事件被谁接成一张卡」：`stages` 是必须存在的取数链环节，
 * 每个环节给出文件 + 必须出现的事件名 / 字段名。表里没有的 `承接: 'card'` 条目
 * 一律 FAIL —— 那就是「承接写了、没人接」。
 */
interface CardConsumer {
  /** 事件名 → 见 EVENT_TIERS */
  stages: readonly { file: string; needle: string; why: string }[];
}

const CARD_CONSUMERS: Readonly<Record<string, CardConsumer>> = {
  'ask.user.requested': {
    stages: [
      {
        file: 'apps/web/src/gateway/connection-handlers.ts',
        needle: 'ask.user.requested',
        why: '实时事件必须在客户端被消费成 ask 卡片（0.51 前它只进 store、不进归属）',
      },
      {
        file: 'apps/web/src/gateway/interactions.ts',
        needle: 'export function askFromEvent',
        why: '事件 → 卡片模型的唯一映射点',
      },
      {
        file: 'apps/web/src/gateway/interaction-hydration.ts',
        needle: 'buildHydrationSnapshot',
        why: '刷新 / 重连后 interactions.list 的补回路径',
      },
      {
        file: 'apps/web/src/domains/pending/cluster.ts',
        needle: 'groupPendingAsks',
        why: '待批页的投影（唯一不过滤的展示面）',
      },
      {
        file: 'apps/web/src/domains/chat/ComposerSlot.tsx',
        needle: "pendingItem.kind === 'ask'",
        why: '会话页 Composer 槽位的渲染点（守卫之后的落点）',
      },
    ],
  },
  'tool.permission.request': {
    stages: [
      {
        file: 'apps/web/src/gateway/connection-handlers.ts',
        needle: 'tool.permission.request',
        why: '实时事件必须在客户端被消费成权限卡片',
      },
      {
        file: 'apps/web/src/gateway/interactions.ts',
        needle: 'export function permissionFromEvent',
        why: '事件 → 卡片模型的唯一映射点',
      },
      {
        file: 'apps/web/src/domains/chat/ComposerSlot.tsx',
        needle: "pendingItem.kind === 'permission'",
        why: '会话页 Composer 槽位的渲染点',
      },
    ],
  },
  /**
   * headless 的 ask 收口：web 不直接消费这个事件（它没有卡片模型），但它必须有人接，
   * 否则「挂起的 ask」在重启 hydrate 时会被误判成 orphaned —— 那才是真的把卡片弄丢。
   * 所以这里登记的是**服务端收口 + 客户端 list 补回**这条真实链路。
   */
  'ask.user.timeout': {
    stages: [
      {
        file: 'packages/serve/src/interactions-registry.ts',
        needle: 'ask.user.timeout',
        why: '服务端收到后标 suspended（重启 / 迟到的回答都不能把它转 orphaned）',
      },
      {
        file: 'apps/web/src/gateway/use-interaction-hydration.ts',
        needle: 'interactions.list',
        why: 'web 侧的卡片状态由释放后的 list 补回收口',
      },
    ],
  },
};

/**
 * B：取数字段链（每一层给出**该层实际写法**的 needle）。
 *
 * 只列**跨层**的归属字段：`session_id` / `questions` 这类自古就在的字段不重复登记，
 * 这一单坏掉的正是归属，所以把两个归属字段钉死，缺任何一层就是「字段名在、值不到」。
 */
const FIELD_CHAIN: readonly {
  field: string;
  layers: readonly { file: string; needle: string; why: string }[];
}[] = [
  {
    field: 'parent_agent_id',
    layers: [
      {
        file: 'packages/agent/src/runtime.ts',
        needle: 'data.parent_agent_id = member.parent_id',
        why: '生产：bridge 把父 **agent** id 写进独立键',
      },
      {
        file: 'packages/agent/src/types.ts',
        needle: 'parent_session_id?: string',
        why: '执行身份里有父会话字段（父 agent 复用既有的 parent_id）',
      },
      {
        file: 'packages/serve/src/interactions-store.ts',
        needle: 'parent_agent_id?: string',
        why: '落盘：StoredInteraction 必须能存能读',
      },
      {
        file: 'packages/serve/src/interactions-registry.ts',
        needle: 'parent_agent_id?: string',
        why: '记录：事件 → 记录的收口',
      },
      {
        file: 'packages/serve/src/gateway/methods/interactions.ts',
        needle: "parent_agent_id: { type: 'string' }",
        why: 'list DTO 的校验 schema（少一个键，客户端就永远收不到它）',
      },
      {
        file: 'apps/web/src/gateway/interactions.ts',
        needle: 'parentAgentId: data.parent_agent_id',
        why: '客户端实时事件映射',
      },
      {
        file: 'apps/web/src/gateway/interaction-hydration.ts',
        needle: 'parentAgentId: item.parent_agent_id',
        why: '客户端 hydrate 映射',
      },
      {
        file: 'apps/web/src/gateway/types/sessions.ts',
        needle: 'parentAgentId?: string',
        why: '客户端卡片模型的字段声明',
      },
      {
        file: 'apps/web/src/domains/pending/attribution.ts',
        needle: 'item.parentAgentId',
        why: '归属解析读它（决定父会话）',
      },
    ],
  },
  {
    field: 'parent_session_id',
    layers: [
      {
        file: 'packages/agent/src/runtime.ts',
        needle: 'member.parent_session_id',
        why: '生产：bridge 只拿成员记录里的父**会话** id 填这个键',
      },
      {
        file: 'packages/agent/src/types.ts',
        needle: 'parent_session_id?: string',
        why: '执行身份字段声明（父会话）',
      },
      {
        file: 'packages/serve/src/interactions-store.ts',
        needle: 'parent_session_id?: string',
        why: '落盘',
      },
      {
        file: 'packages/serve/src/interactions-registry.ts',
        needle: 'parent_session_id?: string',
        why: '记录',
      },
      {
        file: 'packages/serve/src/gateway/methods/interactions.ts',
        needle: "parent_session_id: { type: 'string' }",
        why: 'list DTO 的校验 schema',
      },
      {
        file: 'apps/web/src/gateway/interactions.ts',
        needle: 'parentSessionId: data.parent_session_id',
        why: '客户端实时事件映射',
      },
      {
        file: 'apps/web/src/gateway/interaction-hydration.ts',
        needle: 'parentSessionId: item.parent_session_id',
        why: '客户端 hydrate 映射',
      },
      {
        file: 'apps/web/src/gateway/types/sessions.ts',
        needle: 'parentSessionId?: string',
        why: '客户端卡片模型的字段声明',
      },
      {
        file: 'apps/web/src/domains/pending/attribution.ts',
        needle: 'item.parentSessionId',
        why: '归属解析读它（含历史脏数据甄别 / 上溯）',
      },
    ],
  },
];

/** 缺失的父会话归属只能不写 —— 这两个键在 bridge 里的分工是本单的核心。 */
const BRIDGE_FILE = 'packages/agent/src/runtime.ts';

async function checkCardConsumers(): Promise<void> {
  const carded = Object.entries(EVENT_TIERS).filter(([, spec]) => spec.承接 === 'card');
  if (carded.length === 0) {
    fail(
      'apps/web/src/state/event-visibility.ts',
      '[A 承接] 表里一条 `承接: card` 都没有（改口径了？）',
    );
  }
  const names = carded.map(([name]) => name);
  for (const name of names) {
    const consumer = CARD_CONSUMERS[name];
    if (consumer === undefined) continue;
    for (const stage of consumer.stages) {
      const text = await source(stage.file);
      if (!text.includes(stage.needle)) {
        fail(stage.file, `[A 承接] "${name}" 的消费点缺 ${stage.needle} —— ${stage.why}`);
      }
    }
  }
  await checkGenericCardConsumers(names);
  // 反向：登记表里留着的条目必须还在表里（事件被删 / 改了承接，登记表要跟着改）
  for (const name of Object.keys(CARD_CONSUMERS)) {
    const spec = EVENT_TIERS[name];
    if (spec === undefined) {
      fail('scripts/check-ask-attribution.ts', `[A 承接] 登记了 "${name}"，事件表里没有它`);
      continue;
    }
    if (spec.承接 !== 'card') {
      fail(
        'scripts/check-ask-attribution.ts',
        `[A 承接] 登记了 "${name}" 的卡片消费点，但表里它的 承接 不是 'card'`,
      );
    }
  }
}

async function checkFieldChain(): Promise<void> {
  for (const { field, layers } of FIELD_CHAIN) {
    for (const layer of layers) {
      const text = await source(layer.file);
      if (!text.includes(layer.needle)) {
        fail(layer.file, `[B 取数] ${field} 缺 "${layer.needle}" —— ${layer.why}`);
      }
    }
  }
}

async function checkNoAgentIdAsSession(): Promise<void> {
  // 旧那一行：`data.parent_session_id = member.parent_id;`（agent id 冒充会话 id）
  await expectAbsent(
    BRIDGE_FILE,
    'data.parent_session_id = member.parent_id',
    'agent id 不是会话 id；父会话取不到就不写，让读侧走 roster 上溯',
  );
  // 生产侧必须真的从 member 的父会话字段取值
  await expectContains(
    BRIDGE_FILE,
    'member.parent_session_id',
    'bridge 只能拿成员记录里的父会话 id 填 parent_session_id',
  );
  // 读侧旧口径：`parentSessionId ?? sessionId`（把父 chat 当唯一归属）
  await expectAbsent(
    'apps/web/src/domains/chat/pending-permissions.ts',
    'parentSessionId ?? ',
    '归属必须走 attribution.ts（含历史脏数据甄别），不能就地二选一',
  );
}

async function checkSessionGuard(): Promise<void> {
  const guardBody = await functionBody(
    'apps/web/src/domains/chat/pending-permissions.ts',
    'pendingForSession',
  );
  if (guardBody !== '') {
    if (!guardBody.includes('pendingOwnedBySession')) {
      fail(
        'apps/web/src/domains/chat/pending-permissions.ts',
        '[D 守卫] pendingForSession 必须走 pendingOwnedBySession（唯一判据，禁止就地重写）',
      );
    }
    if (/parent/i.test(guardBody)) {
      fail(
        'apps/web/src/domains/chat/pending-permissions.ts',
        '[D 守卫] pendingForSession 里出现了父级归属 —— contractor 的 ask 不许回到父会话页',
      );
    }
  }
  const ownsBody = await functionBody(
    'apps/web/src/domains/pending/attribution.ts',
    'pendingOwnedBySession',
  );
  if (ownsBody !== '' && /parent/i.test(ownsBody)) {
    fail(
      'apps/web/src/domains/pending/attribution.ts',
      '[D 守卫] pendingOwnedBySession 引用了父级归属 —— 会话页只认自己的 sessionId',
    );
  }
  // 守卫的另外一半：bridge 不许把数据「投递」到父会话（事件过滤不归本单改，
  // 但一旦有人顺手在 bridge 里把 session_id 改成父会话，卡片就会串到父会话页）。
  await expectAbsent(
    BRIDGE_FILE,
    'data.session_id = member.parent',
    '成员事件的自报 session 必须是成员自己的会话',
  );
}

async function main(): Promise<void> {
  await checkCardConsumers();
  await checkFieldChain();
  await checkNoAgentIdAsSession();
  await checkSessionGuard();

  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL  ${failure}`);
    console.error(`ask attribution: ${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log('ask attribution: all checks passed');
}

await main();
