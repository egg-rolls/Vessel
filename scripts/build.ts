#!/usr/bin/env bun

/**
 * Vessel 构建脚本
 *
 * 使用方式：bun run scripts/build.ts
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_DIR = process.cwd();
const DIST_DIR = join(ROOT_DIR, 'dist');

// 确保 dist 目录存在
if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true });
}

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

// 3. 运行测试
console.log('3️⃣ Running tests...');
try {
  execSync('bun test', { stdio: 'inherit' });
  console.log('✅ Tests passed\n');
} catch (_error) {
  console.error('❌ Tests failed');
  process.exit(1);
}

// 4. 构建单二进制
console.log('4️⃣ Building binary...');
try {
  execSync('bun build src/cli.ts --compile --outfile dist/vessel', { stdio: 'inherit' });
  console.log('✅ Binary built successfully\n');
} catch (_error) {
  console.error('❌ Binary build failed');
  process.exit(1);
}

// 5. 显示结果
console.log('📦 Build complete!');
console.log(`\nBinary location: ${join(DIST_DIR, 'vessel')}`);
console.log('\nTo run: ./dist/vessel');
console.log('To install: cp dist/vessel /usr/local/bin/vessel');
