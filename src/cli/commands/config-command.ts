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
import {
  buildConfigSnapshot,
  type ConfigKeyExplanation,
  explainConfigKey,
  getUserConfigPath,
  loadConfig,
  PINNED_REQUEST_SCOPES,
  redactSourcePaths,
} from '../../../packages/config/src/index';
import {
  ENV_CADENCE_VALUES,
  ENV_CHANNEL_VALUES,
  loggingEnvOverrides,
} from '../../../packages/core/src/index';
import { formatConfigError, formatConfigErrors } from '../../config/config-error-format';
import {
  isSettableConfigKey,
  isUiErrorLevel,
  isUiLanguage,
  isUiStatusBars,
  isUiVerbosity,
  LOG_ENUM_VALUES,
  setUserConfigValue,
} from '../../config/ui-settings';
import { resolveDataDir } from '../../data/data-paths';
import { t } from '../../i18n';
import { ui } from '../output';

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
  configPath?: string;
  userConfigPath?: string;
  env?: EnvMap;
}

/** `config set` 选项（0.11） */
export interface ConfigSetOptions {
  json?: boolean;
  userConfigPath?: string;
}

/** `config explain` 选项（q-ax-config） */
export interface ConfigExplainOptions {
  json?: boolean;
  configPath?: string;
  userConfigPath?: string;
  env?: EnvMap;
}

/**
 * 用户配置模板（内嵌；不含真实密钥）。
 *
 * `api_key_env` 只是注释示例：生效的 `_env` 在变量缺失时会报错，
 * 模板必须能在零配置下直接启动（DECISION-020 §R1.6）。
 */
export const USER_CONFIG_TEMPLATE = `# Vessel user config (YAML is the primary configuration format)
provider:
  name: openai
  model: gpt-4
  # Read the key from an environment variable (must be set, otherwise startup fails):
  # api_key_env: VESSEL_API_KEY
  # For a custom OpenAI-compatible endpoint, set name: openai and uncomment:
  # base_url: https://api.example.com/v1
data_dir: ~/.vessel/data
tenant:
  default: default
trace:
  enabled: true
  level: full
`;

function formatError(error: { path: string; message: string }): string {
  return formatConfigError(error);
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
      stderr: t('config.init.exists', { path: target }),
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
  return {
    exitCode: 0,
    stdout: [ui.ok(`created ${target}`), t('config.init.next')].join('\n'),
    stderr: '',
  };
}

/**
 * `vessel config set <key> <value> [--json]`（0.11；0.11.1 / 0.13 扩展键）。
 * 支持 `ui.language` / `ui.showReasoning` / `ui.statusBars` / `agent.cwd`；
 * 只写用户配置（YAML），保留其它键。
 */
