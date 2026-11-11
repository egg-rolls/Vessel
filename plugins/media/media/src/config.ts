/**
 * @vessel-agent/media - 配置解析
 * @module @vessel-agent/media/config
 *
 * 同时接受 camelCase 与 snake_case；未知键忽略。数值字段一律夹到硬上限
 * （契约 §4：单文件 20 MiB、单次输出 32 KiB、page / frames 有上限），
 * 配置只能收紧，不能放宽。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 单文件硬上限（契约 §4：20 MiB） */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 单次输出硬上限（契约 §4：32 KiB） */
export const MAX_OUTPUT_BYTES = 32 * 1024;

/** 单次调用的页 / 帧硬上限 */
export const MAX_FRAMES = 8;

/** page 参数硬上限（1-based） */
export const MAX_PAGE = 2000;

/** 外部 CLI 超时硬上限 */
export const MAX_TIMEOUT_MS = 120_000;

/** 插件配置（解析后形态） */
export interface MediaConfig {
  /** false 时 install 直接返回，不注册工具 */
  enabled: boolean;
  /** 相对路径解析基准 */
  cwd: string;
  /** 允许的根；空 = 不限制根（内置 denylist 仍生效） */
  allowedRoots: string[];
  /** 追加到内置 denylist 的敏感路径 */
  denyPaths: string[];
  /** 单文件字节上限（<= MAX_FILE_BYTES） */
  maxFileBytes: number;
  /** 单次输出字节上限（<= MAX_OUTPUT_BYTES） */
  maxOutputBytes: number;
  /** 单次最多处理页 / 帧数（<= MAX_FRAMES） */
  maxFrames: number;
  /** page 参数上限（<= MAX_PAGE） */
  maxPage: number;
  /** 外部 CLI 超时（<= MAX_TIMEOUT_MS） */
  timeoutMs: number;
  /** pdftotext 可执行名或绝对路径 */
  pdftotext: string;
  /** tesseract 可执行名或绝对路径 */
  tesseract: string;
  /** tesseract 语言（缺省不传 -l，用 CLI 默认） */
  ocrLanguage?: string;
}

/** 默认值 */
export const DEFAULT_MEDIA_CONFIG: Readonly<MediaConfig> = {
  enabled: true,
  cwd: process.cwd(),
  allowedRoots: [],
  denyPaths: [],
  maxFileBytes: MAX_FILE_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxFrames: MAX_FRAMES,
  maxPage: MAX_PAGE,
  timeoutMs: 30_000,
  pdftotext: 'pdftotext',
  tesseract: 'tesseract',
};

/** 类型守卫：值是否为对象记录 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只展开开头的 home 前缀标记 */
function expandHomePrefix(entry: string): string {
  if (entry === '~') return os.homedir();
  if (entry.startsWith('~/') || entry.startsWith(`~${String.fromCharCode(92)}`)) {
    return path.join(os.homedir(), entry.slice(2));
  }
  return entry;
}

/** 读取字符串数组字段（camelCase 优先，兼容 snake_case） */
function readStringArray(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string[] | undefined {
  const value = record[camel] ?? record[snake];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/** 读取非空字符串字段 */
function readStringField(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): string | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** 读取正有限数字字段 */
function readPositiveNumber(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): number | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** 读取布尔字段（只认显式 boolean） */
function readBoolean(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): boolean | undefined {
  for (const value of [record[camel], record[snake]]) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** 取整并夹到 [1, cap] */
function clampInt(value: number | undefined, fallback: number, cap: number): number {
  if (value === undefined) return fallback;
  const rounded = Math.floor(value);
  if (!Number.isFinite(rounded) || rounded < 1) return fallback;
  return Math.min(rounded, cap);
}

/** 把 YAML 里的插件配置解析成已知字段（未知键忽略，非法值回落默认） */
export function parseMediaConfig(value: unknown): MediaConfig {
  const source = isRecord(value) ? value : {};

  const cwdValue = readStringField(source, 'cwd', 'working_dir');
  const cwd =
    cwdValue !== undefined ? path.resolve(expandHomePrefix(cwdValue)) : DEFAULT_MEDIA_CONFIG.cwd;

  const ocrLanguage = readStringField(source, 'ocrLanguage', 'ocr_language');

  return {
    enabled: readBoolean(source, 'enabled', 'enabled') ?? DEFAULT_MEDIA_CONFIG.enabled,
    cwd,
    allowedRoots: readStringArray(source, 'allowedRoots', 'allowed_roots') ?? [],
    denyPaths: readStringArray(source, 'denyPaths', 'deny_paths') ?? [],
    maxFileBytes: clampInt(
      readPositiveNumber(source, 'maxFileBytes', 'max_file_bytes'),
      DEFAULT_MEDIA_CONFIG.maxFileBytes,
      MAX_FILE_BYTES,
    ),
    maxOutputBytes: clampInt(
      readPositiveNumber(source, 'maxOutputBytes', 'max_output_bytes'),
      DEFAULT_MEDIA_CONFIG.maxOutputBytes,
      MAX_OUTPUT_BYTES,
    ),
    maxFrames: clampInt(
      readPositiveNumber(source, 'maxFrames', 'max_frames'),
      DEFAULT_MEDIA_CONFIG.maxFrames,
      MAX_FRAMES,
    ),
    maxPage: clampInt(
      readPositiveNumber(source, 'maxPage', 'max_page'),
      DEFAULT_MEDIA_CONFIG.maxPage,
      MAX_PAGE,
    ),
    timeoutMs: clampInt(
      readPositiveNumber(source, 'timeoutMs', 'timeout_ms'),
      DEFAULT_MEDIA_CONFIG.timeoutMs,
      MAX_TIMEOUT_MS,
    ),
    pdftotext: readStringField(source, 'pdftotext', 'pdftotext') ?? DEFAULT_MEDIA_CONFIG.pdftotext,
    tesseract: readStringField(source, 'tesseract', 'tesseract') ?? DEFAULT_MEDIA_CONFIG.tesseract,
    ...(ocrLanguage !== undefined ? { ocrLanguage } : {}),
  };
}
