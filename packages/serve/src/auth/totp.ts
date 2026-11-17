/**
 * 0.56 P2：RFC 6238 TOTP（口令后端的第二因子）。
 *
 * 固定参数（不接受配置，避免「把参数调松」变成一条隐形后门）：
 * - HMAC-SHA1 / 6 位数字 / 30 秒一步 —— 与 Google Authenticator、1Password、
 *   Bitwarden 等全部认证器的缺省一致，QR 里也照抄这套。
 * - 时钟漂移容忍 **±1 步**（即服务端与本机认证器相差不超过 30 秒都能过）。窗口再宽
 *   就等于让 6 位码的有效期翻倍，不值得。
 * - **重放**：同一个 step 只接受一次。调用方把「上一次用掉的 step」持久化，下一次
 *   只接受 `step > lastStep` —— 同一串数字在 30 秒内第二次输入必然被拒。
 *
 * @module @vessel-agent/serve/auth/totp
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 步长（秒）。RFC 6238 的缺省 X=30。 */
export const TOTP_STEP_SECONDS = 30;
/** 输出位数。 */
export const TOTP_DIGITS = 6;
/** 允许的时钟漂移（步数，单侧）。 */
export const TOTP_DRIFT_STEPS = 1;
/** 密钥长度：RFC 4226 建议 160 bit。 */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 生成 base32 密钥（认证器认这个编码，不带填充）。 */
export function generateTotpSecret(bytes = TOTP_SECRET_BYTES): string {
  return base32Encode(randomBytes(bytes));
}

/** RFC 4648 base32 编码（无填充、大写）。 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * base32 解码：容忍空格、连字符、小写与 `=` 填充（人工抄写/OCR 的常见噪声）。
 * 非法字符返回 null —— 调用方据此当「没配密钥」处理，而不是抛到请求线程里。
 */
export function base32Decode(input: string): Buffer | null {
  const cleaned = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (cleaned === '') return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const buffer = Buffer.from(bytes);
  return buffer.length === 0 ? null : buffer;
}

/** 当前时间对应的 step。 */
export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP（RFC 4226）：counter 是**步数**，不是秒数。 */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buffer).digest();
  // dynamic truncation（RFC 4226 §5.3）：低 4 bit 选偏移，然后取 4 字节。
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** 某一步的 TOTP 码。 */
export function totpAt(secret: Buffer, step: number): string {
  return hotp(secret, step);
}

/** 用户输入的码：只留数字（认证器里抄出来常带空格/连字符）。 */
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  if (!/^[0-9]{6,8}$/.test(digits)) return null;
  return digits;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifyTotpInput {
  /** base32 密钥。 */
  secret: string;
  /** 用户输入的 6 位码。 */
  code: string;
  /** 当前时间（毫秒）。 */
  nowMs: number;
  /**
   * 已经用掉的最大 step（持久化值；从未用过给 0）。
   * 命中它的码一律算重放 —— 这就是「同一步长内不接受第二个相同码」。
   */
  lastStep: number;
  /** 单侧漂移步数；缺省 {@link TOTP_DRIFT_STEPS}。 */
  driftSteps?: number;
}

export type TotpFailure = 'secret_invalid' | 'code_invalid' | 'replayed';

export type TotpVerifyResult = { ok: true; step: number } | { ok: false; reason: TotpFailure };

/**
 * 校验 TOTP 码。
 *
 * 先按 `step > lastStep` 过掉整段过去的步数（重放/更早的窗口），再在
 * `[now-drift, now+drift]` 里找匹配，返回那个 step 供调用方持久化。
 */
export function verifyTotp(input: VerifyTotpInput): TotpVerifyResult {
  const secret = base32Decode(input.secret);
  if (secret === null) return { ok: false, reason: 'secret_invalid' };
  const code = normalizeCode(input.code);
  if (code === null) return { ok: false, reason: 'code_invalid' };
  const current = stepAt(input.nowMs);
  const drift = input.driftSteps ?? TOTP_DRIFT_STEPS;
  for (let offset = -drift; offset <= drift; offset++) {
    const step = current + offset;
    if (step <= input.lastStep) continue;
    if (!constantTimeEqual(totpAt(secret, step), code)) continue;
    return { ok: true, step };
  }
  // 同一个码第二次进来时，它的 step 已经被 lastStep 吃掉 ⇒ 走到这里，
  // 单独用 replayed 报出来（调用方按「重放」告警，而不是「码错」）。
  for (let offset = -drift; offset <= drift; offset++) {
    const step = current + offset;
    if (step > input.lastStep) continue;
    if (constantTimeEqual(totpAt(secret, step), code)) return { ok: false, reason: 'replayed' };
  }
  return { ok: false, reason: 'code_invalid' };
}

/**
 * `otpauth://` 配对 URI（认证器扫这个二维码）。
 *
 * label 形如 `Vessel:admin`；issuer 固定 Vessel。不做 URL 编码偷懒：label 里的
 * 冒号是 RFC 里的分隔符，编码后认证器会显示成 `%3A`。
 */
export function buildOtpauthUri(input: {
  secret: string;
  account: string;
  issuer?: string;
}): string {
  const issuer = input.issuer ?? 'Vessel';
  const label = `${issuer}:${input.account}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
