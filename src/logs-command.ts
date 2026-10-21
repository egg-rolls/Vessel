/**
 * `vessel logs tail`（0.15）。
 *
 * 只读本地 gateway 日志：`<dataDir>/logs/gateway.log`（default）与
 * `gateway-<instance>.log`（命名实例）。不跟随、不修改文件。
 *
 * @module vessel/logs-command
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../packages/config/src/index';
import type { LogsCommandArgs } from './cli-args';
import { resolveDataDir } from './data-paths';
import { gatewayLogPath } from './gateway/daemon';
import { t } from './i18n';
import { ui } from './ui-style';

export interface LogsCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LogsCommandOptions extends Partial<LogsCommandArgs> {
  configPath?: string;
  userConfigPath?: string;
  env?: Record<string, string | undefined>;
  dataDir?: string;
}

/** 读取文件末尾 N 行（最多读 256 KiB，避免把大日志整个载入）。 */
async function readTailLines(path: string, lines: number): Promise<string[]> {
  const size = (await stat(path)).size;
  const windowBytes = 256 * 1024;
  const start = Math.max(0, size - windowBytes);
  const handle = await open(path, 'r');
  let text: string;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(size, windowBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  const parts = text.split(/\r?\n/);
  // 从文件中间读起时首行可能是截断的。
  if (start > 0 && parts.length > 0) parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.slice(-lines);
}

function instanceFromFileName(name: string): string | undefined {
  if (name === 'gateway.log') return 'default';
  const match = /^gateway-(.+)\.log$/.exec(name);
  return match?.[1];
}

async function resolveLogFiles(
  dataDir: string,
  instance: string | undefined,
): Promise<Array<{ instance: string; path: string }>> {
  if (instance !== undefined) {
    const path = gatewayLogPath(dataDir, instance);
    try {
      await stat(path);
      return [{ instance, path }];
    } catch {
      return [];
    }
  }
  const dir = join(dataDir, 'logs');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: Array<{ instance: string; path: string }> = [];
  for (const name of names) {
    const parsed = instanceFromFileName(name);
    if (parsed === undefined) continue;
    files.push({ instance: parsed, path: join(dir, name) });
  }
  return files;
}

/** 执行 `logs tail`；不存在日志时退出 1。 */
export async function logsCommand(options: LogsCommandOptions = {}): Promise<LogsCommandResult> {
  const env = options.env ?? process.env;
  const loaded = await loadConfig({
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    env,
  });
  const dataDir = options.dataDir ?? resolveDataDir(loaded.config, env);
  const lines = options.lines ?? 50;
  const files = await resolveLogFiles(dataDir, options.instance);

  if (files.length === 0) {
    const message = t('logs.notFound', { dir: join(dataDir, 'logs') });
    if (options.json === true) {
      return {
        exitCode: 1,
        stdout: JSON.stringify({ data_dir: dataDir, files: [] }, null, 2),
        stderr: '',
      };
    }
    return { exitCode: 1, stdout: '', stderr: message };
  }

  const contents: Array<{
    instance: string;
    path: string;
    size_bytes: number;
    modified_at: string | null;
    lines: string[];
  }> = [];
  const render: string[] = [];
  for (const file of files) {
    try {
      const stats = await stat(file.path);
      const tail = await readTailLines(file.path, lines);
      contents.push({
        instance: file.instance,
        path: file.path,
        size_bytes: stats.size,
        modified_at: Number.isFinite(stats.mtimeMs) ? new Date(stats.mtimeMs).toISOString() : null,
        lines: tail,
      });
      if (render.length > 0) render.push('');
      render.push(`==> ${file.path} (${file.instance}) <==`);
      render.push(...tail);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      render.push(ui.err(t('logs.tailFailed', { path: file.path, error: detail })));
    }
  }

  if (options.json === true) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ data_dir: dataDir, lines, files: contents }, null, 2),
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: render.join('\n'), stderr: '' };
}