export async function configSetCommand(
  key: string,
  value: string,
  options: ConfigSetOptions = {},
): Promise<ConfigCommandResult> {
  if (!isSettableConfigKey(key)) {
    return { exitCode: 2, stdout: '', stderr: t('config.set.unknownKey', { key }) };
  }

  let parsed: string | boolean | number = value;
  if (key === 'ui.language') {
    if (!isUiLanguage(value)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidLanguage', { value }),
      };
    }
  } else if (key === 'ui.showReasoning') {
    if (value !== 'true' && value !== 'false') {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidBoolean', { key, value }),
      };
    }
    parsed = value === 'true';
  } else if (key === 'ui.statusBars') {
    if (!isUiStatusBars(value)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidStatusBars', { value }),
      };
    }
  } else if (key === 'ui.verbosity') {
    if (!isUiVerbosity(value)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidVerbosity', { value }),
      };
    }
  } else if (
    key === 'ui.showInternalEvents' ||
    key === 'ui.askUser' ||
    key === 'ui.expandCards' ||
    key === 'ui.showArchived'
  ) {
    if (value !== 'true' && value !== 'false') {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidBoolean', { key, value }),
      };
    }
    parsed = value === 'true';
  } else if (key.startsWith('ui.messageVisibility.')) {
    // q-msg-visibility：消息显示五 toggle（布尔）。
    if (value !== 'true' && value !== 'false') {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidBoolean', { key, value }),
      };
    }
    parsed = value === 'true';
  } else if (key === 'ui.errorLevel') {
    if (!isUiErrorLevel(value)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidErrorLevel', { value }),
      };
    }
  } else if (key === 'observability.showProcessErrors') {
    if (value !== 'true' && value !== 'false') {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidBoolean', { key, value }),
      };
    }
    parsed = value === 'true';
  } else if (key === 'emptyResponse.enabled' || key === 'emptyResponse.seamless') {
    if (value !== 'true' && value !== 'false') {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidBoolean', { key, value }),
      };
    }
    parsed = value === 'true';
  } else if (key === 'emptyResponse.maxRetries') {
    const retries = Number(value);
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidNumber', { key, min: 0, max: 10 }),
      };
    }
    parsed = retries;
  } else if (key === 'agent.teamMemberLimit') {
    // q-team-limit-config：与 config validator / serve config.set 同界（正整数 ≥1）。
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidNumber', { key, min: 1, max: Number.MAX_SAFE_INTEGER }),
      };
    }
    parsed = limit;
  } else if (key === 'vision.imageTokenBudgetRatio') {
    // q-vision-image-budget-fix ①B：与 config validator / serve config.set 同界（[0,1] 浮点）。
    const ratio = Number(value);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidNumber', { key, min: 0, max: 1 }),
      };
    }
    parsed = ratio;
  } else if (key === 'emptyResponse.nudge') {
    if (value.trim() === '') {
      return { exitCode: 2, stdout: '', stderr: t('config.set.invalidNudge') };
    }
    parsed = value.trim();
  } else if (key === 'envInjection.default' || key.startsWith('envInjection.scopes.')) {
    // q-env-config-set：节奏轴（与 serve config.set / config validator 同口径）。
    // request|run|off；pinned（trim/model）拒 request（前缀不变量），off 允许。
    const scope = key.startsWith('envInjection.scopes.')
      ? key.slice('envInjection.scopes.'.length)
      : undefined;
    const pinned =
      scope !== undefined && (PINNED_REQUEST_SCOPES as readonly string[]).includes(scope);
    const allowed = pinned ? ['run', 'off'] : [...ENV_CADENCE_VALUES];
    if (!allowed.includes(value)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidEnum', { key, allowed: allowed.join(' | ') }),
      };
    }
  } else if (key.startsWith('envInjection.channels.')) {
    // q-env-config-set：通道轴（model+ui|ui-only）。
    if (!(ENV_CHANNEL_VALUES as readonly string[]).includes(value)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidEnum', {
          key,
          allowed: ENV_CHANNEL_VALUES.join(' | '),
        }),
      };
    }
  } else if (LOG_ENUM_VALUES[key] !== undefined) {
    const allowed = LOG_ENUM_VALUES[key] ?? [];
    if (!allowed.includes(value)) {
      return {
        exitCode: 2,
        stdout: '',
        stderr: t('config.set.invalidEnum', { key, allowed: allowed.join(' | ') }),
      };
    }
  } else if (value.trim() === '') {
    return {
      exitCode: 2,
      stdout: '',
      stderr: t('config.set.invalidPath', { value }),
    };
  } else {
    parsed = value.trim();
  }

  const target = options.userConfigPath ?? getUserConfigPath();
  try {
    await setUserConfigValue(key, parsed, { configPath: target });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: t('config.set.failed', {
        detail: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  if (options.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ key, value: parsed, path: target }),
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: ui.ok(`${key} = ${String(parsed)} (${target})`), stderr: '' };
}

