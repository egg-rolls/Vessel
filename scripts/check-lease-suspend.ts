#!/usr/bin/env bun

/**
 * 租约「合盖/挂起」回归门禁（0.52）。
 *
 * 事故：机器挂起 1.5h 后醒来，四个 session 在同一毫秒丢租约 ⇒ 在跑的 run 全部
 * `stale_fence` / `lease_expired` 而失败（`node-Soulkiller.log 15:17:19.690`），
 * 连 `run.failed` 本身都写不进日志（终态丢失）。
 *
 * 根因是判据只看时钟：`isRecordHeld` 用 `expires_at <= now` 判失效，`fenceOf` 对过期记录
 * 一律 `fence + 1`，`renew` 一律抛。但**租约的 identity 是 lease_id**（acquire/回收都换
 * 新 UUID），所以「lease_id 没变 + pid/host 是我们」就证明期间没人接管 —— 与时钟无关。
 *
 * 本探针钉的就是这件事，用注入的假时钟模拟挂起：
 *   A 挂起后 fence 不许被自己推动（否则在跑的 writer 必被判 stale）；
 *   B 挂起后 renew 必须能原地续期且 fence 不变；
 *   C 挂起后 validate 仍为 true；
 *   D **隔离性不许为此松掉**：真被别人回收后，旧 token 必须失效（fence +1、lease_id 变）。
 *
 * 用法：bun run scripts/check-lease-suspend.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLeaseService } from '../src/lease-service';

const failures: string[] = [];
let checked = 0;

function expect(cond: boolean, message: string): void {
  checked += 1;
  if (!cond) failures.push(message);
}

const TTL = 30_000;
const dir = await mkdtemp(join(tmpdir(), 'vessel-lease-'));

function service(options: {
  clock: { value: number };
  pid?: number;
  host?: string;
}): FileLeaseService {
  return new FileLeaseService({
    tenantDir: dir,
    tenantId: 'tenant-test',
    ttlMs: TTL,
    renewMs: 10_000,
    now: () => options.clock.value,
    hostname: options.host ?? 'host-a',
    pid: options.pid ?? 1001,
    isPidAlive: () => true,
  });
}

const clock = { value: 1_000_000 };
const owner = service({ clock });

const grant = await owner.acquire('session', 'sess-1');
const fenceBefore = await owner.fenceOf('session', 'sess-1');
expect(fenceBefore === grant.fencingToken, 'A: 正常持有的 fence 与 grant 不一致');

// 挂起 1.5 小时（定时器不跑，墙钟照走）——正是事故场景。
clock.value += 90 * 60 * 1000;

expect(
  (await owner.fenceOf('session', 'sess-1')) === fenceBefore,
  'A: 挂起后 fenceOf 把 fence 推高了 —— 在跑的 writer 会被自判 stale_fence（事故根因）',
);

let renewed = false;
try {
  const next = await owner.renew(grant.leaseId);
  renewed = true;
  expect(next.fencingToken === fenceBefore, 'B: 原地续期不许改 fence');
  expect(next.expiresAt === clock.value + TTL, 'B: 续期后的 expires_at 不对');
} catch {
  renewed = false;
}
expect(renewed, 'B: 挂起后 renew 抛错 —— 长任务跨一次睡眠必死');

expect(await owner.validate(grant.leaseId), 'C: 挂起后 validate 判成失效');
expect((await owner.fenceOf('session', 'sess-1')) === fenceBefore, 'C: 续期后 fence 又变了');

// D. 隔离性：另一个进程（不同 pid/host）在过期后回收，旧 token 必须立刻失效。
const clock2 = { value: clock.value };
const other = service({ clock: clock2, pid: 2002, host: 'host-b' });
clock2.value += 3 * 60 * 60 * 1000; // 让记录再次过期
const reclaimed = await other.acquire('session', 'sess-1');
expect(reclaimed.fencingToken > fenceBefore, 'D: 别人回收后 fence 必须更高');
expect(reclaimed.leaseId !== grant.leaseId, 'D: 回收必须换 lease_id（身份判据的基础）');
expect(
  (await other.fenceOf('session', 'sess-1')) === reclaimed.fencingToken,
  'D: 回收后 fenceOf 与 grant 不一致',
);
expect(
  (await other.fenceOf('session', 'sess-1')) > fenceBefore,
  'D: 旧 token 必须小于当前 fence（否则隔离性被破坏）',
);
// 旧持有者此时已经真的不是 owner 了：renew 必须失败。
let oldRenewFailed = false;
try {
  await owner.renew(grant.leaseId);
} catch {
  oldRenewFailed = true;
}
expect(oldRenewFailed, 'D: 被回收之后旧持有者仍能 renew —— 隔离性被破坏');

await rm(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(
    `check-lease-suspend: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-lease-suspend: OK（${String(checked)} 项：挂起不推 fence / 原地续期 / validate / 回收隔离性）`,
);
