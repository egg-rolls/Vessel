/**
 * 单一根密钥 + 派生 token（0.55，事故驱动的设计约束）。
 *
 * ## 为什么是这个形状
 *
 * 0.55 把「必须带平台 token」收紧成硬前置，而用户 config 里从来没有
 * `gateway.token`：一次升级就把本地 WebUI 锁死，症状只表现为「掉线 / 发消息卡几分钟」。
 * 结论不是「再加一个必填项」，而是**把「未配置就挂」这种形状从根上消灭**：
 *
 * - 用户只留一份**根密钥**（`<dataDir>/root-secret`，32 字节，0600，首次启动自动生成）；
 * - 所有 token（平台 / hub / node / 反代）都由它 HKDF 派生，**不落盘、不缓存**，用的时候现算；
 * - 显式配置（`gateway.token` / `node.token` / `hub.token_env` / `*_proxy_secret_env`）
 *   永远优先，派生只是**兜底**，不是替代品。
 *
 * ## 派生规则（冻结）
 *
 * ```
 * HKDF-SHA256(ikm = root, salt = "vessel/v1", info = "vessel:<purpose>[:<id>]", len = 32)
 *   → base64url → "vsk_<43 字符>"
 * ```
 *
 * `purpose` ∈ `platform` / `hub` / `node:<nodeId>` / `proxy:<instanceId>`。
 * 同一个 root + 同一个 purpose 恒等；换 root（`vessel token rotate`）则全部一起换。
 *
 * ## 安全约定
 *
 * - token 值**永不**出现在日志 / 事件 / 错误文案里；本模块的错误只带路径与码；
 * - 比较用定长摘要 + 常量时间（`tokenEquals`），不按字节提前返回；
 * - 根密钥权限宽于 0600（或其他用户可读写）→ **拒绝使用并说明怎么修**：
 *   宁可不启动，也不能拿一份可能已经泄露的根密钥继续派生所有 token。
 *
 * 本模块只做「密码学原语 + 文件读写」，不接线 server / CLI；
 * 生效优先级（显式 > 派生）在 `src/token-derive.ts`。
 *
 * @module @vessel-agent/config
 */

import { createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';

/** 根密钥文件名（`<dataDir>/root-secret`）。 */
export const ROOT_SECRET_FILE_NAME = 'root-secret';

/** 根密钥字节数（32 字节 = 256 位熵，HKDF 的 ikm 上限远超实际需要）。 */
export const ROOT_SECRET_BYTES = 32;

/** HKDF salt：换版本号会让所有派生值一次性失效，只在协议变更时动。 */
export const ROOT_SECRET_SALT = 'vessel/v1';

/** info 前缀（`vessel:<purpose>`）。 */
export const DERIVE_INFO_PREFIX = 'vessel:';

/** 派生 token 的可读前缀（便于人眼识别「这是本机派生出来的」，不含任何密钥信息）。 */
export const DERIVED_TOKEN_PREFIX = 'vsk_';

/** 派生用途；`id` 参与 HKDF info，决定「同一根密钥下的不同维度」。 */
export type TokenPurpose =
  | { kind: 'platform' }
  | { kind: 'hub' }
  | { kind: 'node'; id: string }
  | { kind: 'proxy'; id: string };

/** 根密钥 / 派生相关的稳定错误码（进日志与 CLI 文案，不含任何密钥值）。 */
export type RootSecretErrorCode =
  | 'root_secret_insecure_permissions'
  | 'root_secret_missing'
  | 'root_secret_invalid'
  | 'root_secret_unreadable'
  | 'root_secret_write_failed';

export interface RootSecretError {
  code: RootSecretErrorCode;
  /** 可操作文案：说清「哪里、为什么、怎么修」。不含密钥值。 */
  message: string;
}

export interface RootSecretValue {
  secret: Buffer;
  /** 根密钥文件路径（env 覆盖时仍是「本来应该在的位置」，便于排错）。 */
  path: string;
  /** 文件是否本次新建（首次启动自动生成）。 */
  created: boolean;
}

export type RootSecretRead =
  | { ok: true; value: RootSecretValue }
  | { ok: false; error: RootSecretError };

/** purpose id 形状：与 node_id / 实例名同一套字符集，避免 info 字符串出现分隔歧义。 */
const PURPOSE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 平台 / hub 不需要 id。 */
const IDLESS_KINDS = new Set(['platform', 'hub']);

function isPurposeKind(value: string): value is TokenPurpose['kind'] {
  return value === 'platform' || value === 'hub' || value === 'node' || value === 'proxy';
}

export type ParsedPurpose = { ok: true; purpose: TokenPurpose } | { ok: false; error: string };

/**
 * 解析 CLI / 配置里的用途写法。
 *
 * 接受 `platform` / `hub` / `node` / `node:<id>` / `proxy` / `proxy:<id>`；
 * `node` / `proxy` 缺 id 时从 `id` 参数补齐（`--node <id>`）。
 */
export function parseTokenPurpose(raw: string, id?: string): ParsedPurpose {
  const spec = raw.trim();
  if (spec === '') return { ok: false, error: 'purpose must not be empty' };

  const colon = spec.indexOf(':');
  const kindPart = colon === -1 ? spec : spec.slice(0, colon);
  const idPart = colon === -1 ? undefined : spec.slice(colon + 1);

  if (!isPurposeKind(kindPart)) {
    return {
      ok: false,
      error: `unknown purpose "${kindPart}"; expected platform | hub | node[:<id>] | proxy[:<instance>]`,
    };
  }
  const kind = kindPart;
  if (IDLESS_KINDS.has(kind)) {
    if ((idPart !== undefined && idPart !== '') || (id !== undefined && id !== '')) {
      return { ok: false, error: `purpose "${kind}" does not take an id` };
    }
    return { ok: true, purpose: kind === 'platform' ? { kind: 'platform' } : { kind: 'hub' } };
  }

  // node / proxy：id 必须恰好一个来源（`node:<id>` 或 `--node <id>`，不能既给又不同）。
  if (idPart !== undefined && idPart !== '' && id !== undefined && id !== '' && idPart !== id) {
    return { ok: false, error: `conflicting ids for purpose "${kind}": "${idPart}" vs "${id}"` };
  }
  const resolved = idPart !== undefined && idPart !== '' ? idPart : (id ?? '');
  if (resolved === '') {
    return {
      ok: false,
      error: `purpose "${kind}" requires an id (use "${kind}:<id>" or --node/--instance)`,
    };
  }
  if (!PURPOSE_ID_RE.test(resolved)) {
    return { ok: false, error: `invalid id "${resolved}": expected 1-64 of [A-Za-z0-9_-]` };
  }
  return {
    ok: true,
    purpose: kind === 'node' ? { kind: 'node', id: resolved } : { kind: 'proxy', id: resolved },
  };
}

/** HKDF info 字符串：`vessel:platform` / `vessel:node:<id>` / … */
export function purposeInfo(purpose: TokenPurpose): string {
  const head = `${DERIVE_INFO_PREFIX}${purpose.kind}`;
  return 'id' in purpose ? `${head}:${purpose.id}` : head;
}

/** 人类可读标签（`node:abc123`）；用于 `token list` / 日志。 */
export function purposeLabel(purpose: TokenPurpose): string {
  return 'id' in purpose ? `${purpose.kind}:${purpose.id}` : purpose.kind;
}

/**
 * 派生一个用途的 token。
 *
 * 纯函数：同一个 root + 同一个 purpose 恒等；**不读盘、不写盘、不缓存**。
 * 输出是可直接放进 `Authorization: Bearer` 的字符串。
 */
export function derivePurposeToken(root: Buffer, purpose: TokenPurpose): string {
  const derived = Buffer.from(
    hkdfSync('sha256', root, ROOT_SECRET_SALT, purposeInfo(purpose), ROOT_SECRET_BYTES),
  );
  // base64url 无填充 = 43 字符；`vsk_` 前缀只用来区分来源，不参与安全判定。
  return `${DERIVED_TOKEN_PREFIX}${derived.toString('base64url')}`;
}

/**
 * token 指纹：`sha256(token)` 的前 8 位十六进制。
 *
 * 只用于「人眼比对两个 token 是不是同一个」，**不可逆**、冲突概率对本用途足够低；
 * `token list` 只输出指纹，永不输出值。
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

/** 定长摘要 + 常量时间比较（不按字节提前返回）。 */
export function tokenEquals(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

/** 根密钥文件路径。 */
export function rootSecretPath(dataDir: string): string {
  return nodePath.join(dataDir, ROOT_SECRET_FILE_NAME);
}

/**
 * 解析 `security.root_secret_env` 指向的值。
 *
 * 接受两种写法（都要求 ≥32 字节真实熵）：
 * - base64（恰好 32 字节，`openssl rand -base64 32` 的产物）；
 * - 任意 ≥32 字节的原始字符串（hex / 手写长串），按 UTF-8 取字节。
 *
 * 太短 → undefined（调用方报错，不静默用一个弱根密钥）。
 */
export function parseRootSecretMaterial(raw: string | undefined): Buffer | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === ROOT_SECRET_BYTES) return decoded;
  const rawBytes = Buffer.from(trimmed, 'utf8');
  return rawBytes.length >= ROOT_SECRET_BYTES ? rawBytes : undefined;
}

/**
 * 文件权限是否**不安全**：group / other 有任何权限位。
 *
 * Windows 上 POSIX mode 是合成的（`statSync().mode` 恒为 0o666 附近），
 * 拿它判定只会误报，所以 Windows 跳过（由 NTFS ACL 负责）。
 */
