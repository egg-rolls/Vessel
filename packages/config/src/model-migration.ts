/**
 * models 块一次性迁移（两面重构 §7，H7 首载自动）。
 *
 * vendors/aliases → credentials + entries：loader 首载钩子触发（withConfigLock 内；
 * 已在锁内则原地执行免嵌套）。幂等：vendors/aliases 不存在 → no-op。
 * 顺序：yaml 先（.bak + 预校验 + 原子写）→ 凭证值重加密复制 → agent pin 改写 → 报告。
 * 失败语义：yaml 写失败 → fail-fast（.bak 完好，不半写）；旧值不可解密（D10 轮换）→
 * 只建元数据 + 报告「需重录」，不阻断；pin 改写失败 → 报告 + doctor，不阻断启动。
 *
 * 映射规则（§7.2）：
 * - 凭证 cid = vendor.credential（沿用同 id，库值不动）否则 vid；base_url 缺省物化协议
 *   默认端点；同 cid 异端点 → 按 (baseUrl, apiKeyEnv) 拆分，异端点者 cid = vid + 值重加密复制。
 * - 条目键 = wire（全局唯一时）否则 vid/wire（旧 ref 原样可解析）；name = wire（键≠wire 时）。
 * - pricing.models 命中注册 wire 的键搬入 entry.pricing（键序首个）；未命中留顶层 + 报告。
 * - 多别名指向同一模型 → 字典序首个入 entry.alias，其余报告（H3 单值）。
 * - default 经映射表改写；agent store pin（v5 显式 pin）同批改写（§7.3）。
 *
 * @module @vessel-agent/config/model-migration
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { copyFile, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@vessel-agent/core';
import { isConfigLockHeld, withConfigLock } from './config-lock.js';
import { DEFAULT_DATA_DIR, defaultBaseUrlFor } from './defaults.js';
import { expandHomePath } from './env-file.js';
import { preserveConfigMapKeys, snakeToCamel } from './loader.js';
import { credentialToYaml, entryToYaml, pricingToYaml } from './models-disk.js';
import {
  DERIVED_TOKEN_PREFIX,
  derivePurposeToken,
  ensureRootSecret,
  ROOT_SECRET_BYTES,
  rootSecretPath,
} from './root-secret.js';
import type {
  ConfigValidationError,
  CredentialEntry,
  ModelEntry,
  ModelsConfig,
  PricingConfig,
} from './types.js';
import { readUserConfigRoot, writeUserConfigRoot } from './user-config.js';
import { validateModels } from './validator.js';

/** 旧 vendor 形状（仅迁移机器消费；注册面类型已删除，§7）。 */
interface LegacyVendorEntry {
  protocol: string;
  baseUrl?: string;
  credential?: string;
  apiKeyEnv?: string;
  models: Record<string, { promptCache?: boolean }>;
}

/** 迁移输入：旧 vendors/aliases [+ 既有新形状块]。 */
export interface LegacyModelsInput {
  default?: string;
  credentials?: Record<string, CredentialEntry>;
  entries?: Record<string, ModelEntry>;
  vendors?: Record<string, LegacyVendorEntry>;
  aliases?: Record<string, string>;
}

