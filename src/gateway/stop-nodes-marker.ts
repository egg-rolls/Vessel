/**
 * stop-nodes 意图 marker（q-handoff-stop-nodes-race）：`gateway stop --stop-nodes` /
 * `vessel stop` / `vessel restart` 的 drain 窗口内，manifest 里的 node/hub 仍活着、
 * `gateway.pid` 三元组 / hub lock 的 adopt 判据全绿——但它们已被判死。并发的
 * `gateway start` / `gateway restart`（平台-only handoff）若此刻 adopt，会接管
 * 即将被停止方杀掉的子进程（adopted node 的看门狗还会违背停意重 spawn）。
 *
 * handoff marker（handoff.ts）只传「保活」意图；本 marker 传反向的「正在真停」：
 * - 停止方（stopGateway 非 keep 路径）在 stopSpawnedChildren **之前**写入，
 *   pid 指向停止方进程；drain 结束（无论成败）后清除；
 * - 启动方（daemon 父进程 spawn 前 / 前台 begin 前）读到有效 marker 就**等 drain
 *   结束再 adopt/spawn**（候 drain 毕再 adopt，时序安全）。
 *
 * 有效性判据 = 停止方进程仍活着（isProcessAlive）。drain 候 run 段不限时
 * （用户裁定 #5），所以**不设固定 TTL**——停止方死亡（崩溃/被杀）即 marker 失效，
 * 启动方顺手清掉残留继续启动。已知边界：停止方 pid 被无关进程复用时 marker 会
 * 误判有效（与 handoff marker 的 pid 判据同族暴露面；停止方被杀后复用到同一 pid
 * 的概率极低，且杀停止方本身就是放弃本次 stop）。
 *
 * 边界：marker 只是本进程族的运行时状态，不进契约、不改 adopt 判据本身、不改
 * `gateway.pid` / hub lock 的写法与语义；无 marker 时行为与既有逐字一致。
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_GATEWAY_INSTANCE, isProcessAlive, normalizeGatewayInstance } from './pid';

/** 等待轮询间隔（与 daemon 父进程等 PID 的 100ms 不同：drain 以秒计，1s 足够）。 */
const STOP_NODES_POLL_MS = 1_000;

export interface StopNodesMarker {
  v: 1;
  /** 正在执行 stop --stop-nodes 的进程 pid（drain 期间它必须活着）。 */
  stopper_pid: number;
  requested_at_ms: number;
}

export function stopNodesMarkerFileName(instance?: string): string {
  const name = normalizeGatewayInstance(instance);
  return name === DEFAULT_GATEWAY_INSTANCE
    ? 'platform-stop-nodes.json'
    : `platform-stop-nodes-${name}.json`;
}

export function stopNodesMarkerPath(dataDir: string, instance?: string): string {
  return path.join(dataDir, stopNodesMarkerFileName(instance));
}

/** 严格解析；任何字段不合法都返回 undefined（当作没有 marker）。 */
export function parseStopNodesMarker(raw: unknown): StopNodesMarker | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const stopperPid = record.stopper_pid;
  const requestedAt = record.requested_at_ms;
  if (record.v !== 1) return undefined;
  if (typeof stopperPid !== 'number' || !Number.isInteger(stopperPid) || stopperPid <= 0) {
    return undefined;
  }
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return undefined;
  return { v: 1, stopper_pid: stopperPid, requested_at_ms: requestedAt };
}

/** 写入 marker（原子写；语义见文件头注释）。 */
export async function writeStopNodesMarker(
  dataDir: string,
  instance: string | undefined,
  stopperPid: number,
  now: number = Date.now(),
): Promise<void> {
  const name = normalizeGatewayInstance(instance);
  const filePath = stopNodesMarkerPath(dataDir, name);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${stopNodesMarkerFileName(name)}.${process.pid}.${Date.now()}.tmp`);
  const marker: StopNodesMarker = { v: 1, stopper_pid: stopperPid, requested_at_ms: now };
  await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {}
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  try {
    await chmod(filePath, 0o600);
  } catch {}
}

/** 删除 marker（drain 结束后清理；不存在时静默）。 */
export async function clearStopNodesMarker(dataDir: string, instance?: string): Promise<void> {
  await unlink(stopNodesMarkerPath(dataDir, instance)).catch(() => undefined);
}

/** 只读 marker（不消费）；缺失/损坏返回 undefined。 */
export async function readStopNodesMarker(
  dataDir: string,
  instance?: string,
): Promise<StopNodesMarker | undefined> {
  let body: string;
  try {
    body = await readFile(stopNodesMarkerPath(dataDir, instance), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseStopNodesMarker(JSON.parse(body));
  } catch {
    return undefined;
  }
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动方闸门：有有效 stop-nodes marker（停止方仍活）就等它 drain 结束。
 * 无 marker / marker 损坏 / 停止方已死 ⇒ 立即返回（后者顺手清残留）。
 * 不限时——与 drain 候 run 段同语义（用户裁定 #5）；杀停止方即解除等待。
 * `onWait` 只在首次进入等待时回调一次（启动方渲染一行可见性日志）。
 */
export async function waitForStopNodesDrain(
  dataDir: string,
  instance: string | undefined,
  options: {
    sleep?: (ms: number) => Promise<void>;
    onWait?: (marker: StopNodesMarker) => void;
  } = {},
): Promise<void> {
  const sleep = options.sleep ?? sleepDefault;
  let announced = false;
  for (;;) {
    const marker = await readStopNodesMarker(dataDir, instance);
    if (marker === undefined) return;
    if (!isProcessAlive(marker.stopper_pid)) {
      // 停止方已死（崩溃/被杀）：本次 stop 已放弃，marker 是残留——清掉继续启动。
      await clearStopNodesMarker(dataDir, instance);
      return;
    }
    if (!announced) {
      announced = true;
      try {
        options.onWait?.(marker);
      } catch {
        // 观察者抛错不影响等待。
      }
    }
    await sleep(STOP_NODES_POLL_MS);
  }
}
