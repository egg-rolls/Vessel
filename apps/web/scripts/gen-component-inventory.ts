/**
 * 组件清单生成器（q-design-lab-restore）：审计 apps/web/src/components/ui 共享组件的
 * 复用度与预览覆盖，产出 src/domains/design/component-inventory.data.ts（设计实验室
 * 「组件清单」区的数据源，构建期快照）。
 *
 * 用法：bun apps/web/scripts/gen-component-inventory.ts   （仓库根目录运行）
 *
 * 口径：
 * - 消费方 = src 下 import 了该模块符号的文件（components/ui 自身除外）；
 *   `*.preview.tsx` 样例单独计为预览覆盖，不算应用消费方。
 * - components/ui 里转口 @vessel-agent/plugin-ui 的模块：从 plugin-ui 直接 import
 *   同名符号同样计入（同一个组件，两条 import 路径）。
 * - 单消费方（consumerCount === 1）= 疑似一次性组件：应复用共享或退役候选。
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB_SRC = join(import.meta.dir, '..', 'src');
const UI_DIR = join(WEB_SRC, 'components', 'ui');
const OUT = join(WEB_SRC, 'domains', 'design', 'component-inventory.data.ts');

interface ModuleInfo {
  module: string;
  kind: 'component' | 'hook' | 'util';
  reexport: boolean;
  symbols: string[];
  consumers: string[];
  /** ui 目录内部的消费方（如 AutoGrowTextarea 只被 RichComposer 用）。 */
  uiConsumers: string[];
  previews: string[];
}

/** 收集 src 下全部 ts/tsx 文件（递归）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** 模块的值导出符号（去掉 type 导出）。 */
function valueExports(source: string): string[] {
  const symbols = new Set<string>();
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && !part.trim().startsWith('type ')) symbols.add(name);
    }
  }
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/g,
  )) {
    symbols.add(match[1] ?? '');
  }
  symbols.delete('');
  return [...symbols];
}

const uiFiles = readdirSync(UI_DIR).filter(
  (name) =>
    (name.endsWith('.ts') || name.endsWith('.tsx')) &&
    name !== 'index.ts' &&
    !name.endsWith('.preview.tsx'),
);

const modules: ModuleInfo[] = uiFiles.map((file) => {
  const source = readFileSync(join(UI_DIR, file), 'utf8');
  const module = file.replace(/\.tsx?$/, '');
  const reexport = source.includes("from '@vessel-agent/plugin-ui'");
  const kind = module.startsWith('use') ? 'hook' : file.endsWith('.tsx') ? 'component' : 'util';
  return {
    module,
    kind,
    reexport,
    symbols: valueExports(source),
    consumers: [],
    uiConsumers: [],
    previews: [],
  };
});

/** 符号 → 模块（plugin-ui 转口符号归到 ui 模块名下）。 */
const symbolOwner = new Map<string, ModuleInfo>();
for (const info of modules) {
  for (const symbol of info.symbols) symbolOwner.set(symbol, info);
}

const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;

for (const file of walk(WEB_SRC)) {
  const rel = relative(WEB_SRC, file).replaceAll('\\', '/');
  const isPreview = rel.endsWith('.preview.tsx');
  const inUi = rel.startsWith('components/ui/');
  const ownModule = inUi ? rel.slice('components/ui/'.length).replace(/\.tsx?$/, '') : undefined;
  const source = readFileSync(file, 'utf8');
  const hit = new Set<ModuleInfo>();
  for (const match of source.matchAll(IMPORT_RE)) {
    const clause = match[1] ?? '';
    const path = match[2] ?? '';
    const isUi = path.includes('components/ui');
    const isPluginUi = path === '@vessel-agent/plugin-ui';
    // ui 目录内样例的相对 import（'./EntityHeader'）也认。
    const isUiLocal = inUi && path.startsWith('./');
    if (!isUi && !isPluginUi && !isUiLocal) continue;
    // 直接子模块 import（如 '../components/ui/cn'）只认该模块的符号。
    const sub =
      isUi && !path.endsWith('components/ui')
        ? path.split('/').pop()
        : isUiLocal
          ? path.slice(2).replace(/\.tsx?$/, '')
          : undefined;
    for (const part of clause.split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (!name || part.trim().startsWith('type ')) continue;
      const owner = symbolOwner.get(name);
      if (!owner || owner.module === ownModule) continue;
      if (sub && owner.module !== sub) continue;
      hit.add(owner);
    }
  }
  for (const info of hit) {
    if (isPreview) info.previews.push(rel);
    else if (inUi) info.uiConsumers.push(rel);
    else info.consumers.push(rel);
  }
}

