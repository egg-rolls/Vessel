/**
 * @vessel-agent/plugin-skills — RPC 管理面
 * @module @vessel-agent/skills/rpc
 *
 * 设计 §7：canonical 名 `plugin.skills.<name>`（宿主补前缀）；in-process handler
 * 即 Plugin.rpc，与 child 共用 DTO 校验。权限列是 gateway 调用方权限（read/write）。
 *
 * 契约纪律：DTO additive（result 字段只增不改）；错误码复用宿主闭集，业务错误
 * （unknown id / oversize / revoked）在 result 里带 `error: {code, message}`。
 * **get 与 load 的边界**（§9.5）：get 是人类面——返回内容给 UI 预览，不写 loads、
 * 不做信任门、不触发 TOFU；load（工具）才进语言空间。
 */

import type { SkillsService } from './service.js';
import { capContent, compareForList, searchRank } from './tool.js';
import { originOfSource, pinTrustRecord, revokeTrustRecord, trustStateOf } from './trust.js';
import {
  MAX_PAGE_LIMIT,
  type SkillEntry,
  type SkillSource,
  type TrustRecord,
  type TrustState,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidParams(message: string): Error {
  return new Error(`invalid_params: ${message}`);
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidParams(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidParams(`${key} must be a non-empty string when set`);
  }
  return value;
}

function optionalCount(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidParams(`${key} must be a finite number when set`);
  }
  return Math.max(0, Math.floor(value));
}

function optionalSource(params: Record<string, unknown>): SkillSource | undefined {
  const value = params.source;
  if (value === undefined) return undefined;
  if (value !== 'project' && value !== 'user' && value !== 'library') {
    throw invalidParams('source must be project | user | library');
  }
  return value;
}

/** 业务错误结构（不发明新信封 code） */
function businessError(
  code: string,
  message: string,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** 条目 + 派生信任态（徽标服务端算，前端只消费；DTO additive） */
function itemWithTrust(
  service: SkillsService,
  entry: SkillEntry,
): SkillEntry & { trust: TrustState } {
  return { ...entry, trust: service.trustState(entry) };
}

/** list：索引快照分页；query 存在时同 search 排序口径 */
async function handleList(
  service: SkillsService,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await service.ready();
  const source = optionalSource(params);
  const tag = optionalString(params, 'tag');
  const query = optionalString(params, 'query');
  const offset = optionalCount(params, 'offset') ?? 0;
  const limit = Math.min(optionalCount(params, 'limit') ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);

  let entries = [...service.getIndex().entries];
  if (source !== undefined) entries = entries.filter((entry) => entry.source === source);
  if (tag !== undefined) {
    const needle = tag.toLowerCase();
    entries = entries.filter((entry) => entry.tags.some((item) => item.toLowerCase() === needle));
  }
  if (query !== undefined) {
    const needle = query.toLowerCase();
    const hits: Array<{ entry: SkillEntry; rank: number }> = [];
    for (const entry of entries) {
      const hit = searchRank(entry, needle);
      if (hit !== undefined) hits.push({ entry, rank: hit.rank });
    }
    hits.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return compareForList(a.entry, b.entry);
    });
    entries = hits.map((hit) => hit.entry);
  } else {
    entries.sort(compareForList);
  }
  const total = entries.length;
  const page = entries.slice(offset, offset + limit);
  return {
    items: page.map((entry) => itemWithTrust(service, entry)),
    total,
    generatedAt: service.getIndex().generatedAt,
  };
}

