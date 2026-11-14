/**
 * `check:node-handoff` —— 0.52 handoff（gateway 重启不再杀掉 node）的零依赖探针。
 *
 * 覆盖三件事，都不需要真起 gateway/node：
 * 1. **行为**：`NodeSupervisor.stop({ keep: true })` / `stopSpawnedChildren({ keep: true })`
 *    一个 terminate 都不发；不带 keep 时照旧终止（`terminate` 是 supervisor 既有注入点）。
 * 2. **交接**：handoff marker 只在「pid 命中 + 未过期」时命中，且读后即删（不会二次生效）。
 * 3. **接线**：`gateway restart` 的 CLI 分支确实把 keep 传下去；`gateway stop` 缺省**不**带 keep
 *    （防止后来的人顺手把「真停」改成假停），只有显式 `--keep-nodes` 才带。
 *
 * 用法：`bun run scripts/check-node-handoff.ts`（`bun run check:node-handoff`）。
 * @module scripts/check-node-handoff
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../src/cli-args';
import {
  HANDOFF_MARKER_TTL_MS,
  consumeHandoffMarker,
  handoffMarkerPath,
  writeHandoffMarker,
} from '../src/gateway/handoff';
import {
  type SpawnedChildRecord,
  NodeSupervisor,
  readSpawnedChildren,
  spawnedChildrenPath,
  stopSpawnedChildren,
} from '../src/gateway/node-supervisor';

let checks = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  const line = detail === undefined ? name : `${name} (${detail})`;
  failures.push(line);
  console.log(`  FAIL ${line}`);
}

async function makeTmpDir(tag: string): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `vessel-handoff-probe-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 造一份「活的」node 归属证据：`<data_dir>/gateway.pid` 的 pid 用本进程
 * （只读探针，绝不会真去 kill 自己：所有 terminate 都是注入的假实现）。
 */