/** 迁移报告（§7.5）：落 `<dataDir>/model-registry-migration.json`；doctor / list 消费。 */
export interface MigrationReport {
  migratedAt: string;
  configPath: string;
  backupPath?: string;
  credentialsCreated: string[];
  /** 端点绑定冲突拆分：from = 原共享 cid，to = 新建 cid */
  credentialsSplit: Array<{ from: string; to: string }>;
  /** 拆分时旧值不可解密（D10）→ 只建元数据，需重录 */
  needsReRecord: string[];
  /** 无任何认证来源的凭证（解析期 fail-fast 提示录值） */
  danglingCredentials: string[];
  entriesCreated: string[];
  /** 多别名丢弃清单（H3）：kept = 保留的首个别称 */
  droppedAliases: Array<{ alias: string; target: string; kept?: string }>;
  /** 未命中注册 wire 的 pricing.models 键（留顶层兜底） */
  unmatchedPricing: string[];
  pinsRewritten: Array<{ file: string; member: string; from: string; to: string }>;
  pinsFailed: string[];
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 磁盘根对象是否含旧 models 块（vendors / aliases 键存在即触发，含空 map）。 */
export function hasLegacyModelsBlock(root: Record<string, unknown>): boolean {
  return (
    isRecord(root.models) &&
    (root.models.vendors !== undefined || root.models.aliases !== undefined)
  );
}

/** 迁移转换结果（纯函数部分；值复制 / pin 改写由编排层执行）。 */
export interface TransformResult {
  models: ModelsConfig;
  pricing: PricingConfig | undefined;
  /** 旧 ref（vid/wire）→ 新条目键 */
  refMap: Map<string, string>;
  /** 旧别称（含被丢弃的）→ 目标条目键（pin 改写用） */
  aliasMap: Map<string, string>;
  /** 拆分凭证的值复制清单（from → to） */
  valueCopies: Array<{ from: string; to: string }>;
  report: Omit<
    MigrationReport,
    'migratedAt' | 'configPath' | 'backupPath' | 'pinsRewritten' | 'pinsFailed'
  >;
}

/**
 * 纯转换：camelCase models（vendors/aliases [+ 既有 credentials/entries]）→ 两面形状。
 * 不触磁盘、不读密钥；语义校验在编排层写前执行。
 */
export function transformLegacyModels(
  models: LegacyModelsInput,
  pricing: PricingConfig | undefined,
): TransformResult {
  const credentials: Record<string, CredentialEntry> = { ...(models.credentials ?? {}) };
  const entries: Record<string, ModelEntry> = { ...(models.entries ?? {}) };
  const report: TransformResult['report'] = {
    credentialsCreated: [],
    credentialsSplit: [],
    needsReRecord: [],
    danglingCredentials: [],
    entriesCreated: [],
    droppedAliases: [],
    unmatchedPricing: [],
    errors: [],
  };
  const valueCopies: Array<{ from: string; to: string }> = [];
  const vendors = models.vendors ?? {};

  // wire 全局唯一性（跨 vendor + 不撞既有/新建条目键）。
  const wireCount = new Map<string, number>();
  for (const vendor of Object.values(vendors)) {
    for (const wire of Object.keys(vendor.models ?? {})) {
      wireCount.set(wire, (wireCount.get(wire) ?? 0) + 1);
    }
  }

  const refMap = new Map<string, string>();
  for (const [vid, vendor] of Object.entries(vendors)) {
    const baseUrl = vendor.baseUrl ?? defaultBaseUrlFor(vendor.protocol);
    if (baseUrl === undefined) {
      report.errors.push(
        `vendor "${vid}" uses custom protocol "${vendor.protocol}" without baseUrl; cannot materialize a credential endpoint (set models.credentials manually)`,
      );
    }
    // 凭证归属：沿用引用 id；端点/env 冲突 → 拆分新 cid = vid。
    let cid = vendor.credential ?? vid;
    const existing = credentials[cid];
    const conflicts =
      existing !== undefined &&
      (existing.baseUrl !== baseUrl || existing.apiKeyEnv !== vendor.apiKeyEnv);
    if (conflicts && cid !== vid) {
      const from = cid;
      cid = vid;
      report.credentialsSplit.push({ from, to: cid });
      if (vendor.credential !== undefined) valueCopies.push({ from, to: cid });
    }
    if (credentials[cid] === undefined) {
      credentials[cid] = {
        baseUrl: baseUrl ?? '',
        ...(vendor.apiKeyEnv !== undefined ? { apiKeyEnv: vendor.apiKeyEnv } : {}),
      };
      report.credentialsCreated.push(cid);
    }
    if (vendor.credential === undefined && vendor.apiKeyEnv === undefined) {
      report.danglingCredentials.push(cid);
    }
    // 模型条目。
    for (const [wire, modelEntry] of Object.entries(vendor.models ?? {})) {
      const unique =
        (wireCount.get(wire) ?? 0) === 1 &&
        !Object.hasOwn(entries, wire) &&
        !Object.hasOwn(models.entries ?? {}, wire);
      const key = unique ? wire : `${vid}/${wire}`;
      const entry: ModelEntry = {
        credential: cid,
        ...(key !== wire ? { name: wire } : {}),
        provider: vendor.protocol,
        ...(modelEntry.promptCache !== undefined
          ? { param: { promptCache: modelEntry.promptCache } }
          : {}),
      };
      entries[key] = entry;
      report.entriesCreated.push(key);
      refMap.set(`${vid}/${wire}`, key);
    }
  }

  // pricing.models 命中注册 wire → 搬入 entry.pricing（键序首个）；未命中留顶层。
  let nextPricing: PricingConfig | undefined = pricing;
  if (pricing !== undefined) {
    const remaining: PricingConfig['models'] = {};
    const moved = new Set<string>();
    for (const [wire, price] of Object.entries(pricing.models)) {
      const target = Object.keys(entries).find(
        (key) => (entries[key]?.name ?? key) === wire && entries[key]?.pricing === undefined,
      );
      if (target !== undefined && !moved.has(wire)) {
        entries[target] = { ...entries[target], pricing: price } as ModelEntry;
        moved.add(wire);
      } else {
        remaining[wire] = price;
        if (!moved.has(wire)) report.unmatchedPricing.push(wire);
      }
    }
    nextPricing = Object.keys(remaining).length > 0 ? { models: remaining } : undefined;
  }

  // 别名折叠：字典序首个入 entry.alias；其余报告（pin 改写仍经 aliasMap 落到条目键）。
  const aliasMap = new Map<string, string>();
  const sortedAliases = Object.entries(models.aliases ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [alias, target] of sortedAliases) {
    const mapped = refMap.get(target) ?? (Object.hasOwn(entries, target) ? target : undefined);
    if (mapped === undefined) {
      report.droppedAliases.push({ alias, target });
      continue;
    }
    aliasMap.set(alias, mapped);
    const entry = entries[mapped];
    if (
      entry !== undefined &&
      entry.alias === undefined &&
      !Object.hasOwn(entries, alias) &&
      !alias.startsWith('legacy:')
    ) {
      entries[mapped] = { ...entry, alias };
    } else {
      report.droppedAliases.push({ alias, target, kept: entry?.alias });
    }
  }

  // default 改写：别称（含被丢弃的）→ 条目键；vid/wire → 新键；已新形状原样。
  let nextDefault = models.default;
  if (nextDefault !== undefined) {
    nextDefault = aliasMap.get(nextDefault) ?? refMap.get(nextDefault) ?? nextDefault;
  }

  const nextModels: ModelsConfig = {
    ...(nextDefault !== undefined ? { default: nextDefault } : {}),
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
    ...(Object.keys(entries).length > 0 ? { entries } : {}),
  };
  return { models: nextModels, pricing: nextPricing, refMap, aliasMap, valueCopies, report };
}

// ── 加密库值复制（信封 v1 形状冻结；迁移期重加密复制，§7.2）──────────────

interface EnvelopeEntry {
  iv: string;
  tag: string;
  data: string;
  createdAt: string;
  updatedAt: string;
}

function credentialsFile(dataDir: string): string {
  return path.join(dataDir, 'credentials.json');
}

async function readEnvelope(
  dataDir: string,
): Promise<{ v: 1; entries: Record<string, EnvelopeEntry> }> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile(dataDir), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, entries: {} };
    throw error;
  }
  const parsed = JSON.parse(raw) as { v?: unknown; entries?: unknown };
  if (parsed.v !== 1 || !isRecord(parsed.entries)) {
    throw new Error('credentials_corrupt: unexpected envelope shape');
  }
  return { v: 1, entries: parsed.entries as Record<string, EnvelopeEntry> };
}