/** `vessel config show [--sources] [--json]` */
export async function configShowCommand(
  options: ConfigShowOptions = {},
): Promise<ConfigCommandResult> {
  const result = await loadConfig({
    configPath: options.configPath,
    userConfigPath: options.userConfigPath,
    env: options.env ?? process.env,
  });

  const warningText = result.validation.warnings.map(formatError).join('\n');

  if (result.validation.errors.length > 0) {
    const errors = result.validation.errors.map(({ path, message }) => ({ path, message }));
    return {
      exitCode: 1,
      // 结构化输出始终在 stdout：脚本无需解析 stderr。
      stdout: options.json ? JSON.stringify({ errors }) : '',
      stderr: formatConfigErrors(result.validation.errors, { paths: result.paths }),
    };
  }

  const snapshot = buildConfigSnapshot({
    config: result.config,
    sources: result.sources,
    paths: result.paths,
    tenantId: result.tenantId,
  });

  // 日志中枢的环境变量覆盖提示：config 值仍在，但运行时被环境压住（排障临时覆盖）。
  const logOverrideNote = loggingEnvOverrides()
    .map(
      (override) =>
        `observability.log.${override.key} overridden by ${override.env} (${override.value})`,
    )
    .join('; ');

  if (options.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(snapshot, null, 2),
      stderr: [warningText, logOverrideNote === '' ? '' : `log: ${logOverrideNote}`]
        .filter((part) => part !== '')
        .join('\n'),
    };
  }

  let stdout = stringifyYaml(snapshot.config);
  if (logOverrideNote !== '') stdout += `\n# log: ${logOverrideNote}\n`;
  if (options.sources) {
    // 快照构造已脱敏；这里再走一次导出函数，保证 web/TUI 复用同一语义。
    const lines = Object.entries(redactSourcePaths(snapshot.sources))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, source]) => `${key}: ${source}`);
    stdout += `\n# sources\n${lines.join('\n')}\n`;
  }

  return { exitCode: 0, stdout, stderr: warningText };
}

/** explain 的值展示（与 TUI displayValue 同口径；值已在 config 包脱敏）。 */
function explainDisplayValue(value: unknown): string {
  if (value === undefined) return '<unset>';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length === 0 ? '""' : value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 单个键的逐层溯源块（人类可读）。 */
function formatKeyExplanation(explanation: ConfigKeyExplanation): string {
  const lines = [`key = ${explanation.key}`];
  for (const entry of explanation.layers) {
    const label = entry.layer === 'default' ? 'default' : `${entry.layer} (${entry.origin})`;
    lines.push(
      `  ${label}: ${explainDisplayValue(entry.value)}${entry.winner ? '  ← WINNER' : ''}`,
    );
  }
  lines.push(
    `effective: ${explainDisplayValue(explanation.effective)} (winner: ${explanation.winner})`,
  );
  for (const note of explanation.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

/**
 * `vessel config explain <key> [--json]`（q-ax-config：AX 自服务·配置溯源）。
 *
 * 一次性本地命令（与 config show 同族）：不 bootstrap、不连 gateway —— 逐层值
 * 直接来自 `loadConfig({ captureLayers: true })`，因此不需要新增 RPC。
 * key 支持 snake_case / camelCase，也支持前缀（如 `provider` → 其下所有叶子键）。
 * 诊断命令：配置有校验错误时照常解释（错误以 ⚠ 列出），exit 0；未知键 exit 1。
 */
export async function configExplainCommand(
  key: string,
  options: ConfigExplainOptions = {},
): Promise<ConfigCommandResult> {
  const env = options.env ?? process.env;
  const loaded = await loadConfig({
    configPath: options.configPath,
    userConfigPath: options.userConfigPath,
    env,
    captureLayers: true,
  });
  const explained = explainConfigKey(key, loaded, { env });

  if (!explained.ok) {
    const hint =
      explained.suggestions.length > 0 ? `\nDid you mean: ${explained.suggestions.join(', ')}` : '';
    return {
      exitCode: 1,
      stdout: options.json
        ? JSON.stringify({ error: explained.message, suggestions: explained.suggestions })
        : '',
      stderr: `${explained.message}${hint}`,
    };
  }

  if (options.json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          key: explained.requestedKey,
          explanations: explained.keys,
          paths: loaded.paths,
          ...(explained.configErrors.length > 0 ? { config_errors: explained.configErrors } : {}),
          ...(explained.configWarnings.length > 0
            ? { config_warnings: explained.configWarnings }
            : {}),
        },
        null,
        2,
      ),
      stderr: '',
    };
  }

  const lines: string[] = [];
  for (const error of explained.configErrors) {
    lines.push(`⚠ config error: ${error.path}: ${error.message}`);
  }
  for (const warning of explained.configWarnings) {
    lines.push(`⚠ config warning: ${warning.path}: ${warning.message}`);
  }
  if (lines.length > 0) lines.push('');
  lines.push(explained.keys.map(formatKeyExplanation).join('\n\n'));
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
