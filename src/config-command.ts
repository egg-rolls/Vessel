/**
 * `vessel config path|init|show`（0.5 E17 / PLAN §7.2–§7.4）
 *
 * - 一次性本地命令：不 bootstrap、不加载 provider、不加 tenant 锁；
 * - `config show` 输出始终脱敏；有校验错误 exit 1；
 * - `config init` 只写用户配置，不写真实密钥。
 *
 * @module vessel/config-command
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { buildConfigSnapshot, getUserConfigPath, loadConfig } from '../packages/config/src/index';
import { resolveDataDir } from './data-paths';

type EnvMap = Record<string, string | undefined>;

/** CLI 命令结果（CLI 层负责打印与 process.exit） */
export interface ConfigCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `config path` 选项 */
export interface ConfigPathOptions {
  json?: boolean;
  configPath?: string;
  userConfigPath?: string;
  env?: EnvMap;
}

/** `config init` 选项 */
export interface ConfigInitOptions {
  force?: boolean;
  json?: boolean;
  userConfigPath?: string;
}

/** `config show` 选项 */
export interface ConfigShowOptions {
  sources?: boolean;
  json?: boolean;
  tenantId?: string;
  configPath?: string;
  userConfigPath?: string;
  env?: EnvMap;
}

/** 用户配置模板（内嵌；不含真实密钥） */
export const USER_CONFIG_TEMPLATE = `# Vessel user config (YAML is the primary configuration format)
provider:
  name: openai
  model: gpt-4
  api_key_env: VESSEL_API_KEY
data_dir: ~/.vessel/data
tenant:
  default: default
trace:
  enabled: true
  level: full
`;

function formatError(error: { path: string; message: string }): string {
  return `${error.path}: ${error.message}`;
}

/** `vessel config path [--json]` */
export async function configPathCommand(
  options: ConfigPathOptions = {},
): Promise<ConfigCommandResult> {
  const env = options.env ?? process.env;
  const projectPath = path.resolve(options.configPath ?? 'vessel.yaml');
  const userPath = path.resolve(options.userConfigPath ?? getUserConfigPath());

  const { config } = await loadConfig({
    configPath: options.configPath,
    userConfigPath: options.userConfigPath,
    env,
  });
  const dataDir = resolveDataDir(config, env);

  const exists = { user: existsSync(userPath), project: existsSync(projectPath) };

  if (options.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ user: userPath, project: projectPath, data_dir: dataDir, exists }),
      stderr: '',
    };
  }

  return {
    exitCode: 0,
    stdout: [
      `user:    ${userPath} (${exists.user ? 'exists' : 'missing'})`,
      `project: ${projectPath} (${exists.project ? 'exists' : 'missing'})`,
      `data:    ${dataDir}`,
    ].join('\n'),
    stderr: '',
  };
}

/** `vessel config init [--force] [--json]` */
export async function configInitCommand(
  options: ConfigInitOptions = {},
): Promise<ConfigCommandResult> {
  const target = options.userConfigPath ?? getUserConfigPath();

  if (existsSync(target) && options.force !== true) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `config already exists at ${target}; use --force to overwrite`,
    };
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, USER_CONFIG_TEMPLATE, 'utf8');
  await chmod(target, 0o600).catch(() => {
    // POSIX best-effort；Windows 忽略
  });

  if (options.json) {
    return { exitCode: 0, stdout: JSON.stringify({ path: target, created: true }), stderr: '' };
  }
  return { exitCode: 0, stdout: `created ${target}`, stderr: '' };
}

/** `vessel config show [--sources] [--json] [--tenant <id>]` */
export async function configShowCommand(
  options: ConfigShowOptions = {},
): Promise<ConfigCommandResult> {
  const result = await loadConfig({
    configPath: options.configPath,
    userConfigPath: options.userConfigPath,
    tenantId: options.tenantId,
    env: options.env ?? process.env,
  });

  const warningText = result.validation.warnings.map(formatError).join('\n');

  if (result.validation.errors.length > 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: result.validation.errors.map(formatError).join('\n'),
    };
  }

  const snapshot = buildConfigSnapshot({
    config: result.config,
    sources: result.sources,
    paths: result.paths,
    tenantId: result.tenantId,
    tenantOverlayKeys: result.tenantOverlayKeys,
  });

  if (options.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(snapshot, null, 2),
      stderr: warningText,
    };
  }

  let stdout = stringifyYaml(snapshot.config);
  if (options.sources) {
    const lines = Object.entries(snapshot.sources)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, source]) => `${key}: ${source}`);
    stdout += `\n# sources\n${lines.join('\n')}\n`;
    if (snapshot.tenant_overlay_keys && snapshot.tenant_overlay_keys.length > 0) {
      stdout += `\n# tenant overlay keys\n${snapshot.tenant_overlay_keys.join('\n')}\n`;
    }
  }

  return { exitCode: 0, stdout, stderr: warningText };
}
