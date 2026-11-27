/**
 * @vessel-agent/doc-subscription - health 源观察（q-health-subscription）
 * @module @vessel-agent/doc-subscription/health
 *
 * 订阅源泛化的 health 侧**读端**：宿主侧 node-health-watch（src/runtime/node-health-watch.ts）
 * 周期探测被订阅 node 的 /health（本机 node 走注册表 + 监听解析；远程联邦走 peer 凭据），
 * 把快照原子写到 `<stateDir>/health/<encodeURIComponent(target)>.json`；本模块只读快照、
 * 算变化签名 —— 与 recall 读会话壳同口径（插件读宿主落盘的事实文件，不 import 宿主模块）。
 *
 * 为什么探测在宿主侧：node 在哪里（nodes.json 注册表 / node 配置端口 / 活进程 gateway.pid
 * 记录）与远程凭据（federation.peers 的 token_env / token_secret）都是宿主知识；插件包
 * 不 import src/，也不该复制第二套配置解析（plugin-config.ts 同口径裁定）。
 *
 * 变化签名（rev）：`down` / `up:<version>:<started_at>:<node_id>`。
 * - reachable 翻转（up↔down）⇒ 签名变 ⇒ 通知；
 * - 版本变更 / started_at 变（重启）⇒ 签名变 ⇒ 通知；
 * - checked_at **不**进签名（每次探测都刷新，进签名会每 run 误报）。
 * 快照缺失（watcher 尚未探测 / 未装配）⇒ 无观察，游标不动（与文件读失败同语义）。
 *
 * 目标语法（字面量副本；生产侧真相在 src/federation/federation-address.ts 与
 * src/gateway/node-registry.ts 的 NODE_ID_RE，改任一侧人工对拍）：
 * - 本机 node_id：`[A-Za-z0-9_-]{1,64}`；
 * - 远程联邦地址：`<principal>@<node_id>:<team_id>`（三段）。
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/** 宿主写入的 node 健康快照（防御解析；未知键忽略） */
export interface HealthSnapshot {
  v: 1;
  /** 订阅目标（node_id 或联邦地址） */
  target: string;
  /** 可达性（探测成功且非 platform 监听 = true） */
  reachable: boolean;
  /** 健康回包自报的 node_id（身份核对用；缺省 = 未知） */
  node_id?: string;
  /** node 展示名 */
  name?: string;
  /** 应用版本（可 authenticated 读到时才有） */
  version?: string;
  /** node 进程启动时间（Unix ms；重启检测主键） */
  started_at?: number;
  /** node 进程 pid（诊断用） */
  pid?: number;
  /** 最近一次探测时间（Unix ms；**不**进变化签名） */
  checked_at: number;
  /** 探测途径（诊断用） */
  via?: 'local' | 'federation';
  /** 探测失败 / 身份不符等原因码（诊断用；reachable=false 时可有） */
  error?: string;
}

/** 本机 node_id 语法（node-registry NODE_ID_RE 的字面量副本） */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 联邦地址三段语法（federation-address.ts 的字面量副本；principal 允许 human 保留值） */
const FEDERATION_ADDRESS_RE = /^[A-Za-z0-9_-]{1,64}@[A-Za-z0-9_-]{1,64}:[a-z0-9][a-z0-9-]{0,63}$/;

/** 目标是否合法（本机 node_id 或三段联邦地址） */
export function isValidHealthTarget(target: string): boolean {
  return NODE_ID_RE.test(target) || FEDERATION_ADDRESS_RE.test(target);
}

/** 从联邦地址取 node_id 段；非联邦地址返回 undefined */
export function healthTargetNodeId(target: string): string | undefined {
  if (NODE_ID_RE.test(target)) return target;
  const match = FEDERATION_ADDRESS_RE.exec(target);
  if (match === null) return undefined;
  return target.slice(target.lastIndexOf('@') + 1).split(':')[0];
}

/** health 条目的状态键（与文件条目的 canonicalPath 键空间隔离） */
export function healthSubscriptionKey(target: string): string {
  return `health:${target}`;
}

/** 快照文件路径（与宿主 node-health-watch 的写端逐字同口径） */
export function healthSnapshotPath(stateDir: string, target: string): string {
  return path.join(stateDir, 'health', `${encodeURIComponent(target)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 读快照；ENOENT / JSON 损坏 / 结构非法 ⇒ undefined（无观察，游标不动）。
 * 只认 v=1 且 target 逐字相符的快照（防键漂移）。
 */
export async function readHealthSnapshot(
  stateDir: string,
  target: string,
): Promise<HealthSnapshot | undefined> {
  let raw: string;
  try {
    raw = await readFile(healthSnapshotPath(stateDir, target), 'utf-8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.target !== target) return undefined;
  if (typeof parsed.reachable !== 'boolean') return undefined;
  const snapshot: HealthSnapshot = {
    v: 1,
    target,
    reachable: parsed.reachable,
    checked_at: optionalNumber(parsed, 'checked_at') ?? 0,
  };
  const nodeId = optionalString(parsed, 'node_id');
  if (nodeId !== undefined) snapshot.node_id = nodeId;
  const name = optionalString(parsed, 'name');
  if (name !== undefined) snapshot.name = name;
  const version = optionalString(parsed, 'version');
  if (version !== undefined) snapshot.version = version;
  const startedAt = optionalNumber(parsed, 'started_at');
  if (startedAt !== undefined) snapshot.started_at = startedAt;
  const pid = optionalNumber(parsed, 'pid');
  if (pid !== undefined) snapshot.pid = pid;
  const via = parsed.via;
  if (via === 'local' || via === 'federation') snapshot.via = via;
  const error = optionalString(parsed, 'error');
  if (error !== undefined) snapshot.error = error;
  return snapshot;
}

/**
 * 变化签名（SubscriptionEntry.rev 口径）：reachable 翻转 / 版本 / started_at / node_id
 * 任一变化 ⇒ 签名变。checked_at 不进签名。缺省字段以 `-` 占位（未知 ≠ 已知值）。
 */
export function healthSignature(snapshot: HealthSnapshot): string {
  if (!snapshot.reachable) return 'down';
  const version = snapshot.version ?? '-';
  const startedAt = snapshot.started_at !== undefined ? String(snapshot.started_at) : '-';
  const nodeId = snapshot.node_id ?? '-';
  return `up:${version}:${startedAt}:${nodeId}`;
}

/** 签名的短展示形态（list / inspect 用；与文件 rev 的 sha256:… 展示同族） */
export function describeHealthRev(rev: string): string {
  if (rev === '') return 'never';
  if (rev === 'down') return 'down';
  if (rev.startsWith('up:')) {
    const [, version, startedAt] = rev.split(':');
    const started = startedAt !== undefined && startedAt !== '-' ? startedAt : '?';
    return `up(v${version ?? '?'},started:${started})`;
  }
  return rev;
}
