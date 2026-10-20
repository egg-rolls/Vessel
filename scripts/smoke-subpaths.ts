#!/usr/bin/env bun

/**
 * subpath exports 冒烟（0.2 R8c）。
 *
 * 对 `packages/core/package.json` 的每个 exports 入口执行动态 import：
 * - 根入口 `@vessel-agent/core`：断言 0.1 公开符号仍然存在（兼容性）；
 * - 子路径：断言关键符号存在；`./types` 是纯类型入口，允许运行时为空。
 *
 * 新增 subpath 时必须同步更新 `SMOKE_TARGETS`；测试会校验两边的键一致。
 *
 * 用法：bun run scripts/smoke-subpaths.ts
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = '@vessel-agent/core';

/** 0.1 根入口必须保持的运行时符号（类型导出在运行时不可见）。 */
export const ROOT_COMPAT_SYMBOLS = [
  'AgentRuntime',
  'AnthropicProvider',
  'FileEventStore',
  'FileSessionBackend',
  'MemoryContextManager',
  'MemoryEventStream',
  'MemoryLimitChecker',
  'MemoryLLMProvider',
  'MemoryPluginHost',
  'MemorySessionBackend',
  'OpenAICompatibleProvider',
  'SQLiteSessionBackend',
  'replayRun',
] as const;

/** 0.2 kernel / transport 新增的根导出。 */
export const ROOT_0_2_SYMBOLS = [
  'createCancellationScope',
  'createRuntime',
  'InProcessRuntimeHost',
  'InProcessScheduler',
  'InProcessTransport',
  'MemoryEventBus',
] as const;

/** 0.3 durable run 新增的根导出。 */
export const ROOT_0_3_SYMBOLS = ['FileRunStore', 'MemoryRunStore', 'RunResumeError'] as const;

/** 0.4 observability 新增的根导出（类型导出在运行时不可见）。 */
export const ROOT_0_4_SYMBOLS = ['MetricsCollector', 'pruneRuns'] as const;

/** 每个 subpath 必须存在的运行时符号；`./types` 允许为空。 */
export const SMOKE_TARGETS: Readonly<Record<string, readonly string[]>> = {
  '.': [...ROOT_COMPAT_SYMBOLS, ...ROOT_0_2_SYMBOLS, ...ROOT_0_3_SYMBOLS, ...ROOT_0_4_SYMBOLS],
  './context': ['MemoryContextManager'],
  './kernel': [
    'createCancellationScope',
    'createRuntime',
    'InProcessRuntimeHost',
    'InProcessScheduler',
    'MemoryEventBus',
  ],
  './observability': ['FileEventStore', 'MemoryEventStream', 'MetricsCollector', 'replayRun'],
  './policy': ['GuardrailRunner', 'HookRunner', 'PermissionPolicy', 'GuardrailStage', 'HookType'],
  './provider': ['AnthropicProvider', 'MemoryLLMProvider', 'OpenAICompatibleProvider'],
  './session': [
    'FileSessionBackend',
    'FileRunStore',
    'MemoryRunStore',
    'MemorySessionBackend',
    'RunResumeError',
    'SQLiteSessionBackend',
    'deriveSessionMeta',
    'pruneRuns',
  ],
  './transport': ['InProcessTransport'],
  './types': [],
};

export interface SmokeFailure {
  subpath: string;
  message: string;
}

export interface SmokeResult {
  checked: string[];
  failures: SmokeFailure[];
}

async function importSubpath(
  subpath: string,
  resolverDir: string,
): Promise<Record<string, unknown>> {
  const specifier = subpath === '.' ? PACKAGE_NAME : `${PACKAGE_NAME}/${subpath.replace('./', '')}`;
  // 从依赖 core 的 workspace 包位置解析，走真实的 package exports。
  const resolved = Bun.resolveSync(specifier, resolverDir);
  return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
}

export async function runSmoke(root: string): Promise<SmokeResult> {
  const manifestPath = join(root, 'packages/core/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    exports?: Record<string, unknown>;
  };

  const exportKeys = Object.keys(manifest.exports ?? {}).sort();
  const targetKeys = Object.keys(SMOKE_TARGETS).sort();
  const failures: SmokeFailure[] = [];
  const checked: string[] = [];
  // 从 packages/config 解析（它依赖 @vessel-agent/core）；缺省回退到 core 自身。
  const resolverDir = existsSync(join(root, 'packages/config'))
    ? join(root, 'packages/config')
    : join(root, 'packages/core');

  if (exportKeys.join(',') !== targetKeys.join(',')) {
    failures.push({
      subpath: '(manifest)',
      message: `exports 与 SMOKE_TARGETS 不一致：exports=[${exportKeys.join(', ')}] targets=[${targetKeys.join(', ')}]`,
    });
    return { checked, failures };
  }

  for (const subpath of exportKeys) {
    const expected = SMOKE_TARGETS[subpath] ?? [];
    let loaded: Record<string, unknown>;

    try {
      loaded = await importSubpath(subpath, resolverDir);
    } catch (error) {
      failures.push({
        subpath,
        message: `import 失败：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    checked.push(subpath);

    for (const symbol of expected) {
      if (loaded[symbol] === undefined) {
        failures.push({ subpath, message: `缺少符号：${symbol}` });
      }
    }

    // 除纯类型入口外，模块至少应有一个运行时导出。
    if (subpath !== './types' && expected.length === 0 && Object.keys(loaded).length === 0) {
      failures.push({ subpath, message: '运行时导出为空（非 types 入口）' });
    }
  }

  return { checked, failures };
}

async function main(): Promise<void> {
  const result = await runSmoke(process.cwd());

  if (result.failures.length === 0) {
    console.log(
      `subpath smoke passed: ${result.checked.length} entries (${result.checked.join(', ')})`,
    );
    return;
  }

  console.error(`subpath smoke failed: ${result.failures.length} issue(s)`);
  for (const failure of result.failures) {
    console.error(`  ${failure.subpath}: ${failure.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
