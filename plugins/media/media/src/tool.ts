/**
 * @vessel-agent/media - 单个 `media` 工具
 * @module @vessel-agent/media/tool
 *
 * action = read | ocr | describe，path 必填，page / frames 可选。
 * - read：文本直读；PDF 走 pdftotext（按页取，缺 CLI 时明确报错）；
 * - ocr：图片 OCR 走 tesseract（缺 CLI 时明确报错）；
 * - describe：交多模态 bridge（未配置时明确报错，不静默降级）。
 *
 * 约束：路径边界复用 basic-tools 的 evaluatePath / allowed_roots；单文件 20 MiB；
 * 单次输出 32 KiB（超出截断并标注 truncated）；page / frames 有上限；
 * 尊重 ctx.signal；所有失败都返回错误字符串，不抛异常（run 不失败）。
 */

import { readFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalPath, evaluatePath, type PathBoundary } from '@vessel-agent/basic-tools';
import type { ToolContext, ToolDefinition } from '@vessel-agent/core';
import type { MediaBackends } from './binaries.js';
import type { MediaConfig } from './config.js';
import { runCli } from './exec.js';

/** 取消文案（与 basic-tools 同口径） */
export const CANCELLED_TEXT = '错误：操作已取消（cancelled）。';
/**
 * 取消判定：单独成函数，避免 TS 因前面的早退把 signal.aborted 窄化成 false 而报
 * 「比较永不成立」。await 之间随时可能 abort，所以调用点仍需复检。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** 图片后缀（OCR / describe 支持面） */
const IMAGE_EXTS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.tif',
  '.tiff',
  '.bmp',
]);

/** 后缀到 MIME（describe 传给多模态 bridge） */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

/** 多模态描述请求 */
export interface DescribeRequest {
  /** 绝对路径 */
  path: string;
  /** 由后缀推断的 MIME（不可信，仅供 bridge 选择处理方式） */
  mime: string;
  /** 文件字节 */
  data: Buffer;
  /** 字节数（= data.byteLength） */
  bytes: number;
  /** 当前 run 的取消信号 */
  signal?: AbortSignal;
}

/**
 * 多模态描述桥：由装配层注入（provider 多模态接口）。
 * 缺省不存在 = 未配置多模态模型，describe 明确报错，不降级。
 */
export type DescribeBridge = (request: DescribeRequest) => Promise<string>;

/** 工具依赖（构造期固定） */
export interface MediaToolDeps {
  config: MediaConfig;
  boundary: PathBoundary;
  backends: MediaBackends;
  /** 多模态桥；缺省 = 未配置 */
  describe?: DescribeBridge;
  /** CLI 执行器（测试可替换） */
  run?: typeof runCli;
}

/** 支持的动作 */
export type MediaAction = 'read' | 'ocr' | 'describe';

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

/** 按配置 cwd 解析输入为绝对路径 */
function resolveInput(config: MediaConfig, input: string): string {
  return path.resolve(config.cwd, expandHomePrefix(input));
}

/** 人类可读的 MiB 文案 */
function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 按字节上限截断（UTF-8 安全：只切在码点边界之外的部分会被丢弃） */
export function capOutput(
  text: string,
  maxBytes: number,
): { text: string; totalBytes: number; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf-8');
  const totalBytes = buffer.byteLength;
  if (totalBytes <= maxBytes) return { text, totalBytes, truncated: false };
  let sliced = buffer.subarray(0, maxBytes).toString('utf-8');
  // 截断可能切在多字节字符中间，尾部替换字符丢掉
  if (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1);
  return { text: sliced, totalBytes, truncated: true };
}

/** 截断标注（契约：超出截断并标 truncated） */
function truncationNote(totalBytes: number, maxBytes: number): string {
  return (
    '\n\n…（输出超过 ' +
    maxBytes +
    ' 字节上限，truncated；原始 ' +
    totalBytes +
    ' 字节。可用 page / frames 分段读取）'
  );
}

/** 结果统一收口：拼装 + 字节上限 + 截断标注（标注本身也占用预算，总量不超上限） */
function finalize(parts: readonly string[], config: MediaConfig): string {
  const raw = parts.filter((part) => part !== '').join('\n');
  const budget = config.maxOutputBytes;
  const capped = capOutput(raw, budget);
  if (!capped.truncated) return capped.text;

  const note = truncationNote(capped.totalBytes, budget);
  const noteBytes = Buffer.byteLength(note, 'utf-8');
  if (budget <= noteBytes) return capped.text;
  const body = capOutput(raw, budget - noteBytes);
  return body.text + note;
}

