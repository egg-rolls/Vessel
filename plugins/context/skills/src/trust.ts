/**
 * @vessel-agent/plugin-skills — 信任门（TOFU 哈希锁）
 * @module @vessel-agent/skills/trust
 *
 * 设计 §5.4 派生规则 / §6.4 信任门 / §9.2 状态机。单一口径，工具 / RPC / UI
 * 共用：
 * - trustState：无记录 → unknown；revoked → revoked；trusted 且哈希一致 →
 *   trusted；不等 → stale（派生态，不写回锁文件）。
 * - 门判定：list/search 恒 allow（只读元数据）；load trusted → allow；
 *   unknown/stale → ask（trust_default='deny' 时 deny，fail-closed 收紧档）；
 *   revoked → deny。
 * - TOFU 钉锁发生在**用户批准之后**（handler 内）——判定函数无副作用。
 *
 * 锁文件 trust.json 只由插件宿主侧写；技能文件本身不携带任何「自证可信」
 * 标记——frontmatter 里写 trusted: true 无效。
 */

import type { SkillEntry, TrustRecord, TrustState, TrustStore } from './types.js';

/** 信任态派生（单一口径；stale 是派生态，不落盘） */
export function trustStateOf(entry: SkillEntry, store: TrustStore): TrustState {
  const record = store.skills[entry.id];
  if (record === undefined) return 'unknown';
  if (record.state === 'revoked') return 'revoked';
  // oversize 条目 sha256 为 ''（扫描期不读内容），永不等于锁哈希 → stale；
  // 但 oversize 在 load 侧先被拒，走不到门判定。
  return entry.sha256 !== '' && entry.sha256 === record.sha256 ? 'trusted' : 'stale';
}

/** load 信任门判定（§6.4 表；无副作用） */
export function loadGateDecision(
  state: TrustState,
  trustDefault: 'ask' | 'deny',
): 'allow' | 'ask' | 'deny' {
  switch (state) {
    case 'trusted':
      return 'allow';
    case 'revoked':
      return 'deny';
    case 'unknown':
    case 'stale':
      return trustDefault === 'deny' ? 'deny' : 'ask';
  }
}

/**
 * TOFU 钉锁记录（用户批准后由 handler 调用）。
 * origin：project/user 本地 authored → local；library 收集内容 → import
 * （marketplace 来源 P3 落地前不自动提升信任）。
 */
export function pinTrustRecord(sha256: string, origin: TrustRecord['origin']): TrustRecord {
  return { sha256, recordedAt: new Date().toISOString(), origin, state: 'trusted' };
}

/** 撤销记录（保留钉住过的哈希供审计；无旧锁时钉当前哈希，保证记录可持久化） */
export function revokeTrustRecord(
  previous: TrustRecord | undefined,
  currentSha256: string,
): TrustRecord {
  return {
    sha256: previous?.sha256 ?? currentSha256,
    recordedAt: new Date().toISOString(),
    origin: previous?.origin ?? 'local',
    state: 'revoked',
  };
}

/** 技能来源 → 信任记录 origin（library 是收集内容，其余是本地 authored） */
export function originOfSource(source: SkillEntry['source']): TrustRecord['origin'] {
  return source === 'library' ? 'import' : 'local';
}