export function isInsecureRootSecretMode(
  mode: number,
  platform: string = process.platform,
): boolean {
  if (platform === 'win32') return false;
  return (mode & 0o077) !== 0;
}

function insecurePermissionsError(file: string): RootSecretError {
  return {
    code: 'root_secret_insecure_permissions',
    message:
      `root secret ${file} is readable by other users (permissions wider than 0600). ` +
      `Run "chmod 600 ${file}" and restart. Refusing to derive any token from a root ` +
      'secret that may already have leaked.',
  };
}

/**
 * 读取已有根密钥（**不创建**）。
 *
 * 文件不存在 → `root_secret_missing`（调用方据此走 `ensureRootSecret` 自动生成）；
 * 权限不安全 → 拒绝（不读内容、不自动 chmod，避免把「已经被别人读过」的事实盖掉）。
 *
 * `platform` 只为可验证性而注入（缺省 `process.platform`）：Windows 上 POSIX mode
 * 是合成的，只能跳过检查；其余平台一律按 0600 判定。
 */
export function readRootSecret(file: string, platform: string = process.platform): RootSecretRead {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      error: {
        code: code === 'ENOENT' ? 'root_secret_missing' : 'root_secret_unreadable',
        message:
          code === 'ENOENT'
            ? `root secret ${file} does not exist`
            : `cannot stat root secret ${file}: ${String(code ?? error)}`,
      },
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      error: { code: 'root_secret_invalid', message: `root secret ${file} is not a regular file` },
    };
  }
  if (isInsecureRootSecretMode(stat.mode, platform)) {
    return { ok: false, error: insecurePermissionsError(file) };
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'root_secret_unreadable',
        message: `cannot read root secret ${file}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
  const secret = parseRootSecretMaterial(raw);
  if (secret === undefined) {
    return {
      ok: false,
      error: {
        code: 'root_secret_invalid',
        message:
          `root secret ${file} is not valid base64 or is shorter than ${ROOT_SECRET_BYTES} bytes. ` +
          'Delete it to let vessel generate a new one (all derived tokens change).',
      },
    };
  }
  return { ok: true, value: { secret, path: file, created: false } };
}

/**
 * 原子写入根密钥：临时文件（0600）→ fsync → rename。
 *
 * rename 在同一目录内是原子的，因此并发启动的两个进程不会读到半个文件；
 * 后写者覆盖先写者（两者都是有效根密钥，代价只是先写者派生值失效，
 * 由 `vessel token rotate` 的场景兜住）。
 */
function writeRootSecret(file: string, secret: Buffer): RootSecretError | null {
  const dir = nodePath.dirname(file);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${secret.toString('base64')}\n`, { mode: 0o600, flag: 'w' });
    // 某些平台（umask 不收紧时）落盘权限可能更宽，显式再收一次。
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows / 只读文件系统：交给平台 ACL，不影响正确性。
    }
    renameSync(tmp, file);
    return null;
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 清理失败不影响主错误
    }
    return {
      code: 'root_secret_write_failed',
      message: `cannot write root secret ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * 读取根密钥；文件不存在时**自动生成**（自愈，绝不「未配置就挂」）。
 *
 * 生成后立即落盘 0600；返回值 `created: true` 让调用方能打一行「首次生成」提示
 * （只提示路径与指纹，不打印值）。
 */
export function ensureRootSecret(
  file: string,
  platform: string = process.platform,
): RootSecretRead {
  const existing = readRootSecret(file, platform);
  if (existing.ok) return existing;
  // 只有「不存在」才自动生成；权限不安全 / 内容非法都要人介入（见 readRootSecret）。
  if (existing.error.code !== 'root_secret_missing') return existing;

  const secret = randomBytes(ROOT_SECRET_BYTES);
  const writeError = writeRootSecret(file, secret);
  if (writeError !== null) return { ok: false, error: writeError };
  // 写后复核：确保落盘权限确实是 0600（而不是被 umask 放开）。
  const verified = readRootSecret(file, platform);
  if (verified.ok) {
    return { ok: true, value: { ...verified.value, created: true } };
  }
  return verified;
}

/**
 * 轮换根密钥：生成新的 32 字节并覆盖。
 *
 * 语义是「**全部一起换**」：所有派生 token 立即失效（旧值一律 401）。
 * 显式配置的 token 不受影响（它们本来就不走派生）。在跑的 node 需要重启才能
 * 拿到新值 —— 调用方负责提示。
 */
export function rotateRootSecret(
  file: string,
  platform: string = process.platform,
): RootSecretRead {
  const secret = randomBytes(ROOT_SECRET_BYTES);
  const writeError = writeRootSecret(file, secret);
  if (writeError !== null) return { ok: false, error: writeError };
  const verified = readRootSecret(file, platform);
  if (!verified.ok) return verified;
  return { ok: true, value: { ...verified.value, created: true } };
}