async function writeNodePidRecord(dataDir: string, nodeId: string, startedAt: string) {
  const record = {
    pid: process.pid,
    started_at: startedAt,
    host: '127.0.0.1',
    port: 2000,
    version: '0.0.0-probe',
    node_id: nodeId,
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'gateway.pid'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function writeManifest(
  gatewayDataDir: string,
  children: SpawnedChildRecord[],
): Promise<void> {
  await mkdir(gatewayDataDir, { recursive: true });
  await writeFile(
    spawnedChildrenPath(gatewayDataDir),
    `${JSON.stringify({ v: 1, children }, null, 2)}\n`,
  );
}

/** ① handoff marker：命中条件 + 一次性消费。 */
async function probeMarker(): Promise<void> {
  console.log('handoff marker');
  const dataDir = await makeTmpDir('marker');
  try {
    await writeHandoffMarker(dataDir, undefined, process.pid);
    check(
      'write → 文件落在 <dataDir>/platform-handoff.json',
      (await readFile(handoffMarkerPath(dataDir), 'utf8')).includes('platform_pid'),
    );
    check('pid 命中且未过期 → true', (await consumeHandoffMarker(dataDir, undefined, process.pid)));
    check(
      '消费一次后失效（不会二次生效）',
      !(await consumeHandoffMarker(dataDir, undefined, process.pid)),
    );

    await writeHandoffMarker(dataDir, undefined, process.pid + 1);
    check(
      'pid 不匹配（不是给这个进程的）→ false',
      !(await consumeHandoffMarker(dataDir, undefined, process.pid)),
    );
    check(
      '不匹配也要删掉，避免留给下一次 shutdown 误命中',
      !(await readFile(handoffMarkerPath(dataDir), 'utf8')
        .then(() => true)
        .catch(() => false)),
    );

    await writeHandoffMarker(dataDir, undefined, process.pid, Date.now() - HANDOFF_MARKER_TTL_MS - 1);
    check(
      '过期 marker → false（退化成 0.51 的「连 node 一起停」）',
      !(await consumeHandoffMarker(dataDir, undefined, process.pid)),
    );

    await writeFile(handoffMarkerPath(dataDir), '{not json');
    check(
      '损坏 marker → false 且不抛',
      !(await consumeHandoffMarker(dataDir, undefined, process.pid)),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** ② manifest 级 keep：`gateway restart`/`stop --keep-nodes` 走的就是这条路径。 */
async function probeStopSpawnedChildren(): Promise<void> {
  console.log('stopSpawnedChildren（跨进程清理路径）');
  const gatewayDataDir = await makeTmpDir('children');
  const nodeDataDir = path.join(gatewayDataDir, 'node-a');
  try {
    const startedAt = new Date().toISOString();
    await writeNodePidRecord(nodeDataDir, 'node-a', startedAt);
    const child: SpawnedChildRecord = {
      node_id: 'node-a',
      name: 'a',
      pid: process.pid,
      data_dir: nodeDataDir,
      started_at: startedAt,
      kind: 'node',
    };
    await writeManifest(gatewayDataDir, [child]);

    let terminateCalls = 0;
    const keptResult = await stopSpawnedChildren({
      gatewayDataDir,
      terminate: async () => {
        terminateCalls += 1;
        return true;
      },
      runCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
      sleep: async () => undefined,
    });
    check('keep 缺省 = 真停：terminate 被调用一次', terminateCalls === 1, `calls=${terminateCalls}`);
    check('真停 stopped = 1', keptResult.stopped === 1, JSON.stringify(keptResult));
    check('真停后 manifest 被清掉', (await readSpawnedChildren(gatewayDataDir)).length === 0);

    await writeManifest(gatewayDataDir, [child]);
    terminateCalls = 0;
    const keepResult = await stopSpawnedChildren({
      gatewayDataDir,
      keep: true,
      terminate: async () => {
        terminateCalls += 1;
        return true;
      },
      runCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
      sleep: async () => undefined,
    });
    check('keep: true → terminate 一次都不调用', terminateCalls === 0, `calls=${terminateCalls}`);
    check('kept.nodes = 1', keepResult.kept?.nodes === 1, JSON.stringify(keepResult.kept));
    check('kept.hubs = 0', keepResult.kept?.hubs === 0, JSON.stringify(keepResult.kept));
    check('keep 不动 manifest（后续真停还能据此找到它们）',
      (await readSpawnedChildren(gatewayDataDir)).length === 1);
  } finally {
    await rm(gatewayDataDir, { recursive: true, force: true });
  }
}

/**
 * ③ supervisor 级 keep：旧平台收到 SIGTERM 后走的就是 `supervisor.stop()`。
 * 这里只塞「就绪前条目」（`started_at` 空 = 本进程内存态），避免起真 node/HTTP；
 * 与 `NodeSupervisor.spawn()` 内部先登记的方式一致，`stop()` 对这类条目按 pid 活性判定，
 * 所以用本进程 pid 表示「活着」。
 */
async function probeSupervisorStop(): Promise<void> {
  console.log('NodeSupervisor.stop');
  const gatewayDataDir = await makeTmpDir('supervisor');
  try {
    const nodeDataDir = path.join(gatewayDataDir, 'node-a');
    const hubDataDir = path.join(gatewayDataDir, 'hub');
    const entries: SpawnedChildRecord[] = [
      { node_id: 'node-a', name: 'a', pid: process.pid, data_dir: nodeDataDir, started_at: '' },
      {
        node_id: 'hub',
        name: 'hub',
        pid: process.pid,
        data_dir: hubDataDir,
        started_at: '',
        kind: 'hub',
      },
    ];
    const buildSupervisor = (onTerminate: (pid: number) => void) => {
      const supervisor = new NodeSupervisor({
        gatewayDataDir,
        terminate: async (pid: number) => {
          onTerminate(pid);
          return true;
        },
        sleep: async () => undefined,
      });
      // 最薄的 fake：直接登记两条子进程记录（private 字段，仅探针内可见）。
      (
        supervisor as unknown as { spawned: SpawnedChildRecord[] }
      ).spawned.push(...entries);
      return supervisor;
    };

    const keepCalls: number[] = [];
    // keep 必须连 manifest 都不动（盘上条目仍准确描述活着的进程；后续真停还要用它）。
    await writeManifest(gatewayDataDir, entries);
    const manifestBefore = await readFile(spawnedChildrenPath(gatewayDataDir), 'utf8');
    const keepResult = await buildSupervisor((pid) => keepCalls.push(pid)).stop({ keep: true });
    check('keep: true → 不终止任何子进程', keepCalls.length === 0, `calls=${keepCalls.length}`);
    check('kept.nodes = 1', keepResult.kept?.nodes === 1, JSON.stringify(keepResult.kept));
    check('kept.hubs = 1（hub 一起保活，避免断连重连）', keepResult.kept?.hubs === 1);
    check(
      'keep 不重写/不删除 manifest',
      (await readFile(spawnedChildrenPath(gatewayDataDir), 'utf8')) === manifestBefore,
    );

    const killCalls: number[] = [];
    await buildSupervisor((pid) => killCalls.push(pid)).stop();
    check('keep 缺省 → 照旧终止两个子进程', killCalls.length === 2, `calls=${killCalls.length}`);
    check(
      '真停后 manifest 清空',
      (await readSpawnedChildren(gatewayDataDir)).length === 0,
    );
  } finally {
    await rm(gatewayDataDir, { recursive: true, force: true });
  }
}

/** ④ 接线：CLI 参数解析 + `gateway-command.ts` 的 keep 传参（源码级）。 */
async function probeWiring(): Promise<void> {
  console.log('接线');
  const restart = parseArgs(['gateway', 'restart']);
  check(
    '`gateway restart` → 缺省 handoff（keepNodes 未显式关闭）',
    restart.ok && restart.args.gateway?.kind === 'restart' && restart.args.gateway.keepNodes !== false,
    JSON.stringify(restart.ok ? restart.args.gateway : restart),
  );
  const cold = parseArgs(['gateway', 'restart', '--no-keep-nodes']);
  check(
    '`gateway restart --no-keep-nodes` → 冷重启',
    cold.ok && cold.args.gateway?.kind === 'restart' && cold.args.gateway.keepNodes === false,
    JSON.stringify(cold.ok ? cold.args.gateway : cold),
  );
  const stop = parseArgs(['gateway', 'stop']);
  check(
    '`gateway stop` → **不**带 keep（真停）',
    stop.ok && stop.args.gateway?.kind === 'stop' && stop.args.gateway.keepNodes !== true,
    JSON.stringify(stop.ok ? stop.args.gateway : stop),
  );
  const stopKeep = parseArgs(['gateway', 'stop', '--keep-nodes']);
  check(
    '`gateway stop --keep-nodes` → 显式 keep',
    stopKeep.ok && stopKeep.args.gateway?.kind === 'stop' && stopKeep.args.gateway.keepNodes === true,
    JSON.stringify(stopKeep.ok ? stopKeep.args.gateway : stopKeep),
  );

  const source = await readFile(path.join(import.meta.dir, '..', 'src', 'gateway-command.ts'), 'utf8');
  const countOf = (needle: string): number => source.split(needle).length - 1;
  check(
    '两条 restart 路径都传 keep（daemon + 前台）：keepNodes: command.keepNodes !== false 出现 2 次',
    countOf('keepNodes: command.keepNodes !== false') === 2,
    `count=${countOf('keepNodes: command.keepNodes !== false')}`,
  );
  check(
    '`case stop` 只在 keepNodes === true 时传 keep（不顺手改真停）',
    /case 'stop':[\s\S]{0,400}?command\.keepNodes === true/.test(source),
  );
  check(
    '旧平台 shutdown 先消费 handoff marker',
    source.includes('consumeHandoffMarker(dataDir, instance, process.pid)'),
  );
  check(
    '旧平台 shutdown 命中 handoff 时 stop({ keep: true })',
    source.includes('supervisor.stop({ keep: true })'),
  );
  check(
    'finally 回滚不得把 keep 掉的子进程再停一遍',
    source.includes('supervisor?.stop(handoffKept ? { keep: true } : undefined)'),
  );
  check(
    'handoff 时会打「kept N node(s) alive for handoff」日志',
    source.includes("t('gateway.stopKeptNodes'"),
  );
}

async function main(): Promise<void> {
  await probeMarker();
  await probeStopSpawnedChildren();
  await probeSupervisorStop();
  await probeWiring();
  console.log('');
  if (failures.length === 0) {
    console.log(`check:node-handoff ok (${checks} checks)`);
    return;
  }
  console.error(`check:node-handoff FAILED (${failures.length}/${checks})`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

await main();