/** 读取数字参数（非有限数返回 undefined，由调用方决定报错还是回落默认） */
function readIntArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return undefined;
}

/** 解析 page / frames（越界返回错误文案） */
function parseRange(
  args: Record<string, unknown>,
  config: MediaConfig,
  defaults: { page: number; frames: number },
): { page: number; frames: number } | { error: string } {
  const page = readIntArg(args, 'page') ?? defaults.page;
  if (!Number.isInteger(page) || page < 1) {
    return { error: '错误：page 必须是不小于 1 的整数（1-based）。' };
  }
  if (page > config.maxPage) {
    return { error: `错误：page 超过上限（${config.maxPage}）。` };
  }
  const frames = readIntArg(args, 'frames') ?? defaults.frames;
  if (!Number.isInteger(frames) || frames < 1) {
    return { error: '错误：frames 必须是不小于 1 的整数。' };
  }
  if (frames > config.maxFrames) {
    return { error: `错误：frames 超过上限（${config.maxFrames}）。` };
  }
  return { page, frames };
}

/** 路径校验 + stat 的统一结果 */
type PathCheck =
  | { ok: true; target: string; bytes: number; ext: string }
  | { ok: false; message: string };

/** 解析路径并做边界 / 存在性 / 类型 / 体积检查 */
async function checkPath(rawPath: string, deps: MediaToolDeps): Promise<PathCheck> {
  const input = rawPath.trim();
  if (input === '') return { ok: false, message: '错误：path 不能为空。' };

  const absolute = resolveInput(deps.config, input);
  const target = canonicalPath(absolute);

  // 纵深防御：即使调用方绕过 checkPermission，deny 目录仍然拒绝
  const decision = evaluatePath(target, deps.boundary);
  if (decision === 'deny') {
    // 权限可追溯：这是路径策略的拒绝，不是文件不存在；不复述完整路径（入参里已有）。
    return {
      ok: false,
      message:
        '错误：该路径被路径策略拒绝（deny 目录 / denylist），不是文件不存在。改用允许范围内的路径，或由用户调整 deny_paths。',
    };
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    return { ok: false, message: `错误：文件不存在或无法访问：${input}` };
  }
  if (info.isDirectory()) {
    return { ok: false, message: `错误：${input} 是目录，不是文件。` };
  }
  if (!info.isFile()) {
    return { ok: false, message: `错误：${input} 不是普通文件。` };
  }
  if (info.size > deps.config.maxFileBytes) {
    return {
      ok: false,
      message:
        '错误：文件过大（' +
        formatMiB(info.size) +
        '，上限 ' +
        formatMiB(deps.config.maxFileBytes) +
        '）：' +
        input +
        '。请先在外部切分 / 压缩，或用 bash 分块处理。',
    };
  }
  return { ok: true, target, bytes: info.size, ext: path.extname(target).toLowerCase() };
}

/** 把 CLI 的失败折成人读错误文案 */
function cliFailureText(
  label: string,
  result: Awaited<ReturnType<typeof runCli>>,
  config: MediaConfig,
): string | undefined {
  if (result.aborted) return CANCELLED_TEXT;
  if (result.spawnError !== undefined) {
    return `错误：无法执行 ${label}：${result.spawnError}。`;
  }
  if (result.timedOut) {
    return `错误：${label} 超时（${config.timeoutMs}ms）。`;
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    return `错误：${label} 退出码 ${String(result.code)}${detail === '' ? '。' : `：${detail}`}`;
  }
  return undefined;
}

