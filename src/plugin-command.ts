/**
 * `vessel plugin list|install <path>|remove <name>`（0.6.1 E9）。
 *
 * 只操作本地目录：安装目标固定为用户插件目录
 * `VESSEL_PLUGINS_DIR` → `~/.vessel/plugins`。不做市场、不联网、不解析依赖。
 * 安装/移除后需重启进程（插件目录启动时扫描一次）。
 *
 * @module vessel/plugin-command
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type PluginConfig } from '../packages/config/src/index';
import type { PluginCommandArgs } from './cli-args';
import { declarativePluginEntries } from './plugin-config';
import { defaultPluginRoots, PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { ui } from './ui-style';

/** 与 CLI 解析一致的插件短名（防止路径穿越） */
const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PluginCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 测试注入（CLI 调用只用第一个参数） */
export interface PluginCommandOptions {
  env?: Record<string, string | undefined>;
  configPath?: string;
  userConfigPath?: string;
  /** 覆盖用户插件目录（缺省 VESSEL_PLUGINS_DIR / ~/.vessel/plugins） */
  userDir?: string;
}

/** 用户插件目录：VESSEL_PLUGINS_DIR → ~/.vessel/plugins */
export function resolveUserPluginsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.VESSEL_PLUGINS_DIR;
  const dir =
    typeof configured === 'string' && configured.trim() !== ''
      ? configured
      : path.join(os.homedir(), '.vessel', 'plugins');
  return path.resolve(dir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 plugin 目录的 package.json 读取短名；不合法返回错误 */
function readPluginName(
  sourceDir: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const pkgPath = path.join(sourceDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, error: `Not a plugin directory (missing package.json): ${sourceDir}` };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch (error) {
    return {
      ok: false,
      error: `Invalid package.json in ${sourceDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!isRecord(pkg) || typeof pkg.name !== 'string' || pkg.name === '') {
    return { ok: false, error: `package.json in ${sourceDir} has no "name"` };
  }
  const name = pkg.name.replace(/^@[^/]+\//, '');
  if (!PLUGIN_NAME_RE.test(name)) {
    return { ok: false, error: `Invalid plugin name "${name}"` };
  }
  return { ok: true, name };
}

/** 是否有可解析的入口（src/index.ts 或 package.json 指向的文件） */
function hasEntry(sourceDir: string): boolean {
  if (fs.existsSync(path.join(sourceDir, 'src', 'index.ts'))) return true;
  if (fs.existsSync(path.join(sourceDir, 'index.ts'))) return true;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const candidates: string[] = [];
    if (typeof pkg.main === 'string') candidates.push(pkg.main);
    if (typeof pkg.module === 'string') candidates.push(pkg.module);
    if (typeof pkg.exports === 'string') {
      candidates.push(pkg.exports);
    } else if (isRecord(pkg.exports)) {
      const dot = pkg.exports['.'];
      if (typeof dot === 'string') {
        candidates.push(dot);
      } else if (isRecord(dot)) {
        for (const key of ['bun', 'import', 'default', 'require']) {
          const value = dot[key];
          if (typeof value === 'string') candidates.push(value);
        }
      }
    }
    return candidates.some((candidate) => fs.existsSync(path.resolve(sourceDir, candidate)));
  } catch {
    return false;
  }
}

/** 构造扫描器：用实际 userDir 替换默认用户目录（测试隔离） */
function makeLoader(userDir: string): PluginLoader {
  const roots = defaultPluginRoots();
  const userIndex = roots.findIndex((root) => root.source === 'user');
  if (userIndex >= 0) roots[userIndex] = { dir: userDir, source: 'user', layout: 'auto' };
  return new PluginLoader({ roots });
}

/** 读取启用状态（不构造 runtime） */
async function readEnabledNames(options: PluginCommandOptions): Promise<{
  names: Set<string>;
  configured: PluginConfig[] | undefined;
}> {
  const env = options.env ?? process.env;
  const { config } = await loadConfig({
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.userConfigPath !== undefined ? { userConfigPath: options.userConfigPath } : {}),
    env,
  });
  const declarative = declarativePluginEntries(config);
  const loader = makeLoader(options.userDir ?? resolveUserPluginsDir(env));
  const selection = resolvePluginSelection(
    loader,
    config.plugins,
    Boolean(env.VESSEL_DEBUG),
    declarative,
    env,
  );
  warnExternalPluginsOnce(selection.external);
  const names = new Set(selection.names);
  // 工厂式插件不进 PluginLoader 名单，但确有启用语义；列表按实际装配标注。
  if (config.delegate?.enabled !== false) names.add('delegate-task');
  if (config.team?.enabled === true) names.add('team');
  if (Object.values(config.mcpServers ?? {}).some((server) => server.enabled !== false)) {
    names.add('mcp-client');
  }
  if (config.workflow?.enabled === true) names.add('workflow');
  if (config.evals?.enabled === true) names.add('evals');
  if (config.feishu?.enabled === true) names.add('feishu');
  if (config.provider?.name) names.add(`provider-${config.provider.name}`);
  return { names, configured: config.plugins };
}

/** 执行 plugin 子命令 */
export async function runPluginCommand(
  command: PluginCommandArgs,
  options: PluginCommandOptions = {},
): Promise<PluginCommandResult> {
  const userDir = options.userDir ?? resolveUserPluginsDir(options.env ?? process.env);

  if (command.kind === 'list') {
    try {
      const loader = makeLoader(userDir);
      const { names } = await readEnabledNames(options);
      const rows = loader.list().map((descriptor) => ({
        name: descriptor.name,
        version: descriptor.version,
        category: descriptor.category,
        source: descriptor.source,
        entry: descriptor.entry,
        enabled: names.has(descriptor.name),
      }));

      if (command.json) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ plugins: rows }, null, 2),
          stderr: '',
        };
      }
      if (rows.length === 0) {
        return { exitCode: 0, stdout: ui.dim('No plugins found.'), stderr: '' };
      }

      const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
      const sourceWidth = Math.max(6, ...rows.map((row) => row.source.length));
      const categoryWidth = Math.max(8, ...rows.map((row) => row.category.length));
      const lines = [
        ui.section(`Plugins (${rows.length}; user dir: ${userDir}):`),
        `  ${'NAME'.padEnd(nameWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  ${'CATEGORY'.padEnd(categoryWidth)}  ${'VERSION'.padEnd(8)}  ENABLED`,
      ];
      for (const row of rows) {
        lines.push(
          `  ${row.name.padEnd(nameWidth)}  ${row.source.padEnd(sourceWidth)}  ${row.category.padEnd(categoryWidth)}  ${row.version.padEnd(8)}  ${row.enabled ? 'yes' : 'no'}`,
        );
      }
      return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (command.kind === 'install') {
    const sourceDir = path.resolve(process.cwd(), command.path);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      return { exitCode: 1, stdout: '', stderr: `Not a directory: ${sourceDir}` };
    }
    if (!hasEntry(sourceDir)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Plugin has no resolvable entry (src/index.ts or package.json main): ${sourceDir}`,
      };
    }
    const named = readPluginName(sourceDir);
    if (!named.ok) return { exitCode: 1, stdout: '', stderr: named.error };
    const destination = path.join(userDir, named.name);

    const sourceResolved = path.resolve(sourceDir);
    if (sourceResolved === path.resolve(destination)) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Plugin is already installed at ${destination}`,
      };
    }
    if (fs.existsSync(destination) && !command.force) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Plugin "${named.name}" already exists at ${destination} (use --force to replace)`,
      };
    }

    try {
      fs.mkdirSync(userDir, { recursive: true });
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(sourceDir, destination, {
        recursive: true,
        force: true,
        filter: (src) => path.basename(src) !== '.git',
      });
      let configured: PluginConfig[] | undefined;
      try {
        ({ configured } = await readEnabledNames(options));
      } catch {
        // 配置无效不影响安装本身；只给出通用提示。
      }
      return {
        exitCode: 0,
        stdout: [
          ui.ok(`Installed "${named.name}" -> ${destination}`),
          configured === undefined
            ? 'Restart Vessel to load it (user plugins load by default when plugins: is absent).'
            : 'Restart Vessel after enabling it in plugins:.',
        ].join('\n'),
        stderr: '',
      };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // remove
  if (!PLUGIN_NAME_RE.test(command.name)) {
    return { exitCode: 1, stdout: '', stderr: `Invalid plugin name: ${command.name}` };
  }
  const destination = path.join(userDir, command.name);
  if (!fs.existsSync(destination)) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Plugin "${command.name}" is not installed in ${userDir}`,
    };
  }

  try {
    fs.rmSync(destination, { recursive: true, force: false });
    return {
      exitCode: 0,
      stdout: `Removed "${command.name}" from ${userDir}.\nRestart Vessel to apply.`,
      stderr: '',
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