for (const info of modules) {
  info.consumers.sort();
  info.uiConsumers.sort();
  info.previews.sort();
}
modules.sort((a, b) => a.module.localeCompare(b.module, 'en'));

// WSL worktree 下 Windows git 读不了 /mnt 路径的 gitdir：允许 argv[2] 显式传入 commit。
let commit = process.argv[2] ?? 'unknown';
if (!process.argv[2]) {
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: WEB_SRC }).toString().trim();
  } catch {
    /* 非 git 环境时留 unknown */
  }
}

const lines: string[] = [
  '/**',
  ' * 组件清单数据（构建期快照）——由 apps/web/scripts/gen-component-inventory.ts 生成，',
  ` * 再生成：仓库根目录运行 \`bun apps/web/scripts/gen-component-inventory.ts\`。`,
  ' * 消费方口径见脚本头注；单消费方 = 疑似一次性组件（复用共享或退役候选）。',
  ' */',
  '',
  'export interface InventoryEntry {',
  '  /** components/ui 模块名（文件名去后缀）。 */',
  '  module: string;',
  "  kind: 'component' | 'hook' | 'util';",
  '  /** 是否转口 @vessel-agent/plugin-ui（同一组件两条 import 路径都计复用）。 */',
  '  reexport: boolean;',
  '  /** 应用消费方数（不含样例与 ui 目录自身）。 */',
  '  consumerCount: number;',
  '  /** 消费方路径（相对 src，最多 12 条示例；全量见外层仓清点报告）。 */',
  '  consumers: string[];',
  '  /** ui 目录内部消费方（0 应用消费方时看这里：可能只被其它共享组件引用）。 */',
  '  uiConsumers: string[];',
  '  /** 引用该组件的 *.preview.tsx 样例（相对 src）。 */',
  '  previews: string[];',
  '}',
  '',
  `export const INVENTORY_COMMIT = '${commit}';`,
  '',
  'export const COMPONENT_INVENTORY: readonly InventoryEntry[] = [',
];
for (const info of modules) {
  lines.push('  {');
  lines.push(`    module: '${info.module}',`);
  lines.push(`    kind: '${info.kind}',`);
  lines.push(`    reexport: ${info.reexport},`);
  lines.push(`    consumerCount: ${info.consumers.length},`);
  lines.push('    consumers: [');
  for (const consumer of info.consumers.slice(0, 12)) lines.push(`      '${consumer}',`);
  lines.push('    ],');
  lines.push('    uiConsumers: [');
  for (const consumer of info.uiConsumers) lines.push(`      '${consumer}',`);
  lines.push('    ],');
  lines.push('    previews: [');
  for (const preview of info.previews) lines.push(`      '${preview}',`);
  lines.push('    ],');
  lines.push('  },');
}
lines.push('];', '');
writeFileSync(OUT, lines.join('\n'));

// 控制台摘要（审计用）。
for (const info of modules) {
  const flag = info.consumers.length === 1 ? ' ← 单消费方' : '';
  console.log(
    `${info.module.padEnd(20)} ${String(info.consumers.length).padStart(3)} 消费方  ` +
      `${info.previews.length} 预览${flag}`,
  );
}
console.log(`\nwritten: ${relative(process.cwd(), OUT)} @ ${commit}`);
