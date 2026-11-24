/**
 * @vessel-agent/plugin-skills — `skills` 工具（list / search / load）
 * @module @vessel-agent/skills/tool
 *
 * 设计 §6：单工具三动作，全部只读（写技能 = write/edit 改文件，不注册 CRUD）。
 * 描述纪律照 recall：开头一句把「不是读文件」讲死；只描述事实。
 * 渐进披露：list/search 只回元数据行，全文只在显式 load 时进上下文。
 *
 * 信任门（§6.4）：checkPermission 无副作用——load 重读文件校哈希派生信任态，
 * trusted allow / unknown+stale ask（trust_default=deny 时 deny）/ revoked deny；
 * TOFU 钉锁在用户批准之后的 handler 内。ask 被拒的文案由 core PermissionPolicy
 * 统一产出（「… by user (the tool's own permission check asked for confirmation)」）。
 */

import type { ToolContext, ToolDefinition } from '@vessel-agent/core';
import type { SkillsService } from './service.js';
import { loadGateDecision, originOfSource, pinTrustRecord, trustStateOf } from './trust.js';
import {
  LIST_DESCRIPTION_CHARS,
  MAX_PAGE_LIMIT,
  MAX_SKILL_FILE_BYTES,
  type SkillEntry,
  type SkillSource,
  type TrustState,
} from './types.js';

/** 工具描述（设计 §6.2 逐字；只描述事实） */
export const SKILLS_TOOL_DESCRIPTION =
  'Browse and load the managed skill library (project skills/, user ~/.vessel/skills/, ' +
  'and the collected library) - NOT a file reader: ids come from list/search, not paths. ' +
  'action=list: one metadata line per skill (id · name · source · trust · description), ' +
  'paged (limit ≤ 50), filter by source/tag. action=search: substring over name / ' +
  'description / tags / id, best matches first. action=load: return the full skill ' +
  'content by id (≤ 64 KiB, truncated with a notice) plus its auxiliary file list; ' +
  'untrusted or changed content asks the user for confirmation first.';

