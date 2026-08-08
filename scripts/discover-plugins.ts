#!/usr/bin/env bun

/**
 * 构建时插件发现脚本
 *
 * 扫描 plugins 目录下每层「分类 / 插件」目录的 package.json，
 * 读取插件名称与元数据，生成 src/plugin-registry.generated.ts
 * （静态 import 字面量，可被 Bun 打包——顺带修复变量 import 的打包隐患）。
 *
 * 开发者放一个插件文件夹（带 package.json）即自动注册，无需手改注册表。
 *
 * 使用方式：bun run scripts/discover-plugins.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PLUGINS_DIR = join(ROOT, 'plugins');
const OUTPUT = join(ROOT, 'src', 'plugin-registry.generated.ts');
const CORE_INDEX = '../packages/core/src/index';

interface DiscoveredPlugin {
  /** 插件短名（package.json name 去掉 scope），即注册表的 key */
  name: string;
  /** 分类目录：plugins/<category>/<name>/ */
  category: string;
  version: string;
  description?: string;
  /** 相对 src/ 的入口路径（去扩展名） */
  entry: string;
}

/** 插件短名 → 合法的标识符，如 `meta-tools` → `pluginMetaTools` */
function toIdentifier(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter((p) => p.length > 0);
  const camel = parts
    .map((p, i) =>
      i === 0 ? p.toLowerCase() : `${p.charAt(0).toUpperCase()}${p.slice(1).toLowerCase()}`,
    )
    .join('');
  return `plugin${camel}`;
}

function stripExtension(entry: string): string {
  return entry.replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function discover(): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];
  for (const category of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = join(PLUGINS_DIR, category.name);
    for (const entry of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(categoryDir, entry.name);
      const pkgPath = join(pluginDir, 'package.json');
      let pkg: { name?: string; version?: string; description?: string; main?: string };
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as typeof pkg;
      } catch {
        continue; // 无 package.json 的目录跳过
      }
      const entryPath = pkg.main ? stripExtension(pkg.main) : 'src/index';
      // 短名 = package.json name 去掉 scope（@vessel/provider-openai → provider-openai）
      const scopedName = pkg.name ?? entry.name;
      const shortName = scopedName.startsWith('@')
        ? scopedName.split('/').slice(1).join('/')
        : scopedName;
      plugins.push({
        name: shortName,
        category: category.name,
        version: pkg.version ?? '0.0.0',
        description: pkg.description,
        entry: `../plugins/${category.name}/${entry.name}/${entryPath}`,
      });
    }
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

function generate(plugins: DiscoveredPlugin[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * 自动生成——由 scripts/discover-plugins.ts 扫描 plugins 目录（分类/插件）生成。');
  lines.push(' * 请勿手改；重新生成请运行 `bun run scripts/discover-plugins.ts`。');
  lines.push(' */');
  lines.push(`import type { Plugin } from '${CORE_INDEX}';`);
  lines.push('');
  // import 按路径排序，与 biome organizeImports 保持一致（生成后 lint 不再改写）
  const byEntry = [...plugins].sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  for (const p of byEntry) {
    lines.push(`import ${toIdentifier(p.name)} from '${p.entry}';`);
  }
  lines.push('');
  lines.push('/** 插件描述（来自 package.json 元数据 + 目录分类） */');
  lines.push('export interface PluginDescriptor {');
  lines.push('  name: string;');
  lines.push('  category: string;');
  lines.push('  version: string;');
  lines.push('  description?: string;');
  lines.push('}');
  lines.push('');
  lines.push('/** 扫描出的插件元数据 */');
  lines.push('export const PLUGIN_DESCRIPTORS: PluginDescriptor[] = [');
  for (const p of plugins) {
    const description = p.description ? `, description: '${escapeString(p.description)}'` : '';
    lines.push(
      `  { name: '${p.name}', category: '${p.category}', version: '${p.version}'${description} },`,
    );
  }
  lines.push('];');
  lines.push('');
  lines.push('/** 插件名 → 插件默认导出（静态 import，可被 Bun 打包） */');
  lines.push('export const PLUGIN_MODULES: Record<string, Plugin> = {');
  for (const p of plugins) {
    lines.push(`  '${p.name}': ${toIdentifier(p.name)},`);
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

const plugins = discover();
writeFileSync(OUTPUT, generate(plugins));
console.log(`✅ Discovered ${plugins.length} plugins → ${OUTPUT}`);
