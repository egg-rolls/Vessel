#!/usr/bin/env bun

/**
 * 主题（`data-theme` + localStorage）的应用门禁（0.52）。
 *
 * 用户报的现象：系统暗色 → 在「视觉效果」页切成亮色 → 离开页面 / 刷新 ⇒ **整页变回暗色**，
 * 只有再进一次视觉效果页才恢复亮色。源码上能证明的两件事，正好拼出这个形状：
 *
 * 1. `data-theme` 不止一处会写：`domains/design/tokens.ts` 的退化采样会**临时**把主文档
 *    改成 `data-theme="dark"` 读一遍颜色。它原来**没有 try/finally** —— 读值中途抛异常就
 *    把整页永久钉在暗色，而且没有任何代码会再纠正它。
 * 2. 唯一的「纠正者」是 `AppearanceView` 挂载时按存储重放主题 ⇒ 于是表现成「只有进视觉
 *    设置页才恢复」。
 *
 * 所以这里钉三条：采样必须 try/finally 且还原在 finally 里；AppShell 必须在
 * `pageshow` / `visibilitychange` / `storage` 上按存储自愈；入口必须在首帧前应用存储值。
 *
 * 用法：bun run scripts/check-theme-apply.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  applyTheme,
  initialTheme,
  readStoredTheme,
  THEME_KEY,
  themeAttribute,
} from '../apps/web/src/state/theme';

const failures: string[] = [];
let checked = 0;

function expect(cond: boolean, message: string): void {
  checked += 1;
  if (!cond) failures.push(message);
}

const repoRoot = join(import.meta.dir, '..');

async function source(rel: string): Promise<string> {
  return readFile(join(repoRoot, rel), 'utf8');
}

function fakeRoot(): { dataset: Record<string, string>; removeAttribute: (n: string) => void } {
  const root = {
    dataset: {} as Record<string, string>,
    removeAttribute: (name: string) => {
      delete (root.dataset as Record<string, string>)[name];
    },
  };
  return root;
}

// A. 纯函数口径
const light = fakeRoot();
applyTheme('light', light);
expect(light.dataset.theme === 'light', 'A: applyTheme(light) 没有写 data-theme="light"');

const system = fakeRoot();
applyTheme('system', system);
expect(
  (system.dataset as Record<string, string>).theme === undefined,
  'A: applyTheme(system) 必须移除属性（否则 prefers-color-scheme 永远失效）',
);
expect(themeAttribute('system') === null, 'A: themeAttribute(system) 应为 null');

expect(initialTheme(null) === 'dark', 'A: 无存储偏好的默认值变了（用户裁定保持 dark）');
expect(initialTheme('light') === 'light', 'A: initialTheme 丢掉了合法的 light');
expect(initialTheme('nonsense') === 'dark', 'A: 非法值应回落 dark');

const storage = { getItem: (key: string) => (key === THEME_KEY ? 'light' : null) };
expect(readStoredTheme(storage) === 'light', 'A: readStoredTheme 没按 THEME_KEY 读');

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
};
expect(readStoredTheme(throwing) === 'dark', 'A: 存储读失败应回落 dark 且不抛');

// B. 采样必须还原（try/finally）
const tokens = await source('apps/web/src/domains/design/tokens.ts');
const sampleBody = /function sampleDarkValues\([\s\S]*?\n\}/u.exec(tokens)?.[0] ?? '';
expect(sampleBody.length > 0, 'B: 找不到 sampleDarkValues');
expect(
  sampleBody.includes('finally'),
  'B: sampleDarkValues 没有 try/finally —— 读值抛异常会把主文档永久钉在 data-theme="dark"',
);
expect(
  /finally\s*\{[\s\S]*?(removeAttribute|setAttribute)\('data-theme'/u.test(sampleBody),
  'B: finally 里必须真的还原 data-theme（这是唯一会给主文档硬写 dark 的地方）',
);
expect(
  /root\.setAttribute\('data-theme', 'dark'\)/u.test(sampleBody),
  'B: 采样不再临时挂 dark？那这条判据要跟着改（别留着假断言）',
);

// C. AppShell 自愈：回到前台 / 往返缓存 / 别的标签页改偏好，都要按存储重放
const shell = await source('apps/web/src/app/AppShell.tsx');
expect(
  shell.includes("addEventListener('storage'"),
  'C: AppShell 没有监听 storage（多标签页改偏好不会生效）',
);
expect(
  shell.includes("addEventListener('pageshow'"),
  'C: AppShell 没有监听 pageshow（往返缓存恢复后不会自愈）',
);
expect(
  shell.includes("addEventListener('visibilitychange'"),
  'C: AppShell 没有监听 visibilitychange（切回前台后不会自愈）',
);
expect(
  /readStoredTheme\(localStorage\)/u.test(shell) && /applyTheme\(stored\)/u.test(shell),
  'C: 自愈必须「按存储值重放」，不许另算一遍',
);

// E. **DOM 主题只有一个写者**（0.52 真机事故：存储 light、刷新后 data-theme=dark）
//    事故链条：入口首帧前按存储写了 light -> AppShell 挂载 effect 又按 store 的值覆盖
//    （store 在那个时刻可能还不是用户选择）=> 最终 dark，而且每次刷新都重演。
//    修法是把 apply 收进 storeTheme()（唯一写者）。断言前先剥注释，免得注释里提到的旧代码误报。
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index < 0 ? line : line.slice(0, index);
    })
    .join('\n');
}

const shellCode = stripComments(await source('apps/web/src/app/AppShell.tsx'));
expect(
  /applyTheme\(theme\)/u.test(shellCode) === false,
  'E: AppShell 又出现 applyTheme(theme) —— 挂载时会用 store 值覆盖首帧按存储写好的主题（刷新必变暗）',
);
expect(shellCode.includes('applyTheme(stored)'), 'E: AppShell 的自愈必须按存储值重放');
const themeCode = stripComments(await source('apps/web/src/state/theme.ts'));
expect(
  /export function storeTheme[\s\S]{0,800}?applyTheme\(theme\)/u.test(themeCode),
  'E: storeTheme 必须自己应用 DOM —— 它是唯一写者，否则改主题不生效',
);
const appearanceCode = stripComments(
  await source('apps/web/src/domains/settings/AppearanceView.tsx'),
);
expect(
  appearanceCode.includes('applyTheme') === false,
  'E: AppearanceView 又在单独 applyTheme —— 改主题只该走 storeTheme（单写者）',
);

// D. 入口必须在首帧前应用（否则每次加载都先闪一遍系统色）
const main = await source('apps/web/src/main.tsx');
expect(
  /applyTheme\(readStoredTheme\(localStorage\)\)/u.test(main),
  'D: main.tsx 不再在首帧前应用存储主题（会先闪系统色，且依赖 React 挂载才生效）',
);

if (failures.length > 0) {
  console.error(
    `check-theme-apply: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-theme-apply: OK（${String(checked)} 项：applyTheme 口径 / 采样 try-finally 还原 / 自愈监听 / 首帧前应用）`,
);
