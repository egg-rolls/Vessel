/**
 * 用户配置文件读写原语（model-registry P1 前置重构，自 src/ui-settings.ts 移入）。
 *
 * 读写 `~/.vessel/config.yaml` 的 YAML 根对象：parse/stringify、同目录临时文件 + rename、
 * 0600；调用方只改目标块，根对象与目标块的其它键保留。
 * 错误码逐字保留 `ui_settings_*` 前缀（既有 CLI / TUI 消费者按这些码匹配）。
 * 跨进程写锁见 `./config-lock.ts`（withConfigLock），包裹「读 → 改 → 写」。
 *
 * @module @vessel-agent/config
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取 YAML 根对象；不存在/空文档返回 {}；根不是对象时抛错 */
export async function readUserConfigRoot(configPath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`ui_settings_read_failed: ${configPath}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    // 不回显文件内容（可能含密钥）。
    throw new Error(`ui_settings_parse_failed: ${configPath}: ${messageOf(error)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    throw new Error(`ui_settings_invalid_config: ${configPath} must contain a YAML object`);
  }
  return parsed;
}

/** 原子写入（同目录临时文件 + rename）；保留文件其它内容 */
export async function writeUserConfigRoot(
  configPath: string,
  root: Record<string, unknown>,
): Promise<void> {
  // 绝对路径化（D-3）：UI project 层经 config.set scope=project 传入相对路径
  // （loadConfig 缺省 'vessel.yaml'），dirname 得 '.'，Windows 上 mkdir('.')
  // 即使 recursive 也恒抛 EEXIST。resolve 基于 cwd，与读侧 loadRawConfig 及
  // withConfigLock（path.resolve(lockPath)）同口径；绝对路径入参逐字不变。
  const target = path.resolve(configPath);
  await mkdir(path.dirname(target), { recursive: true });
  const body = stringifyYaml(root, { lineWidth: 0 });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (error) {
    // Windows 上目标被占用时 rename 可能失败：清理临时文件后显式替换。
    try {
      await unlink(tmp);
    } catch {
      // 忽略清理失败
    }
    try {
      await writeFile(target, body, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      throw new Error(`ui_settings_write_failed: ${target}: ${messageOf(error)}`);
    }
  }
  // POSIX：rename 后保持 0600；Windows 上 best-effort。
  await chmod(target, 0o600).catch(() => {
    // 平台不保证 mode：忽略
  });
}
