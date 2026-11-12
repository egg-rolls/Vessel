#!/usr/bin/env bun

/**
 * listRich() 摘要缓存门禁：把「文件没变就不要再 JSON.parse 一遍」变成 CI FAIL。
 *
 * 被测实现：packages/core/src/session/file-backend.ts 的 FileSessionStore。
 * 缓存键 = (path, mtimeMs, size)，值 = SessionInfo，LRU 上限 512（可注入更小的
 * 上限做淘汰验证）。「有没有真的 parse」由构造参数 parseJson 计数 —— 不是看命中
 * 统计，而是从**解析入口**数：命中路径一次都不进这个函数。
 *
 * 四组 fixture（真临时目录，不碰 ~/.vessel）：
 * - G1 命中：同一目录两次 listRich()，第二次 JSON.parse 计数不涨，结果逐字相同；
 * - G2 失效：文件被改写（size 变 / **只** mtime 变）→ 只重解析那一个文件、内容更新；
 * - G3 损坏：坏 JSON 仍被单文件跳过（不阻断列表、不被缓存、load() 仍抛
 *   SessionCorruptError），修好后立刻回到列表且随后可命中缓存；
 * - G4 LRU：上限 >= 会话数 → 稳态 0 次解析；上限 1 + 2 个会话 → 稳态**每轮都
 *   miss**（证明上限真的在淘汰，不是无限缓存）；上限 0 = 关闭缓存（每轮全解析）。
 * 附加零回归：G5 返回值是新鲜对象（调用方改字段污染不到缓存）；G6 空会话口径不变。
 *
 * 用法：bun run scripts/check-listrich-cache.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore, SessionCorruptError } from '../packages/core/src/session/file-backend';

interface FixtureSpec {
  /** 显式 title；缺省 title-<id> */
  title?: string;
  updatedAt?: number;
  /** 消息条数（0 = 空会话） */
  messages?: number;
  /** 直接写这份字符串（造损坏文件用） */
  content?: string;
}

function sessionPath(root: string, id: string): string {
  return join(root, `${encodeURIComponent(id)}.json`);
}

async function writeSessionFile(root: string, id: string, spec: FixtureSpec = {}): Promise<void> {
  const path = sessionPath(root, id);
  if (spec.content !== undefined) {
    await writeFile(path, spec.content, 'utf8');
    return;
  }
  const count = spec.messages ?? 1;
  const messages = Array.from({ length: count }, (_, index) => ({
    role: 'user',
    content: `message ${String(index)} of ${id}`,
  }));
  const disk = {
    session_id: id,
    title: spec.title ?? `title-${id}`,
    preview: `preview-${id}`,
    created_at: 1700000000000,
    updated_at: spec.updatedAt ?? 1700000000000,
    started_at: 1700000000000,
    status: 'completed',
    messages,
  };
  await writeFile(path, JSON.stringify(disk, null, 2), 'utf8');
}

/** 把 mtime 推到确定的将来时刻（不依赖「两次写之间的真实时间差」）。 */
async function setMtime(path: string, offsetSeconds: number): Promise<void> {
  const stamp = new Date(Date.now() + offsetSeconds * 1000);
  await utimes(path, stamp, stamp);
}

interface Instrumented {
  store: FileSessionStore;
  counter: { parses: number };
}

/** 注入 parse 计数器；limit 缺省不传（用实现的 512）。 */
function makeStore(root: string, limit?: number): Instrumented {
  const counter = { parses: 0 };
  const store = new FileSessionStore(root, {
    parseJson: (text: string): unknown => {
      counter.parses += 1;
      return JSON.parse(text) as unknown;
    },
    ...(limit !== undefined ? { listRichCacheLimit: limit } : {}),
  });
  return { store, counter };
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
}

function ids(list: ReadonlyArray<{ session_id: string }>): string {
  return list.map((info) => info.session_id).join(',');
}

const roots: string[] = [];

// ── G1：命中 ────────────────────────────────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'listrich-cache-'));
roots.push(root);
const main = makeStore(root);
await writeSessionFile(root, 's1', { messages: 3, updatedAt: 3000 });
await writeSessionFile(root, 's2', { messages: 2, updatedAt: 2000 });
await writeSessionFile(root, 's3', { messages: 1, updatedAt: 1000 });