/** 解析后的工具入参 */
export interface SkillsArgs {
  action: 'list' | 'search' | 'load';
  query?: string;
  id?: string;
  source?: SkillSource;
  tag?: string;
  offset: number;
  limit: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 入参解析（非法值回事实性错误线，不抛异常） */
export function parseSkillsArgs(raw: unknown): SkillsArgs | string {
  const record = isRecord(raw) ? raw : {};
  const action = record.action ?? 'list';
  if (action !== 'list' && action !== 'search' && action !== 'load') {
    return 'skills: action must be list | search | load';
  }
  const query = typeof record.query === 'string' && record.query !== '' ? record.query : undefined;
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : undefined;
  if (action === 'search' && query === undefined) {
    return 'skills: search requires a non-empty query';
  }
  if (action === 'load' && id === undefined) {
    return 'skills: load requires an id (from list/search)';
  }
  const sourceRaw = record.source;
  if (
    sourceRaw !== undefined &&
    sourceRaw !== 'project' &&
    sourceRaw !== 'user' &&
    sourceRaw !== 'library'
  ) {
    return 'skills: source must be project | user | library';
  }
  const tag = typeof record.tag === 'string' && record.tag !== '' ? record.tag : undefined;
  const readCount = (key: string, fallback: number): number | string => {
    const value = record[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `skills: ${key} must be a finite number`;
    }
    return Math.max(0, Math.floor(value));
  };
  const offset = readCount('offset', 0);
  if (typeof offset === 'string') return offset;
  const limitRaw = readCount('limit', MAX_PAGE_LIMIT);
  if (typeof limitRaw === 'string') return limitRaw;
  const limit = Math.min(Math.max(1, limitRaw), MAX_PAGE_LIMIT);
  return {
    action,
    ...(query !== undefined ? { query } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(sourceRaw !== undefined ? { source: sourceRaw as SkillSource } : {}),
    ...(tag !== undefined ? { tag } : {}),
    offset,
    limit,
  };
}

/** list 确定性排序：source 优先级 project > user > library，同源按 id */
const SOURCE_ORDER: Record<SkillSource, number> = { project: 0, user: 1, library: 2 };

function compareForList(a: SkillEntry, b: SkillEntry): number {
  const bySource = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  if (bySource !== 0) return bySource;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** search 命中等级：name > tag > description > id；未命中 undefined */
function searchRank(
  entry: SkillEntry,
  needle: string,
): { rank: number; field: string } | undefined {
  if (entry.name.toLowerCase().includes(needle)) return { rank: 0, field: 'name' };
  if (entry.tags.some((tag) => tag.toLowerCase().includes(needle))) {
    return { rank: 1, field: 'tag' };
  }
  if (entry.description.toLowerCase().includes(needle)) return { rank: 2, field: 'description' };
  if (entry.id.toLowerCase().includes(needle)) return { rank: 3, field: 'id' };
  return undefined;
}

/** 单行元数据（设计 §6.3 线格式；description 截断 120 字符） */
function formatLine(entry: SkillEntry, trust: TrustState, matchField?: string): string {
  const description =
    entry.description.length > LIST_DESCRIPTION_CHARS
      ? `${entry.description.slice(0, LIST_DESCRIPTION_CHARS)}…`
      : entry.description;
  const match = matchField !== undefined ? ` · match: ${matchField}` : '';
  return `${entry.id} · ${entry.name} · ${entry.source} · ${trust} · ${description}${match}`;
}

/** 分页脚注 */
function pageFooter(total: number, offset: number, shown: number): string {
  if (total === 0 || shown === 0) return '';
  return `(total ${total}, showing ${offset + 1}–${offset + shown}; use offset/limit to page)`;
}

function handleList(service: SkillsService, args: SkillsArgs): string {
  let entries = [...service.getIndex().entries];
  if (args.source !== undefined) entries = entries.filter((entry) => entry.source === args.source);
  if (args.tag !== undefined) {
    const tag = args.tag.toLowerCase();
    entries = entries.filter((entry) => entry.tags.some((item) => item.toLowerCase() === tag));
  }
  entries.sort(compareForList);
  const total = entries.length;
  if (total === 0) {
    return 'skills: no skills indexed (put markdown into skills/ or ~/.vessel/skills/, or import into the collected library)';
  }
  const page = entries.slice(args.offset, args.offset + args.limit);
  const lines = page.map((entry) => formatLine(entry, service.trustState(entry)));
  const footer = pageFooter(total, args.offset, page.length);
  return footer === '' ? lines.join('\n') : `${lines.join('\n')}\n${footer}`;
}

function handleSearch(service: SkillsService, args: SkillsArgs): string {
  const query = args.query ?? '';
  const needle = query.toLowerCase();
  const hits: Array<{ entry: SkillEntry; rank: number; field: string }> = [];
  for (const entry of service.getIndex().entries) {
    const hit = searchRank(entry, needle);
    if (hit !== undefined) hits.push({ entry, ...hit });
  }
  if (hits.length === 0) {
    return `skills: no skills match "${query}" (use action=list to browse)`;
  }
  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });
  const total = hits.length;
  const page = hits.slice(args.offset, args.offset + args.limit);
  const lines = page.map((hit) => formatLine(hit.entry, service.trustState(hit.entry), hit.field));
  const footer = pageFooter(total, args.offset, page.length);
  return footer === '' ? lines.join('\n') : `${lines.join('\n')}\n${footer}`;
}

/** 按字节上限截断（收尾的多字节替换符剥掉，不切出坏字符） */
function capContent(content: string, cap: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(content, 'utf-8') <= cap) return { text: content, truncated: false };
  const text = Buffer.from(content, 'utf-8')
    .subarray(0, cap)
    .toString('utf-8')
    .replace(/\uFFFD+$/, '');
  return { text, truncated: true };
}

/**
 * load：信任门 → 内容进语言空间 + 记加载态（设计 §6.3/§6.4/§9.5）。
 * 门判定与 checkPermission 同一口径（重读重算）；ask 已由管道在 handler 前
 * 取得用户批准——unknown/stale 在此钉锁（TOFU），不自动更新 stale 锁之外的任何态。
 */