function envelopeKey(dataDir: string): Buffer {
  const read = ensureRootSecret(rootSecretPath(dataDir));
  if (!read.ok) throw new Error(`root_secret_unavailable: ${read.error.message}`);
  const token = derivePurposeToken(read.value.secret, { kind: 'credentials' });
  const key = Buffer.from(token.slice(DERIVED_TOKEN_PREFIX.length), 'base64url');
  if (key.length !== ROOT_SECRET_BYTES) {
    throw new Error('credential_key_invalid: derived credentials key is not 32 bytes');
  }
  return key;
}

function decryptValue(key: Buffer, entry: EnvelopeEntry): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** 值复制：解密旧 id → 新 iv 重加密写新 id（失败 = 需重录，不阻断）。 */
async function copyCredentialValue(dataDir: string, from: string, to: string): Promise<boolean> {
  const envelope = await readEnvelope(dataDir);
  const source = envelope.entries[from];
  if (source === undefined) return false;
  const key = envelopeKey(dataDir);
  const value = decryptValue(key, source);
  if (value === undefined) return false;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const now = new Date().toISOString();
  envelope.entries[to] = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    createdAt: now,
    updatedAt: now,
  };
  await atomicWrite(credentialsFile(dataDir), `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
    ensureDir: true,
  });
  return true;
}

// ── agent store pin 改写（§7.3；v5 显式 pin，幂等）──────────────────────

async function rewriteAgentPins(
  dataDir: string,
  refMap: Map<string, string>,
  aliasMap: Map<string, string>,
  report: MigrationReport,
): Promise<void> {
  const dir = path.join(dataDir, 'agents');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return; // 无 agent store = 无 pin
  }
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as {
        version?: unknown;
        members?: unknown;
      };
      // v1–v4 把有效 model 烧进记录（非显式 pin），不改写。
      if (parsed.version !== 5 || !Array.isArray(parsed.members)) continue;
      let changed = false;
      for (const member of parsed.members) {
        if (!isRecord(member) || typeof member.model !== 'string') continue;
        const from = member.model;
        const to = refMap.get(from) ?? aliasMap.get(from);
        if (to === undefined || to === from) continue;
        member.model = to;
        changed = true;
        report.pinsRewritten.push({
          file: name,
          member: typeof member.id === 'string' ? member.id : '(unknown)',
          from,
          to,
        });
      }
      if (changed) {
        await atomicWrite(file, `${JSON.stringify(parsed, null, 2)}\n`, {
          mode: 0o600,
          ensureDir: true,
        });
      }
    } catch {
      report.pinsFailed.push(name);
    }
  }
}

// ── 编排（loader 钩子入口）──────────────────────────────────────────────

/** dataDir 口径（与插件 resolveDataDir / src/data-paths 同序）：config → env → 默认。 */
function migrationDataDir(
  root: Record<string, unknown>,
  env: Record<string, string | undefined>,
): string {
  const configured =
    (typeof root.data_dir === 'string' && root.data_dir.trim() !== ''
      ? root.data_dir
      : undefined) ??
    (typeof env.VESSEL_DATA_DIR === 'string' && env.VESSEL_DATA_DIR.trim() !== ''
      ? env.VESSEL_DATA_DIR
      : undefined);
  return path.resolve(expandHomePath(configured ?? DEFAULT_DATA_DIR));
}

/** 报告落盘路径（doctor / list 消费）。 */
export function migrationReportPath(dataDir: string): string {
  return path.join(dataDir, 'model-registry-migration.json');
}

/** 读迁移报告；不存在 / 损坏 → undefined（一次性，迁移完成后为空 = 无报告）。 */
export async function readMigrationReport(dataDir: string): Promise<MigrationReport | undefined> {
  try {
    const parsed = JSON.parse(await readFile(migrationReportPath(dataDir), 'utf-8'));
    return isRecord(parsed) && typeof parsed.migratedAt === 'string'
      ? (parsed as unknown as MigrationReport)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一次性迁移入口（loader 首载钩子）：检测旧块 → lock 内转换 + .bak + 预校验 + 原子写 →
 * 值复制 → pin 改写 → 报告。已在 configPath 锁内（如 registry-store 写事务）则原地执行。
 * 无旧块 → undefined（幂等 no-op）。yaml 写失败 → 抛错（.bak 完好）。
 */
export async function migrateUserConfigModels(options: {
  configPath: string;
  env?: Record<string, string | undefined>;
}): Promise<MigrationReport | undefined> {
  const { configPath } = options;
  const env = options.env ?? process.env;

  const run = async (): Promise<MigrationReport | undefined> => {
    const root = await readUserConfigRoot(configPath);
    if (!hasLegacyModelsBlock(root)) return undefined;
    const modelsCamel =
      snakeToCamel<{ models?: LegacyModelsInput }>(
        { models: root.models },
        {
          preserveKey: preserveConfigMapKeys,
        },
      ).models ?? {};
    const pricingCamel = snakeToCamel<{ pricing?: PricingConfig }>(
      { pricing: root.pricing },
      { preserveKey: preserveConfigMapKeys },
    ).pricing;
    const t = transformLegacyModels(modelsCamel, pricingCamel);

    // 写前预校验（新形状必须合法；不合法 → fail-fast，.bak 完好）。
    const errors: ConfigValidationError[] = [];
    validateModels(t.models as unknown as Record<string, unknown>, undefined, errors);
    if (errors.length > 0) {
      throw new Error(
        `model_migration_invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      );
    }

    // .bak（首次迁移才建；回滚 = 恢复旧 yaml，旧二进制可读）。
    const backupPath = `${configPath}.pre-model-registry.bak`;
    let backedUp = false;
    try {
      await copyFile(configPath, backupPath, 1 /* COPYFILE_EXCL */);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    // 新根：models 换形（snake_case）+ pricing 搬移；其它块原样。
    const nextRoot = { ...root };
    const diskModels: Record<string, unknown> = {};
    if (t.models.default !== undefined) diskModels.default = t.models.default;
    if (t.models.credentials !== undefined) {
      diskModels.credentials = Object.fromEntries(
        Object.entries(t.models.credentials).map(([id, cred]) => [id, credentialToYaml(cred)]),
      );
    }
    if (t.models.entries !== undefined) {
      diskModels.entries = Object.fromEntries(
        Object.entries(t.models.entries).map(([id, entry]) => [id, entryToYaml(entry)]),
      );
    }
    if (Object.keys(diskModels).length === 0) delete nextRoot.models;
    else nextRoot.models = diskModels;
    if (t.pricing === undefined) delete nextRoot.pricing;
    else if (pricingCamel !== undefined) {
      nextRoot.pricing = {
        models: Object.fromEntries(
          Object.entries(t.pricing.models).map(([wire, price]) => [wire, pricingToYaml(price)]),
        ),
      };
    }
    await writeUserConfigRoot(configPath, nextRoot);

    const report: MigrationReport = {
      migratedAt: new Date().toISOString(),
      configPath,
      ...(backedUp ? { backupPath } : {}),
      ...t.report,
      pinsRewritten: [],
      pinsFailed: [],
    };

    // 值复制（拆分凭证）：失败 = 需重录，不阻断。
    const dataDir = migrationDataDir(root, env);
    for (const { from, to } of t.valueCopies) {
      try {
        const ok = await copyCredentialValue(dataDir, from, to);
        if (!ok) report.needsReRecord.push(to);
      } catch {
        report.needsReRecord.push(to);
      }
    }

    // pin 改写（yaml 先、存储后；失败报告不阻断）。
    await rewriteAgentPins(dataDir, t.refMap, t.aliasMap, report);

    // 报告落盘（doctor / list 消费）。
    try {
      await atomicWrite(migrationReportPath(dataDir), `${JSON.stringify(report, null, 2)}\n`, {
        mode: 0o600,
        ensureDir: true,
      });
    } catch (error) {
      report.errors.push(
        `report_write_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return report;
  };

  return isConfigLockHeld(configPath) ? run() : withConfigLock(configPath, run);
}