/** get：详情（人类面）——content 截断至 max_load_bytes；不写 loads、不做信任门 */
async function handleGet(
  service: SkillsService,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await service.ready();
  const id = requireString(params, 'id');
  const entry = service.entryById(id);
  if (entry === undefined) {
    return businessError('unknown_id', `unknown skill id "${id}" (use list/search)`);
  }
  const trustRecord = service.getTrustStore().skills[id];
  const fresh = await service.readSkillFile(entry);
  if (!fresh.ok) {
    return {
      entry,
      content: '',
      auxFiles: entry.auxFiles ?? [],
      trust: service.trustState(entry),
      ...(trustRecord !== undefined ? { trustRecord } : {}),
      ...businessError(
        fresh.error,
        fresh.error === 'oversize'
          ? `"${id}" is oversize (${fresh.bytes} bytes); preview unavailable`
          : `cannot read "${id}": ${fresh.message}`,
      ),
    };
  }
  const current: SkillEntry = {
    ...entry,
    sha256: fresh.sha256,
    bytes: fresh.bytes,
    mtimeMs: fresh.mtimeMs,
  };
  const { text, truncated } = capContent(fresh.content, service.config.maxLoadBytes);
  return {
    entry: current,
    content: text,
    auxFiles: entry.auxFiles ?? [],
    trust: trustStateOf(current, service.getTrustStore()),
    ...(trustRecord !== undefined ? { trustRecord } : {}),
    truncated,
  };
}

/** search：同工具 search 的排序口径 */
async function handleSearch(
  service: SkillsService,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await service.ready();
  const query = requireString(params, 'query');
  const limit = Math.min(optionalCount(params, 'limit') ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const needle = query.toLowerCase();
  const hits: Array<{ entry: SkillEntry; rank: number }> = [];
  for (const entry of service.getIndex().entries) {
    const hit = searchRank(entry, needle);
    if (hit !== undefined) hits.push({ entry, rank: hit.rank });
  }
  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return compareForList(a.entry, b.entry);
  });
  return {
    items: hits.slice(0, limit).map((hit) => itemWithTrust(service, hit.entry)),
    total: hits.length,
  };
}

/** loads：缺省全部会话（上限 100）；给 session_id 则单会话 */
async function handleLoads(
  service: SkillsService,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await service.ready();
  const sessionId = optionalString(params, 'session_id');
  if (sessionId !== undefined) {
    return { sessions: [await service.store.readLoads(sessionId)] };
  }
  return { sessions: await service.store.listLoads() };
}

/** rescan：手动全量重建索引（watch 失效 / 网络盘兜底） */
async function handleRescan(service: SkillsService): Promise<Record<string, unknown>> {
  await service.ready();
  const result = await service.rescan();
  return { ...result };
}

/** trust_set：trust = 钉住当前哈希（重新确认）；revoke = 置 revoked。UI 信任面板唯一写口 */
async function handleTrustSet(
  service: SkillsService,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await service.ready();
  const id = requireString(params, 'id');
  const action = requireString(params, 'action');
  if (action !== 'trust' && action !== 'revoke') {
    throw invalidParams('action must be trust | revoke');
  }
  const entry = service.entryById(id);
  if (entry === undefined) {
    return businessError('unknown_id', `unknown skill id "${id}" (use list/search)`);
  }
  const previous = service.getTrustStore().skills[id];
  const fresh = await service.readSkillFile(entry);
  if (action === 'trust') {
    if (!fresh.ok) {
      return businessError(
        fresh.error,
        fresh.error === 'oversize'
          ? `"${id}" is oversize (${fresh.bytes} bytes); cannot pin a hash`
          : `cannot read "${id}": ${fresh.message}`,
      );
    }
    const origin = previous?.origin ?? originOfSource(entry.source);
    const record = pinTrustRecord(fresh.sha256, origin);
    await service.putTrustRecord(id, record);
    return { id, trust: 'trusted' satisfies TrustState, record };
  }
  const record: TrustRecord = revokeTrustRecord(previous, fresh.ok ? fresh.sha256 : '');
  await service.putTrustRecord(id, record);
  return { id, trust: 'revoked' satisfies TrustState, record };
}

/** RPC dispatch（Plugin.rpc 形状；装配层 registerInProcessPlugin 登记） */
export async function dispatchSkillsRpc(
  name: string,
  params: Record<string, unknown>,
  service: SkillsService,
): Promise<unknown> {
  const safe = isRecord(params) ? params : {};
  switch (name) {
    case 'list':
      return handleList(service, safe);
    case 'get':
      return handleGet(service, safe);
    case 'search':
      return handleSearch(service, safe);
    case 'loads':
      return handleLoads(service, safe);
    case 'rescan':
      return handleRescan(service);
    case 'trust_set':
      return handleTrustSet(service, safe);
    default:
      throw new Error(`unknown_method: ${name}`);
  }
}