async function handleLoad(
  service: SkillsService,
  args: SkillsArgs,
  ctx: ToolContext,
): Promise<string> {
  const id = args.id ?? '';
  const entry = service.entryById(id);
  if (entry === undefined) {
    return `skills: unknown id "${id}" (use list/search)`;
  }
  const fresh = await service.readSkillFile(entry);
  if (!fresh.ok) {
    if (fresh.error === 'oversize') {
      return `skills: "${id}" is oversize (${fresh.bytes} bytes > ${MAX_SKILL_FILE_BYTES} cap); list-only, cannot load`;
    }
    return `skills: cannot read "${id}": ${fresh.message}`;
  }
  const current: SkillEntry = {
    ...entry,
    sha256: fresh.sha256,
    bytes: fresh.bytes,
    mtimeMs: fresh.mtimeMs,
  };
  const state = trustStateOf(current, service.getTrustStore());
  const gate = loadGateDecision(state, service.config.trustDefault);
  if (gate === 'deny') {
    return state === 'revoked'
      ? `skills: trust revoked for "${id}"; load denied by the trust gate (re-trust via the skills UI)`
      : `skills: load denied for "${id}" by the trust gate (trust_default=deny; content is ${state})`;
  }
  if (state === 'unknown' || state === 'stale') {
    // TOFU：用户批准后钉住当前哈希；已有记录保留其 origin（marketplace 不自动提升）
    const previous = service.getTrustStore().skills[id];
    const origin = previous?.origin ?? originOfSource(entry.source);
    await service.putTrustRecord(id, pinTrustRecord(fresh.sha256, origin));
  }

  const cap = service.config.maxLoadBytes;
  const { text, truncated } = capContent(fresh.content, cap);
  const lines = [
    `<skill id="${entry.id}" source="${entry.source}" path="${entry.absPath}" trust="trusted">`,
    text,
    '</skill>',
  ];
  if (entry.auxFiles !== undefined && entry.auxFiles.length > 0) {
    lines.push('auxiliary files (read them with the read tool if needed):');
    for (const aux of entry.auxFiles) lines.push(`  ${aux}`);
  }
  if (truncated) {
    lines.push(`(truncated: content exceeded ${cap} bytes; original ${fresh.bytes} bytes)`);
  }

  // 加载态是审计元数据：写失败只告警，不阻塞内容返回
  if (typeof ctx.session_id === 'string' && ctx.session_id !== '') {
    try {
      await service.store.appendLoad(ctx.session_id, {
        id,
        sha256: fresh.sha256,
        loadedAt: new Date().toISOString(),
        runId: ctx.run_id,
      });
    } catch (error) {
      console.warn(
        `[skills] loads write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // 索引时效更新（缓存口径；失败只告警）
  await service.updateEntry(current);
  return lines.join('\n');
}

/** 构造 `skills` 工具（service 在安装期钉死） */
export function createSkillsTool(service: SkillsService): ToolDefinition {
  return {
    name: 'skills',
    description: SKILLS_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'load'],
          description: 'Default list',
        },
        query: { type: 'string', description: 'search: substring to match (required for search)' },
        id: { type: 'string', description: 'load: skill id from list/search (required for load)' },
        source: {
          type: 'string',
          enum: ['project', 'user', 'library'],
          description: 'list: only this source',
        },
        tag: { type: 'string', description: 'list: only skills carrying this tag' },
        offset: { type: 'number', description: 'list/search: skip this many rows' },
        limit: { type: 'number', description: 'list/search: max rows (capped at 50)' },
      },
    },
    display: { label: 'Skills', kind: 'search' },
    // 信任门（§6.4）：list/search 只读元数据恒 allow；load 按信任态判定。
    // 无副作用：不钉锁、不写 loads——TOFU 在用户批准后的 handler 内。
    checkPermission: async (input) => {
      if (!isRecord(input)) return 'allow';
      const action = input.action ?? 'list';
      if (action !== 'load') return 'allow';
      const id = typeof input.id === 'string' ? input.id : '';
      if (id === '') return 'allow'; // handler 报缺 id
      await service.ready();
      const entry = service.entryById(id);
      if (entry === undefined) return 'allow'; // handler 报 unknown id
      const fresh = await service.readSkillFile(entry);
      if (!fresh.ok) return 'allow'; // handler 报 oversize / unreadable
      const state = trustStateOf({ ...entry, sha256: fresh.sha256 }, service.getTrustStore());
      return loadGateDecision(state, service.config.trustDefault);
    },
    handler: async (args, ctx) => {
      await service.ready();
      const parsed = parseSkillsArgs(args);
      if (typeof parsed === 'string') return parsed;
      switch (parsed.action) {
        case 'list':
          return handleList(service, parsed);
        case 'search':
          return handleSearch(service, parsed);
        case 'load':
          return handleLoad(service, parsed, ctx);
      }
    },
  };
}