const first = await main.store.listRich();
check(
  'G1 首次三个会话各解析一次',
  main.counter.parses === 3,
  `parses=${String(main.counter.parses)}`,
);
const afterFirst = main.counter.parses;
const second = await main.store.listRich();
check(
  'G1 第二次命中缓存：0 次 JSON.parse',
  main.counter.parses === afterFirst,
  `parses=${String(main.counter.parses)}（首次后未变）`,
);
check(
  'G1 两次结果逐字相同',
  JSON.stringify(first) === JSON.stringify(second),
  `sessions=${ids(second)}`,
);
check('G1 顺序仍按 updated_at 倒序', ids(first) === 's1,s2,s3', `sessions=${ids(first)}`);

// ── G2：失效（size 变 / 只 mtime 变）────────────────────────────────────────
await writeSessionFile(root, 's2', { messages: 5, updatedAt: 4000, title: 'rewritten' });
await setMtime(sessionPath(root, 's2'), 5);
const beforeSizeChange = main.counter.parses;
const afterSizeChange = await main.store.listRich();
check(
  'G2 改写（size 变）只重解析 1 个文件',
  main.counter.parses - beforeSizeChange === 1,
  `delta=${String(main.counter.parses - beforeSizeChange)}`,
);
const rewritten = afterSizeChange[0];
check(
  'G2 内容已更新',
  rewritten !== undefined &&
    rewritten.session_id === 's2' &&
    rewritten.title === 'rewritten' &&
    rewritten.message_count === 5,
  `first=${JSON.stringify(rewritten)}`,
);

// 同字节长度、只改 title：size 不变，靠 mtime 区分。
await writeSessionFile(root, 's3', { messages: 1, updatedAt: 1000, title: 'title-X3' });
await setMtime(sessionPath(root, 's3'), 9);
const beforeMtimeChange = main.counter.parses;
const afterMtimeChange = await main.store.listRich();
check(
  'G2 只 mtime 变（size 相同）也会重解析',
  main.counter.parses - beforeMtimeChange === 1,
  `delta=${String(main.counter.parses - beforeMtimeChange)}`,
);
const touched = afterMtimeChange.find((info) => info.session_id === 's3');
check('G2 只 mtime 变时内容正确', touched?.title === 'title-X3', `title=${String(touched?.title)}`);

// 只 touch 不改内容：宁可多解析一次，也不猜内容。
await setMtime(sessionPath(root, 's1'), 13);
const beforeTouch = main.counter.parses;
const afterTouch = await main.store.listRich();
check(
  'G2 只 touch 不改内容也会重解析（不猜）',
  main.counter.parses - beforeTouch === 1,
  `delta=${String(main.counter.parses - beforeTouch)}`,
);
check(
  'G2 只 touch 后结果仍然正确',
  JSON.stringify(afterTouch.find((info) => info.session_id === 's1')) ===
    JSON.stringify(second.find((info) => info.session_id === 's1')),
  `s1=${JSON.stringify(afterTouch.find((info) => info.session_id === 's1'))}`,
);

// ── G3：损坏文件 ────────────────────────────────────────────────────────────
const badPath = sessionPath(root, 'bad');
await writeSessionFile(root, 'bad', { content: '{ this is not json' });
const beforeCorrupt = main.counter.parses;
const withCorrupt = await main.store.listRich();
check(
  'G3 损坏文件不阻断列表（单文件跳过）',
  ids(withCorrupt) === 's2,s1,s3',
  `sessions=${ids(withCorrupt)}`,
);
check(
  'G3 损坏文件不被缓存（每轮仍尝试解析）',
  main.counter.parses - beforeCorrupt === 1,
  `delta=${String(main.counter.parses - beforeCorrupt)}`,
);

let corruptThrew = false;
try {
  await main.store.load('bad');
} catch (error) {
  corruptThrew = error instanceof SessionCorruptError;
}
check('G3 load() 对损坏文件仍抛 SessionCorruptError', corruptThrew);

