/**
 * 0.56 P2：口令哈希（argon2id）。
 *
 * 算法：**argon2id**，参数 `m=64MiB, t=3, p=1`（Bun 内置，`Bun.password`）。
 * 取值理由：OWASP 2024 对 argon2id 的最低建议是 `m=19MiB, t=2`；这里抬到 64MiB/3
 * 让单次校验约 40–80ms（在笔记本上实测），在线爆破因此天然被限速，同时登录延迟
 * 仍是「人感觉不到」的量级。参数**写死在 PHC 串里**（`$argon2id$v=19$m=65536,t=3,p=1$…`），
 * 所以将来调参不会让老 hash 失效：校验读串里的参数，不读这里的常量。
 *
 * 为什么不是 scrypt：Bun ≥1.3.9 自带 argon2id（本仓库 engines 就是 `bun >=1.3.9`），
 * 没有必要用「内存硬但并行抗性弱」的 scrypt。**兜底**：如果在没有 `Bun.password` 的
 * 运行时（例如被当成库跑在 node 上），校验侧只支持仓库自己生成的 `scrypt$` 串，
 * argon2id 串会返回 `unsupported`（fail-closed，不会误判成通过）。
 *
 * 口令明文只在本次调用里存在；不落盘、不进日志、不进错误文案。
 *
 * @module @vessel-agent/serve/auth/password
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** 存储里的算法标记；从串本身解析，不信任调用方。 */
export type PasswordAlgorithm = 'argon2id' | 'scrypt';

/** 落盘形状：算法 + PHC/自定义串。 */
export interface StoredPassword {
  algorithm: PasswordAlgorithm;
  value: string;
  /** 写入时间（毫秒）；只用于诊断「上次改口令是什么时候」。 */
  updatedAt: number;
}

/** argon2id 参数（写进 PHC 串；改这里只影响新 hash）。 */
export const ARGON2_PARAMS = {
  algorithm: 'argon2id' as const,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
};

/** scrypt 兜底参数（仅在无 Bun.password 的运行时使用）。 */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, keyLen: 32 };
const SCRYPT_PREFIX = 'scrypt$';

/** Bun 自带的密码 API（类型由 @types/bun 提供；运行时探测避免硬依赖）。 */
interface BunPasswordApi {
  hash: (
    password: string,
    options?: {
      algorithm?: 'argon2id' | 'argon2i' | 'argon2d' | 'bcrypt';
      memoryCost?: number;
      timeCost?: number;
    },
  ) => Promise<string>;
  verify: (password: string, hash: string) => Promise<boolean>;
}

function bunPassword(): BunPasswordApi | null {
  const candidate = (globalThis as { Bun?: { password?: BunPasswordApi } }).Bun?.password;
  return candidate === undefined ? null : candidate;
}

function scryptHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_PARAMS.keyLen,
      { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
      (error, derived) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(
          `${SCRYPT_PREFIX}N=${String(SCRYPT_PARAMS.N)},r=${String(SCRYPT_PARAMS.r)},` +
            `p=${String(SCRYPT_PARAMS.p)}$${salt.toString('base64url')}$${derived.toString('base64url')}`,
        );
      },
    );
  });
}

function scryptVerify(password: string, stored: string): Promise<boolean> {
  const parts = stored.slice(SCRYPT_PREFIX.length).split('$');
  if (parts.length !== 3) return Promise.resolve(false);
  const [paramText, saltText, hashText] = parts as [string, string, string];
  const params: Record<string, number> = {};
  for (const pair of paramText.split(',')) {
    const [key, value] = pair.split('=');
    if (key === undefined || value === undefined) return Promise.resolve(false);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return Promise.resolve(false);
    params[key] = parsed;
  }
  const expected = Buffer.from(hashText, 'base64url');
  return new Promise((resolve) => {
    scrypt(
      password,
      Buffer.from(saltText, 'base64url'),
      expected.length,
      { N: params.N ?? 16_384, r: params.r ?? 8, p: params.p ?? 1 },
      (error, derived) => {
        if (error !== null) {
          resolve(false);
          return;
        }
        resolve(
          derived.length === expected.length && timingSafeEqual(Buffer.from(derived), expected),
        );
      },
    );
  });
}

/** 从串判定算法；认不出来返回 null（调用方按 fail-closed 处理）。 */
export function detectAlgorithm(value: string): PasswordAlgorithm | null {
  if (value.startsWith('$argon2id$')) return 'argon2id';
  if (value.startsWith(SCRYPT_PREFIX)) return 'scrypt';
  return null;
}

/** 生成新口令 hash（argon2id 优先；无 Bun.password 时退回 scrypt）。 */
export async function hashPassword(password: string, now = Date.now()): Promise<StoredPassword> {
  const api = bunPassword();
  if (api !== null) {
    const value = await api.hash(password, {
      algorithm: ARGON2_PARAMS.algorithm,
      memoryCost: ARGON2_PARAMS.memoryCost,
      timeCost: ARGON2_PARAMS.timeCost,
    });
    return { algorithm: 'argon2id', value, updatedAt: now };
  }
  return { algorithm: 'scrypt', value: await scryptHash(password), updatedAt: now };
}

export type PasswordVerifyOutcome = 'ok' | 'mismatch' | 'unsupported' | 'malformed';

/** 恒定感知的校验；任何异常都落到 `malformed`（不抛给请求线程）。 */
export async function verifyPassword(
  password: string,
  stored: StoredPassword | { algorithm?: string; value: string },
): Promise<PasswordVerifyOutcome> {
  const value = stored.value;
  const algorithm = detectAlgorithm(value);
  if (algorithm === null) return 'malformed';
  if (typeof password !== 'string' || password === '') return 'mismatch';
  if (algorithm === 'scrypt') {
    try {
      return (await scryptVerify(password, value)) ? 'ok' : 'mismatch';
    } catch {
      return 'malformed';
    }
  }
  const api = bunPassword();
  if (api === null) return 'unsupported';
  try {
    return (await api.verify(password, value)) ? 'ok' : 'mismatch';
  } catch {
    return 'malformed';
  }
}

/**
 * 常量时间「假校验」：账号不存在 / 未配口令时也走一遍同等开销的路径，
 * 让响应时间不泄露「这个用户名有没有口令」。
 */
export async function dummyPasswordCheck(password: string): Promise<void> {
  const api = bunPassword();
  if (api !== null) {
    await api.hash(password, {
      algorithm: ARGON2_PARAMS.algorithm,
      memoryCost: ARGON2_PARAMS.memoryCost,
      timeCost: ARGON2_PARAMS.timeCost,
    });
    return;
  }
  await scryptHash(password);
}

/** 口令强度下限（不追求复杂度教条，只要不是「abc」）。 */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return 'password_too_short';
  if (password.length > 200) return 'password_too_long';
  return null;
}
