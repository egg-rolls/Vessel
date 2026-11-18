#!/usr/bin/env bun

/**
 * Vessel 构建脚本：编排 typecheck + lint 两道检查。
 *
 * 插件由运行时扫描发现（src/plugin-loader.ts），无需构建期注册表；单二进制分发形态已废弃（ADR-006）。
 * `bun run typecheck` 同时覆盖 `examples/**`（examples/tsconfig.json）与 `apps/web`
 * （`apps/web` 有自己的 tsconfig 与 TS 5.9.3，用 `bun run --cwd apps/web typecheck` 串进根 typecheck）。
 *
 * ## 胜负口径（为什么不是「跑完就打印成功」）
 *
 * 1. **每一步都显式判返回码**：spawnSync 的 `status` 直接决定这一步过不过；任一不过立刻以非 0
 *    退出，`✅ … 通过` 与末尾的 `📦 Build complete!` **都不会出现**。
 * 2. **返回码之外还要看证据**：本机（WSL → Windows bun）出现过子进程出错但退出码被吞成 0 的
 *    情况（教训 L-047）。所以每一步还扫输出里的错误证据（`error TS####`、biome 的
 *    `Found N error` / `Some errors were emitted`）—— rc 干净但输出有证据，同样判不过。
 * 3. **成功行只在最后**：`📦 Build complete!` 在所有步骤都通过之后打印一次；它不再是无条件的
 *    进度文案，不能靠「我看到这句话」之外的路径出现。
 *
 * 使用方式：bun run scripts/build.ts（或 `bun run build`）
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

interface Step {
  title: string;
  command: string;
  /** rc=0 时也要判红的输出证据（兜底「退出码被吞」）。 */
  failurePatterns: RegExp[];
}

const STEPS: Step[] = [
  {
    title: 'Type check（root + examples + apps/web）',
    command: 'bun run typecheck',
    failurePatterns: [/error TS\d+/],
  },
  {
    title: 'Lint（biome ci .）',
    command: 'bun run lint',
    failurePatterns: [/Found\s+[1-9]\d*\s+error/, /Some errors were emitted/],
  },
];

/**
 * 前置检查：`apps/web` 不在根 workspaces 里，依赖要单独装。
 * 没装时 `bun run --cwd apps/web typecheck` 会退化成「根 tsc + 一堆找不到模块」，
 * 报错点指不到真因 —— 这里先给一句能直接照着做的提示，而不是让它伪装成类型错误。
 */
function preflight(): string | null {
  if (!existsSync(join(ROOT, 'apps/web/node_modules'))) {
    return 'apps/web 依赖没装：先 `cd apps/web && bun install`（或 npm ci），否则前端类型检查跑不起来';
  }
  return null;
}

/** 跑一步，返回 0 表示通过；非 0 表示失败（返回的是可以直接传出去的失败码）。 */
function runStep(step: Step, ordinal: number): number {
  console.log(`${ordinal}️⃣ ${step.title} — ${step.command}`);
  const result = spawnSync(step.command, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout !== '') process.stdout.write(stdout);
  if (stderr !== '') process.stderr.write(stderr);

  const rc = result.status ?? 1;
  const matched = step.failurePatterns.filter((pattern) => pattern.test(`${stdout}\n${stderr}`));

  if (rc !== 0 || matched.length > 0) {
    const reasons: string[] = [];
    if (rc !== 0) reasons.push(`返回码 ${String(rc)}`);
    if (matched.length > 0) {
      reasons.push(`输出里有错误证据（${matched.map((pattern) => String(pattern)).join(' / ')}）`);
    }
    console.error(`❌ ${step.title} 未通过：${reasons.join('；')}`);
    return rc !== 0 ? rc : 1;
  }

  console.log(`✅ ${step.title} 通过\n`);
  return 0;
}

function main(): number {
  console.log('🔨 Building Vessel...\n');

  const preflightError = preflight();
  if (preflightError !== null) {
    console.error(`❌ 前置检查未通过：${preflightError}`);
    return 1;
  }

  for (const [index, step] of STEPS.entries()) {
    const failed = runStep(step, index + 1);
    if (failed !== 0) return failed;
  }

  // 只有所有步骤都通过才会走到这里。
  console.log('📦 Build complete!');
  console.log('\nRun with: bun run src/cli.ts');
  return 0;
}

process.exit(main());