await writeSessionFile(root, 'bad', { messages: 2, updatedAt: 5000, title: 'fixed' });
await setMtime(badPath, 17);
const repaired = await main.store.listRich();
check(
  'G3 修好后同一路径回到列表（失败的那次没污染缓存）',
  repaired[0]?.session_id === 'bad' && repaired[0]?.title === 'fixed',
  `sessions=${ids(repaired)}`,
);
const beforeHitAgain = main.counter.parses;
await main.store.listRich();
check(
  'G3 修好后这一条也能命中缓存',
  main.counter.parses === beforeHitAgain,
  `delta=${String(main.counter.parses - beforeHitAgain)}`,
);

// ── G4：LRU 上限 ────────────────────────────────────────────────────────────
const roomyRoot = await mkdtemp(join(tmpdir(), 'listrich-cache-lru-'));
roots.push(roomyRoot);
await writeSessionFile(roomyRoot, 'a', { updatedAt: 3000 });
await writeSessionFile(roomyRoot, 'b', { updatedAt: 2000 });
await writeSessionFile(roomyRoot, 'c', { updatedAt: 1000 });
const roomy = makeStore(roomyRoot, 3);
const roomyFirst = await roomy.store.listRich();
check(
  'G4 上限 3（= 会话数）：首轮 3 次解析',
  roomy.counter.parses === 3,
  `parses=${String(roomy.counter.parses)}`,
);
check('G4 上限 3：列表完整', ids(roomyFirst) === 'a,b,c', `sessions=${ids(roomyFirst)}`);
const beforeRoomy = roomy.counter.parses;
await roomy.store.listRich();
check(
  'G4 上限 3：第二轮 0 次解析',
  roomy.counter.parses === beforeRoomy,
  `delta=${String(roomy.counter.parses - beforeRoomy)}`,
);

// 上限 1 + 2 个会话：LRU 装不下工作集，稳态必然每轮全 miss。
// 无界缓存会让这条 FAIL —— 它是「上限真的生效」的反证。
const tightRoot = await mkdtemp(join(tmpdir(), 'listrich-cache-tight-'));
roots.push(tightRoot);
await writeSessionFile(tightRoot, 'a', { updatedAt: 3000 });
await writeSessionFile(tightRoot, 'b', { updatedAt: 2000 });
const tight = makeStore(tightRoot, 1);
await tight.store.listRich();
const beforeTight = tight.counter.parses;
await tight.store.listRich();
check(
  'G4 上限 1：稳态每轮 2 次解析（上限真的在淘汰）',
  tight.counter.parses - beforeTight === 2,
  `delta=${String(tight.counter.parses - beforeTight)}`,
);

const offRoot = await mkdtemp(join(tmpdir(), 'listrich-cache-off-'));
roots.push(offRoot);
await writeSessionFile(offRoot, 'a', { updatedAt: 3000 });
await writeSessionFile(offRoot, 'b', { updatedAt: 2000 });
const off = makeStore(offRoot, 0);
await off.store.listRich();
const beforeOff = off.counter.parses;
await off.store.listRich();
check(
  'G4 上限 0 = 关闭缓存（每轮全解析）',
  off.counter.parses - beforeOff === 2,
  `delta=${String(off.counter.parses - beforeOff)}`,
);

// ── G5：返回值是新鲜对象 ────────────────────────────────────────────────────
const fresh = await main.store.listRich();
const victim = fresh[0];
if (victim !== undefined) {
  victim.title = 'HACKED';
  victim.message_count = 999;
}
const afterMutation = await main.store.listRich();
check(
  'G5 调用方改返回值不污染缓存',
  afterMutation[0]?.title !== 'HACKED' && afterMutation[0]?.message_count !== 999,
  `first=${JSON.stringify(afterMutation[0])}`,
);

// ── G6：空会话口径不变 ──────────────────────────────────────────────────────
await writeSessionFile(root, 'empty', { messages: 0 });
const withEmpty = await main.store.listRich();
check(
  'G6 空会话不进列表（过滤口径不变）',
  !withEmpty.some((info) => info.session_id === 'empty'),
  `sessions=${ids(withEmpty)}`,
);

// ── 汇总 ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const item of checks) {
  if (!item.ok) failed += 1;
  const detail = item.detail === '' ? '' : `  (${item.detail})`;
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${detail}`);
}
for (const dir of roots) await rm(dir, { recursive: true, force: true });
console.log('');
console.log(
  failed === 0
    ? `listRich 缓存门禁全部通过（${String(checks.length)} 项）`
    : `${String(failed)} / ${String(checks.length)} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
