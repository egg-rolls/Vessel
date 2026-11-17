/**
 * `env_file` 顶层键：把密钥放在**文件**里，配置里只写路径。
 *
 * 为什么不是「配置里直接写 key」：那会绕过 `findExplicitSecretPaths` 的拦截与脱敏，
 * 也让 `vessel.yaml` 变成密钥仓库。这里值的唯一去处是**进程环境变量**，配置只留路径。
 *
 * 语法（够用就好，不做 dotenv 的全部方言）：
 * - `KEY=VALUE`，允许 `export ` 前缀（`export KEY=VALUE`）；
 * - 值可用单/双引号包住（引号内保留 `#` 与空格）；未加引号时行内 ` #…` 视为注释；
 * - `#` 开头的整行与空行忽略；
 * - 不展开 `$VAR` / `${VAR}`：展开会让「文件里是什么」不确定，也让排障更难。
 *
 * 安全约定：**任何返回值都不含值**——只回名字与计数，错误信息只带行号/键名。
 */

import { homedir } from 'node:os';
import path from 'node:path';

export interface EnvFileEntry {
  name: string;
  value: string;
}

export interface EnvFileParseIssue {
  /** 1 起始的行号 */
  line: number;
  message: string;
}

export interface EnvFileParseResult {
  entries: EnvFileEntry[];
  issues: EnvFileParseIssue[];
}

/** 只允许 `[A-Za-z_][A-Za-z0-9_]*`：跟 shell 的可用名字一致 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 单行解析（导出供测试/诊断复用）；不抛异常，坏行进 issues */
export function parseEnvFile(content: string): EnvFileParseResult {
  const entries: EnvFileEntry[] = [];
  const issues: EnvFileParseIssue[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) {
      issues.push({ line: index + 1, message: 'expected KEY=VALUE' });
      continue;
    }
    const name = line.slice(0, eq).trim();
    if (!ENV_NAME.test(name)) {
      issues.push({
        line: index + 1,
        message: `invalid env name ${JSON.stringify(name.slice(0, 40))}`,
      });
      continue;
    }

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // 引号：取到同种引号结束；引号内 `#` 与空格都算值
      const end = value.indexOf(quote, 1);
      if (end < 0) {
        issues.push({ line: index + 1, message: `unterminated quoted value for ${name}` });
        continue;
      }
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // 未加引号：只有「空白 + #」才是行内注释（值里的 `#` 保留）
      const hash = value.search(/[ \t]#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }

    entries.push({ name, value });
  }

  return { entries, issues };
}

/** 展开 `~` / `~/x`（不解析软链、不读内容） */
export function expandHomePath(target: string): string {
  if (target === '~') return homedir();
  if (target.startsWith('~/') || target.startsWith('~\\'))
    return path.join(homedir(), target.slice(2));
  return target;
}

export interface EnvFileLoadInfo {
  /** 解析后的绝对路径 */
  path: string;
  /** 真正注入的键名（值不出现） */
  loaded: string[];
  /** 已在真实环境里存在、因此被跳过的键名（真实 env 优先） */
  preserved: string[];
  /** 解析问题（只带行号与键名） */
  issues: EnvFileParseIssue[];
}

export interface EnvFileLoadResult {
  files: EnvFileLoadInfo[];
  /** 致命错误（显式配置的路径读不到）；message 不含值 */
  errors: { path: string; message: string }[];
}

export interface LoadEnvFilesOptions {
  /** 每个文件各自的解析基准目录（缺省 `process.cwd()`） */
  baseDir?: string;
  /** 目标环境变量表；缺省 `process.env`（会被写入，模拟「启动时加载」） */
  target?: Record<string, string | undefined>;
  /** 读文件（注入用） */
  readFile?: (filePath: string) => Promise<string>;
}

/**
 * 加载一个或多个 env 文件到 `target`（缺省 process.env）。
 *
 * 优先级：**真实环境变量 > 文件**——文件只填「还没有」的键，不覆盖显式 export
 * （用户 `export KEY=...` 仍然赢，也让「CI 注入的临时值」不会被仓库里的文件盖掉）。
 * 文件名缺失 = **错误**（显式配置的路径不该静默忽略：那会变成「以为加载了，其实没有」）。
 */
export async function loadEnvFiles(
  configured: string | string[],
  options: LoadEnvFilesOptions = {},
): Promise<EnvFileLoadResult> {
  const target = options.target ?? (process.env as Record<string, string | undefined>);
  const baseDir = options.baseDir ?? process.cwd();
  const readFile = options.readFile ?? (async (filePath: string) => Bun.file(filePath).text());
  const paths = (Array.isArray(configured) ? configured : [configured])
    .map((item) => (item ?? '').trim())
    .filter((item) => item !== '')
    .map((item) => path.resolve(baseDir, expandHomePath(item)));

  const files: EnvFileLoadInfo[] = [];
  const errors: { path: string; message: string }[] = [];

  for (const filePath of paths) {
    let content: string;
    try {
      content = await readFile(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      errors.push({
        path: filePath,
        message:
          code === 'ENOENT'
            ? `env_file ${filePath} does not exist (configured explicitly, refusing to ignore it)`
            : `env_file ${filePath} could not be read (${code})`,
      });
      continue;
    }

    const parsed = parseEnvFile(content);
    const loaded: string[] = [];
    const preserved: string[] = [];
    for (const entry of parsed.entries) {
      const existing = target[entry.name];
      if (existing !== undefined && existing !== '') {
        preserved.push(entry.name);
        continue;
      }
      target[entry.name] = entry.value;
      loaded.push(entry.name);
    }
    files.push({ path: filePath, loaded, preserved, issues: parsed.issues });
  }

  return { files, errors };
}
