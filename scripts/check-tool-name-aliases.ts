#!/usr/bin/env bun

/**
 * check-tool-name-aliases —— 配置层「旧工具名 → 现行名」换算表 + 内置工具名合法性的零依赖探针。
 *
 * 跑法：`bun run scripts/check-tool-name-aliases.ts`（退出码 0 = 全过，1 = 有 FAIL）。
 *
 * 为什么需要它（背景见 `docs/dev/handoff/tool-name-legality.md` §5）：工具改名是**两处**的事
 * —— 注册侧换名字、配置选择侧跟着换算。只改注册侧 ⇒ 用户 YAML 里残留的旧名（`ask_user`、
 * `pii.reveal`）**静默不匹配**：不报错，只是 ta 当年选的 always / never 规则不生效。
 * 这与 L-011 是同一个形状（「注册侧改名了、选择侧不认、还不报错」）。
 *
 * 断言：
 *   ① 别名表里每个映射的目标名都**真实存在**于工具注册表（名字从真实 ToolDefinition /
 *      真 `MemoryPluginHost` 注册表取，本文件不手抄工具清单）；
 *   ② 映射表不许出现「映到不存在的工具」、自映射、链式映射（链式 = 二次换算不稳定）；
 *   ③ 反向：**每个内置工具名**都满足 provider 的 `^[a-zA-Z0-9_-]{1,64}$`（点号 / 空格 /
 *      超长会让 `tools[].function.name` 被 400 拒掉**整个请求**，见 handoff §1-2）；
 *   ④ `ask_user` 与 `pii.reveal` 两条旧名都必须能换算出**可达**的现行工具名；
 *   ⑤ 只映射「确实是旧名」的：前缀 / 大小写 / 点号-下划线变体一律原样返回（模糊匹配等于
 *      允许任意别名，会把注册期的名字校验废掉）；
 *   ⑥ 接线：`autoApprove` 与 `neverAutoApprove` **两处**都必须过换算（只改一处是这类修复
 *      最典型的漏点），且旧函数名 `normalizeLegacyAskToolName` 不许有残留。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPiiRevealTool } from '../packages/core/src/pii/reveal.js';
import { MemoryPluginHost } from '../packages/core/src/runtime/plugin-host.js';
import type { ToolDefinition } from '../packages/core/src/types/tool.js';
import { createAskUserTool } from '../packages/tui/src/renderer/ask-user.js';
import { createBasicTools } from '../plugins/tools/basic-tools/src/index.js';
import { parseWebFetchConfig } from '../plugins/tools/web-tools/src/config.js';
import { createWebFetchTool } from '../plugins/tools/web-tools/src/index.js';
import { LEGACY_TOOL_NAME_ALIASES, normalizeLegacyToolName } from '../src/legacy-tool-names.js';

/** provider 对工具名的硬约束（与 `plugin-host.ts` 注册期校验同形；这里是独立取源）。 */
const PROVIDER_SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const failures: string[] = [];
let checked = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checked += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(detail === '' ? label : `${label} —— ${detail}`);
  console.log(`  ✗ ${label}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const repoRoot = join(import.meta.dir, '..');

function sourceOf(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

/**
 * 零依赖下**无法 import** 的工具工厂：它们 import 了 workspace 包名
 * （`@vessel-agent/core` / `@vessel-agent/basic-tools`），而探针按仓内惯例不依赖
 * node_modules（见 check-pii-vault 的文件头）。
 *
 * 名字仍从**源码里的 ToolDefinition 字面量**取（不是手抄）：每个文件必须恰好一条
 * `name: '<literal>',`；多一条或少一条都 FAIL —— 要求人来确认，而不是让覆盖面悄悄缩小。
 */
const UNIMPORTABLE_TOOL_SOURCES: readonly string[] = [
  'packages/agent/src/tool.ts',
  'plugins/context/doc-subscription/src/tool.ts',
  'plugins/media/media/src/tool.ts',
];

/** 从源码里取 `name: '<literal>',` 形式的工具名。 */
function toolNamesFromSource(rel: string): string[] {
  const matches = [...sourceOf(rel).matchAll(/^\s+name: '([^']+)',$/gm)];
  return matches.map((match) => match[1] ?? '');
}

/** 真实内置工具清单：能 import 的注册进真 PluginHost 再读回来，其余从源码字面量取。 */
function collectBuiltinToolNames(): string[] {
  const host = new MemoryPluginHost();
  const definitions: ToolDefinition[] = [
    ...createBasicTools(),
    createWebFetchTool(parseWebFetchConfig(undefined)),
    createAskUserTool(),
    createPiiRevealTool(),
  ];
  for (const definition of definitions) {
    try {
      // 真注册入口：这里本身也跑一遍注册期名字校验（非法名会抛）。
      host.registerTool(definition);
    } catch (error) {
      check(`真实工具「${definition.name}」能注册进 PluginHost`, false, String(error));
    }
  }
  const registered = host.listTools().map((tool) => tool.name);
  check(
    '从真实 PluginHost 注册表读回的工具数与定义数一致',
    registered.length === definitions.length,
    `定义 ${definitions.length} 个，注册表 ${registered.length} 个：${registered.join(' / ')}`,
  );
  return registered;
}

// ── 目录：真实工具名清单 ──────────────────────────

section('0. 真实内置工具清单（注册表 + 源码字面量）');
const catalogNames = collectBuiltinToolNames();
for (const rel of UNIMPORTABLE_TOOL_SOURCES) {
  const found = toolNamesFromSource(rel);
  const [only] = found;
  check(
    `${rel} 里恰好一条 ToolDefinition 真名`,
    found.length === 1 && only !== undefined,
    `实际 ${found.length} 条：${found.join(' / ')}（源码形状变了？请人来确认，不要放宽本断言）`,
  );
  if (only !== undefined) catalogNames.push(only);
}
const catalog = new Set(catalogNames);
check('工具清单非空', catalog.size > 0, `实际 ${catalog.size} 个`);
console.log(`    清单（${catalog.size}）：${[...catalog].sort().join(' / ')}`);

// ── ① 别名 → 真实工具 ────────────────────────────

section('① 每个别名映射后都必须命中真实存在的工具名');
const aliases = Object.entries(LEGACY_TOOL_NAME_ALIASES);
check('别名表非空', aliases.length > 0, '空表说明换算层被删了，等于回到静默失效');
for (const [legacy, current] of aliases) {
  check(
    `「${legacy}」换算结果与表一致`,
    normalizeLegacyToolName(legacy) === current,
    `normalize("${legacy}") = "${normalizeLegacyToolName(legacy)}"，表里写 "${current}"`,
  );
  check(
    `「${legacy}」→「${current}」的目标真实存在`,
    catalog.has(current),
    `"${current}" 不在真实工具清单里（清单：${[...catalog].sort().join(' / ')}）`,
  );
}

// ── ② 表自身的一致性 ─────────────────────────────

section('② 映射表里不允许映射到不存在的工具 / 自映射 / 链式');
for (const [legacy, current] of aliases) {
  check(`「${legacy}」不是自映射`, legacy !== current, `旧名与现行名相同："${legacy}"`);
  check(
    `「${legacy}」的现行名不是另一条别名（不许链式）`,
    !Object.hasOwn(LEGACY_TOOL_NAME_ALIASES, current),
    `"${current}" 本身还是别名，换算要多跳一次`,
  );
  check(
    `「${legacy}」换算稳定（幂等 / 单跳）`,
    normalizeLegacyToolName(normalizeLegacyToolName(legacy)) === current,
    `二次换算得到 "${normalizeLegacyToolName(normalizeLegacyToolName(legacy))}"`,
  );
}

// ── ③ 反向：内置工具名合法性 ──────────────────────

section('③ 反向：每个内置工具名都必须 provider-safe');
for (const name of [...catalog].sort()) {
  check(
    `「${name}」满足 ${PROVIDER_SAFE_TOOL_NAME.source}`,
    PROVIDER_SAFE_TOOL_NAME.test(name),
    '带点号 / 空格或超过 64 字符会让 provider 400 拒掉整个请求（不只是调用这个工具时）',
  );
  check(`「${name}」不含点号`, !name.includes('.'), '工具名里的点号是 pii.reveal 事故的直接原因');
  check(`「${name}」长度 1-64`, name.length >= 1 && name.length <= 64, `实际长度 ${name.length}`);
}

// ── ④ 两条已知旧名 ───────────────────────────────

section('④ ask_user 与 pii.reveal 两条旧名都必须能换算出可达的工具');
for (const legacy of ['ask_user', 'pii.reveal']) {
  const current = normalizeLegacyToolName(legacy);
  check(`旧名「${legacy}」确实被换算`, current !== legacy, '未换算 ⇒ 用户 YAML 里的旧名静默不匹配');
  check(
    `旧名「${legacy}」换算结果是可达工具`,
    catalog.has(current),
    `换算到 "${current}"，但它不在真实工具清单里`,
  );
}

// ── ⑤ 不做模糊匹配 ───────────────────────────────

section('⑤ 只映射「确实是旧名」的，不做前缀 / 大小写 / 分隔符模糊匹配');
const PASSTHROUGH = [
  'ask',
  'piiReveal',
  'pii_reveal',
  'pii-reveal',
  'ask-user',
  'askuser',
  'ask_user_extra',
  'pii.reveal.more',
  'Ask_User',
  'PII.REVEAL',
  ' ask_user',
  'ask_user ',
  'pii',
  'mcp__server__tool',
];
for (const name of PASSTHROUGH) {
  const got = normalizeLegacyToolName(name);
  check(
    `「${name}」原样返回`,
    got === name,
    `被换算成 "${got}" —— 模糊匹配等于允许任意别名，注册期的名字校验就废了`,
  );
}

// ── ⑥ 接线：两处换算点 ───────────────────────────

section('⑥ autoApprove 与 neverAutoApprove 两处都覆盖到（静态接线）');
const CONVERSION_FILES = ['src/bootstrap.ts', 'src/tenant-runtime-factory.ts'];
for (const rel of CONVERSION_FILES) {
  const text = sourceOf(rel);
  check(
    `${rel} 不再使用旧函数名 normalizeLegacyAskToolName`,
    !text.includes('normalizeLegacyAskToolName'),
    '表驱动改名有残留：旧名函数只认 ask_user，会让 pii.reveal 静默不匹配',
  );
  check(
    `${rel}: autoApprove 过换算`,
    /autoApprove:[\s\S]{0,800}?\.map\(\s*normalizeLegacyToolName\s*,?\s*\)/.test(text),
    'autoApprove 没调用 normalizeLegacyToolName ⇒ 老配置的「always」静默失效',
  );
  check(
    `${rel}: neverAutoApprove 过换算`,
    /neverAutoApprove:[\s\S]{0,800}?\.map\(\s*normalizeLegacyToolName\s*,?\s*\)/.test(text),
    'neverAutoApprove 没调用 normalizeLegacyToolName ⇒ 老配置的「never」静默失效',
  );
}

// ── 收尾 ────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${checked} 项检查，${failures.length} 项失败：`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`\n${checked} 项通过，0 项失败`);