/** PDF 抽文本（pdftotext） */
async function readPdf(
  target: string,
  args: Record<string, unknown>,
  deps: MediaToolDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
  const cli = deps.backends.pdftotext;
  if (cli === undefined) {
    return (
      '错误：read 无法解析 PDF：未找到 pdftotext。' +
      '请安装 poppler-utils（或配置 plugins[].config.pdftotext 指向可执行文件）；' +
      '未安装时该插件不注册 media 工具。'
    );
  }
  const range = parseRange(args, deps.config, { page: 1, frames: 1 });
  if ('error' in range) return range.error;

  const lastPage = range.page + range.frames - 1;
  const run = deps.run ?? runCli;
  const result = await run(
    cli,
    ['-f', String(range.page), '-l', String(lastPage), '-enc', 'UTF-8', '-layout', target, '-'],
    { signal, timeoutMs: deps.config.timeoutMs, maxBytes: deps.config.maxOutputBytes },
  );

  const failure = cliFailureText('pdftotext', result, deps.config);
  if (failure !== undefined) return failure;

  // pdftotext 用换页符分隔页；去掉尾部换页符避免看起来像多一页
  const body = result.stdout.replace(/\f+$/u, '').trimEnd();
  const pages = result.stdout.split('\f').filter((page) => page.trim() !== '').length;
  const header =
    target +
    '（PDF 第 ' +
    String(range.page) +
    (range.frames > 1 ? `-${String(lastPage)}` : '') +
    ' 页，本次有文本 ' +
    String(pages) +
    ' 页）';

  if (body.trim() === '') {
    return (
      '（' +
      target +
      '：第 ' +
      String(range.page) +
      (range.frames > 1 ? `-${String(lastPage)}` : '') +
      ' 页没有可抽取的文本，可能是扫描件或超出页数。可试 action=ocr 或调整 page。）'
    );
  }
  return finalize([header, '----', body], deps.config);
}

/** 文本直读 */
async function readText(target: string, bytes: number, deps: MediaToolDeps): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await readFile(target);
  } catch (error) {
    return `错误：读取失败：${String(error)}`;
  }
  const head = buffer.subarray(0, Math.min(buffer.byteLength, 8192));
  if (head.includes(0)) {
    return (
      '错误：' +
      target +
      ' 看起来是二进制文件（含 NUL 字节），read 只处理文本；' +
      '图片请用 action=ocr 或 action=describe，PDF 会自动走 pdftotext。'
    );
  }
  const text = buffer.toString('utf-8');
  return finalize([`${target}（文本，${String(bytes)} 字节）`, '----', text], deps.config);
}

/** 图片 OCR（tesseract） */
async function runOcr(
  target: string,
  ext: string,
  args: Record<string, unknown>,
  deps: MediaToolDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
  const cli = deps.backends.tesseract;
  if (cli === undefined) {
    return (
      '错误：action=ocr 需要 tesseract，但未在 PATH 中找到。' +
      '请安装 tesseract-ocr（或配置 plugins[].config.tesseract 指向可执行文件）；' +
      '未安装时该插件不注册 media 工具。'
    );
  }
  if (!IMAGE_EXTS.has(ext)) {
    return (
      '错误：action=ocr 只处理图片（' +
      [...IMAGE_EXTS].join(' / ') +
      '）：' +
      target +
      '。PDF 请用 action=read，其他格式请用 action=describe。'
    );
  }
  const range = parseRange(args, deps.config, { page: 1, frames: deps.config.maxFrames });
  if ('error' in range) return range.error;

  const cliArgs = [target, 'stdout'];
  if (deps.config.ocrLanguage !== undefined) cliArgs.push('-l', deps.config.ocrLanguage);

  const run = deps.run ?? runCli;
  const result = await run(cli, cliArgs, {
    signal,
    timeoutMs: deps.config.timeoutMs,
    maxBytes: deps.config.maxOutputBytes,
  });

  const failure = cliFailureText('tesseract', result, deps.config);
  if (failure !== undefined) return failure;

  // 多页 TIFF：按换页符切页，frames 限制取前 N 页
  const pages = result.stdout.split('\f');
  const sliced = pages.slice(0, range.frames).join('\f').trim();
  const header =
    target +
    '（OCR' +
    (deps.config.ocrLanguage !== undefined ? `，语言 ${deps.config.ocrLanguage}` : '') +
    '）';
  if (sliced === '') {
    return `（${target}：tesseract 未识别到文本（图片可能是纯色 / 无文字，或语言包缺失）。）`;
  }
  return finalize([header, '----', sliced], deps.config);
}

/** 多模态描述 */
async function runDescribe(
  target: string,
  ext: string,
  bytes: number,
  deps: MediaToolDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
  const bridge = deps.describe;
  if (bridge === undefined || !deps.backends.describe) {
    return (
      '错误：action=describe 需要多模态 provider，当前未配置（不会降级为 OCR / 纯文本）。' +
      '请先配置多模态模型，或改用 action=ocr / action=read。'
    );
  }
  if (!IMAGE_EXTS.has(ext)) {
    return (
      '错误：action=describe 当前只支持图片（' +
      [...IMAGE_EXTS].join(' / ') +
      '）：' +
      target +
      '。PDF 请用 action=read。'
    );
  }
  if (isAborted(signal)) return CANCELLED_TEXT;

  let data: Buffer;
  try {
    data = await readFile(target);
  } catch (error) {
    return `错误：读取失败：${String(error)}`;
  }
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  try {
    const described = await bridge({ path: target, mime, data, bytes, signal });
    const header = `${target}（describe，${mime}，${String(bytes)} 字节）`;
    return finalize([header, '----', described], deps.config);
  } catch (error) {
    if (isAborted(signal)) return CANCELLED_TEXT;
    return `错误：describe 调用失败：${String(error)}`;
  }
}

