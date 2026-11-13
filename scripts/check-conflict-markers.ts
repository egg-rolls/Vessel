/**
 * 门禁：仓库里不得出现 Git 合并冲突标记。
 *
 * 为什么需要单独的探针：标记落在 **JSDoc / 接口字段 / 注释里**时，`tsc` 与 `biome` 都
 * 不会红（它们把 `<<<<<<<` 当注释文本），于是「解冲突解坏了」能一路合进 main ——
 * 0.51 就真发生过两次（`agent-control.ts` 的 `claim` 声明被吞、`inbox.ts` 的接口注释
 * 块结构坏掉），两次都是 `gates` 全绿。这类缺陷只有人读或运行时才会暴露。
 *
 * 判据只认 Git 真正用的两种标记行（`<<<<<<< ` / `>>>>>>> `，带尾空格；`=======` 在
 * markdown 里是合法的 setext 下划线，单看它必然误报，所以只在同一文件里已经出现前两者
 * 时才算证据 —— 而只要前两者不在，文件就是干净的）。
 *
 * @module
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** 不扫的目录：第三方依赖、生成产物、VCS 内部。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo']);

/** 只扫文本类文件（二进制/图片等扫了只会制造噪音）。 */
const TEXT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.css',
  '.scss',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.txt',
  '.html',
];

/** 冲突标记行（Git 的两种不可混淆的写法）。 */
const MARKERS = ['<<<<<<< ', '>>>>>>> '];

const offenders: { path: string; line: number; text: string }[] = [];

async function walk(dir: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf('.');
    if (dot < 0) continue;
    if (!TEXT_EXTENSIONS.includes(entry.name.slice(dot))) continue;
    let text: string;
    try {
      text = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    if (!MARKERS.some((marker) => text.includes(marker))) continue;
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trimStart();
      if (!MARKERS.some((marker) => trimmed.startsWith(marker))) continue;
      offenders.push({ path: relative(ROOT, full), line: index + 1, text: line.trim() });
    }
  }
}

await walk(ROOT);

if (offenders.length > 0) {
  for (const item of offenders) {
    console.error('  ' + item.path + ':' + item.line + '  ' + item.text);
  }
  console.error(
    'conflict markers: ' +
      offenders.length +
      ' line(s) found -- typecheck/biome never catch these ' +
      '(they look like comments), so they are a hard gate.',
  );
  process.exit(1);
}

console.log('conflict markers: all checks passed');
