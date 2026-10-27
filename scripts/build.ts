#!/usr/bin/env bun

/**
 * Vessel 构建脚本
 *
 * 只做质量门禁（typecheck / lint）——插件由运行时扫描发现（src/plugin-loader.ts），
 * 无需构建期注册表；单二进制分发形态已废弃（ADR-006）。
 * `bun run typecheck` 现在同时覆盖 `examples/**`（examples/tsconfig.json）。
 *
 * 使用方式：bun run scripts/build.ts
 */

import { execSync } from 'node:child_process';

console.log('🔨 Building Vessel...\n');

// 1. 运行类型检查
console.log('1️⃣ Running type check...');
try {
  execSync('bun run typecheck', { stdio: 'inherit' });
  console.log('✅ Type check passed\n');
} catch (_error) {
  console.error('❌ Type check failed');
  process.exit(1);
}

// 2. 运行 lint
console.log('2️⃣ Running lint...');
try {
  execSync('bun run lint', { stdio: 'inherit' });
  console.log('✅ Lint passed\n');
} catch (_error) {
  console.error('❌ Lint failed');
  process.exit(1);
}

// 3. 显示结果
console.log('📦 Build complete!');
console.log('\nRun with: bun run src/cli.ts');