/** 当前后端支持的动作集合（未支持的动作不进 schema） */
export function supportedActions(deps: MediaToolDeps): MediaAction[] {
  const actions: MediaAction[] = ['read'];
  if (deps.backends.tesseract !== undefined) actions.push('ocr');
  if (deps.describe !== undefined && deps.backends.describe) actions.push('describe');
  return actions;
}

/** 动作描述（把已探测到的后端如实写进 schema） */
function describeActions(actions: readonly MediaAction[], deps: MediaToolDeps): string {
  const notes: string[] = [];
  if (actions.includes('read')) {
    notes.push(
      deps.backends.pdftotext !== undefined
        ? 'read=text files and PDF (pdftotext detected)'
        : 'read=text files; PDF is unavailable on this host (pdftotext not detected)',
    );
  }
  if (actions.includes('ocr')) notes.push('ocr=image OCR via tesseract');
  if (actions.includes('describe')) notes.push('describe=multimodal provider');
  return notes.join('; ');
}

/** 构造 media 工具 */
export function createMediaTool(deps: MediaToolDeps): ToolDefinition {
  const actions = supportedActions(deps);

  return {
    name: 'media',
    description:
      'Read one local attachment (image / PDF / text) referenced by the user. ' +
      'Actions: ' +
      describeActions(actions, deps) +
      '. PDF text is paged via page/frames; output is truncated at ' +
      String(deps.config.maxOutputBytes) +
      ' bytes (marked truncated). Prefer this over bash cat on binary files.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: 'read | ocr | describe',
        },
        path: {
          type: 'string',
          description: 'Absolute (or cwd-relative) path of the attachment',
        },
        page: {
          type: 'number',
          description: `First page to read (1-based, PDF only; max ${String(deps.config.maxPage)})`,
        },
        frames: {
          type: 'number',
          description:
            'How many pages/frames to take from page (max ' +
            String(deps.config.maxFrames) +
            '; read=PDF pages, ocr=multi-page TIFF pages)',
        },
      },
      required: ['action', 'path'],
    },
    display: { label: 'Media', kind: 'file' },
    // 只读解析；deny 目录硬拒，配置 allowed_roots 后越界 ask
    concurrencySafe: true,
    checkPermission: async (input) => {
      if (!isRecord(input)) return 'allow';
      const raw = input.path;
      if (typeof raw !== 'string' || raw.trim() === '') return 'allow';
      return evaluatePath(resolveInput(deps.config, raw.trim()), deps.boundary);
    },
    handler: async (args: unknown, ctx: ToolContext): Promise<string> => {
      const signal = ctx.signal;
      if (isAborted(signal)) return CANCELLED_TEXT;
      if (!isRecord(args)) return '错误：media 需要 { action, path }。';

      const action = args.action;
      if (action !== 'read' && action !== 'ocr' && action !== 'describe') {
        return '错误：action 必须是 read / ocr / describe。';
      }
      if (!actions.includes(action)) {
        if (action === 'ocr') {
          return (
            '错误：action=ocr 不可用（本机未探测到 tesseract）。' +
            '安装 tesseract-ocr 后重启进程即可启用。'
          );
        }
        if (action === 'describe') {
          return (
            '错误：action=describe 不可用（未配置多模态 provider，不会降级）。' +
            '请改用 action=ocr / action=read。'
          );
        }
      }

      const rawPath = args.path;
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return '错误：path 必填且不能为空。';
      }

      const checked = await checkPath(rawPath, deps);
      if (!checked.ok) return checked.message;
      if (isAborted(signal)) return CANCELLED_TEXT;

      if (action === 'read') {
        if (checked.ext === '.pdf') return readPdf(checked.target, args, deps, signal);
        return readText(checked.target, checked.bytes, deps);
      }
      if (action === 'ocr') {
        return runOcr(checked.target, checked.ext, args, deps, signal);
      }
      return runDescribe(checked.target, checked.ext, checked.bytes, deps, signal);
    },
  };
}
