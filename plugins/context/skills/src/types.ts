/**
 * @vessel-agent/plugin-skills — 核心类型与上限常量
 * @module @vessel-agent/skills/types
 *
 * 设计 §5.4 逐字落地。文件永远是真相源，索引只是派生缓存：
 * load 永远重读文件并校哈希，索引损坏 / 过期只影响 list/search 时效。
 */

/** 技能来源：project = 仓库 skills/；user = ~/.vessel/skills/；library = 插件收集库 */
export type SkillSource = 'project' | 'user' | 'library';

/** frontmatter 解析状态：ok = 四键子集全合法；partial = 有未知键（忽略）；none = 无 frontmatter；invalid = 解析失败 */
export type FrontmatterState = 'ok' | 'partial' | 'none' | 'invalid';

/** 信任态（派生规则见 trust.ts）：unknown / trusted / stale（哈希变了）/ revoked */
export type TrustState = 'unknown' | 'trusted' | 'stale' | 'revoked';

/** 一条技能索引条目（扫描期产出；load 期重读重算） */
export interface SkillEntry {
  /** `<source>/<relpath 去扩展名>`，如 'user/code-writing'、'library/foo/SKILL' */
  id: string;
  /** frontmatter.name ?? 文件名（dir 形态取目录名） */
  name: string;
  /** ≤200 字符 */
  description: string;
  /** ≤16 个，每个 ≤32 字符 */
  tags: string[];
  version?: string;
  source: SkillSource;
  /** 相对来源根，'/' 分隔 */
  relPath: string;
  /** realpath（扫描期钉死） */
  absPath: string;
  format: 'flat' | 'dir';
  /** dir 形态附件相对路径清单（≤50 条，超出截断标注） */
  auxFiles?: string[];
  bytes: number;
  mtimeMs: number;
  /** 内容哈希（扫描期算；load 期重算比对）；oversize 条目不读内容，为 '' */
  sha256: string;
  frontmatter: FrontmatterState;
  /** oversize / 解析失败 / 截断等 */
  warnings?: string[];
}

/** 派生缓存：全量条目元数据（可整文件重建） */
export interface SkillIndex {
  version: 1;
  /** ISO8601 */
  generatedAt: string;
  /** 按 id 排序（确定性序列化，指纹可比） */
  entries: SkillEntry[];
}

/** 一条信任记录（TOFU 哈希锁；宿主侧写，唯一真相） */
export interface TrustRecord {
  /** 钉住的内容哈希 */
  sha256: string;
  recordedAt: string;
  origin: 'local' | 'import' | 'marketplace';
  /** stale 是派生态：trusted 但当前哈希 ≠ 锁哈希 */
  state: 'trusted' | 'revoked';
}

/** 信任锁文件形状 */
export interface TrustStore {
  version: 1;
  /** key = skill id */
  skills: Record<string, TrustRecord>;
}

/** 一次会话加载记录（内容后来变了也能追溯当时加载的是什么） */
export interface SessionLoad {
  id: string;
  /** 加载时的内容哈希 */
  sha256: string;
  loadedAt: string;
  runId: string;
}

/** 一个会话的加载状态（追加式，上限 200 条，超出丢最旧） */
export interface SessionLoads {
  version: 1;
  sessionId: string;
  loaded: SessionLoad[];
}

// ── 上限常量（设计 §5.1 / §5.4 / §9.1 T5；防 DoS 的硬边界） ──────────────────

/** 单文件扫描上限：超限条目标 oversize，可 list 不可 load */
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
/** 条目总数上限（三根合计；超出告警截断） */
export const MAX_SKILL_ENTRIES = 5000;
/** dir 形态附件清单上限（超出截断标注） */
export const MAX_AUX_FILES = 50;
/** 目录深度上限 */
export const MAX_SCAN_DEPTH = 8;
/** load / get 返回内容缺省上限（可经 max_load_bytes 配置） */
export const DEFAULT_MAX_LOAD_BYTES = 65536;
/** description 上限（字符） */
export const MAX_DESCRIPTION_CHARS = 200;
/** list/search 行内 description 截断（字符） */
export const LIST_DESCRIPTION_CHARS = 120;
/** tags 个数上限 */
export const MAX_TAGS = 16;
/** 单个 tag 长度上限（字符） */
export const MAX_TAG_CHARS = 32;
/** list/search 单页行数上限 */
export const MAX_PAGE_LIMIT = 50;
/** 每会话加载记录上限（超出丢最旧） */
export const MAX_LOADS_PER_SESSION = 200;
/** loads RPC 缺省返回的会话数上限 */
export const MAX_LOADS_SESSIONS = 100;
/** watch 去抖（毫秒；gateway 热重载同款节奏） */
export const WATCH_DEBOUNCE_MS = 300;

/** 空索引（损坏 / 缺失时的降级形态） */
export function emptyIndex(): SkillIndex {
  return { version: 1, generatedAt: new Date(0).toISOString(), entries: [] };
}

/** 空信任库（损坏时 fail-closed：全部 unknown，重新确认，不静默放行） */
export function emptyTrustStore(): TrustStore {
  return { version: 1, skills: {} };
}

/** 空会话加载状态 */
export function emptySessionLoads(sessionId: string): SessionLoads {
  return { version: 1, sessionId, loaded: [] };
}
