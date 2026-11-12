#!/usr/bin/env bun

/**
 * 事件可见性门禁：把「新事件类型默认外泄」变成 CI FAIL。
 *
 * 唯一分类表是 `apps/web/src/state/event-visibility.ts`（三档 + 家族前缀）。本脚本用
 * `node:fs/promises` 递归遍历固定源码根（**不用 grep**，全仓 grep 会超时），断言：
 *
 * A1 未登记即 FAIL：扫到的事件名（生产点 + 消费点）必须 `tierOf(...) !== undefined`。
 * A2 表腐烂即 FAIL：`live: true` 的键必须真的在源码里扫得到；扫不到但 `live: false`
 *    只打 `[legacy]` 提示（不是失败）。
 * A3 非字面量即 FAIL：`publish({ type: <非字面量> })` / 转发助手只允许出现在
 *    `NON_LITERAL_ALLOWLIST` 里（今天是 10 个包装点，调用点本身仍必须是字面量）。
 * A4 渲染不变量（fixture）：三档的可见性语义、`content` 不得落原始事件卡、
 *    `observe` 里不得有失败类、未登记类型必须折叠成 notice、
 *    **影子对拍**（新表 vs 今天两张黑名单的差集必须恰好等于审计报告 §3 的差集）。
 * A5 双链对拍：`team-service.ts` 的 `systemEventFor` ↔ `TeamMessageRow.tsx` 的
 *    `SYSTEM_KEYS`，以及表里的 `teamLog` 声明。
 * A6 文档对拍：`docs/architecture/events.md` 的 `event-visibility` marker 表与
 *    `EVENT_TIERS` 键集必须一致。
 *
 * 用法：bun run scripts/check-event-visibility.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunEvent } from '../apps/web/src/gateway/types';
import { isErrorEventType } from '../apps/web/src/state/error-visibility';
import {
  EVENT_TIER_FAMILIES,
  EVENT_TIERS,
  type EventSpec,
  isVisibleInChat,
  tierOf,
} from '../apps/web/src/state/event-visibility';
import { buildGroup, type StoredEvent } from '../apps/web/src/state/events';

const REPO = join(import.meta.dir, '..');

/** 固定源码根（跳过 node_modules / dist / 构建产物 `web`）。 */
const BASE_ROOTS = [
  'packages/core/src',
  'packages/agent/src',
  'packages/serve/src',
  'packages/permission/src',
  'packages/tui/src',
  'src',
  'apps/web/src',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'web', 'build', 'coverage', '.git']);

/** 生产点：对象字面量 / 发布助手实参里的字面量 / 三元。 */
const SITE_PATTERNS: readonly RegExp[] = [
  /type:\s*'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g,
  // `publish('x.y', …)` / `emitForSession('x.y', …)` / `publishEvalEvent(events, tenant, 'x.y', …)`：
  // 允许**最多两个**简单前导实参（不能带括号引号，避免跨调用误配）。
  /\b(?:publish|emit|noteAgentEvent)[A-Za-z]*\(\s*(?:[^,()'"{}]{0,60},\s*){0,2}'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g,
  // 三元：`type: cond ? 'a.b' : 'c.d'`（两边都必须带点，否则会误吃 `type: done ? 'bold' : 'italic'`）。
  /type:\s*[^,;\n]*\?\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'\s*:\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/g,
];

/** 消费点：只在「这个文件确实在处理事件」时才扫，避免把 RPC 方法名当成事件名。 */
const CONSUMER_PATTERNS: readonly RegExp[] = [
  /case\s+'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'\s*:/g,
  /event\.type\s*===\s*'([a-z0-9_.]+)'/g,
  /\btype\s*===\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/g,
];
const EVENTISH = /RunEvent|AgentEvent|event\.type|EventPayload/;

/**
 * 非字面量事件名：`publish({ type: <expr> })` 或 `{ type, ... }` 简写（转发）。
 *
 * 值后面必须紧跟 `,` / `)` —— 三元（`type: cancelled ? 'run.cancelled' : 'run.failed'`）
 * 的两个分支是字面量，已由 SITE_PATTERNS 收走，不算非字面量。
 */
const NON_LITERAL =
  /(?:publish|publishDiagnostic|publishFederationEvent|publishQueueEvent|emit|emitForSession|noteAgentEvent)[A-Za-z]*\(\s*\{[^{}]*?(?:\btype:\s*(?!['\x60])([A-Za-z_][\w.]*)\s*[,)]|\btype\s*(?=[,}]))/g;

/**
 * 非字面量的**合法**点：都是「把 type 参数原样转发给 publish」的包装函数，
 * 真正的字面量在各自的调用点上（那些调用点由 SITE_PATTERNS 扫）。
 */
const NON_LITERAL_ALLOWLIST: readonly { file: string; why: string }[] = [
  { file: 'packages/core/src/kernel/scheduler.ts', why: 'publishQueueEvent(type 窄联合)' },
  { file: 'packages/core/src/runtime/hook-runner.ts', why: 'publish(type, data) 包装' },
  { file: 'packages/agent/src/service.ts', why: 'emit / emitForSession / noteAgentEvent 包装' },
  { file: 'packages/serve/src/gateway.ts', why: 'publishDiagnostic 包装（诊断 / 联邦）' },
  { file: 'src/tenant-runtime-factory.ts', why: '转发插件自定事件（type 来自插件）' },
  { file: 'plugins/evals/harness/src/runner.ts', why: 'eval 事件 publish 包装' },
  { file: 'plugins/im/feishu/src/channel.ts', why: '渠道事件 publish 包装' },
  { file: 'plugins/mcp/client/src/plugin.ts', why: 'MCP 事件 publish 包装' },
  { file: 'plugins/mcp/client/src/server-connection.ts', why: 'MCP 事件 publish 包装' },
];

/**
 * 影子对拍：审计报告 §3 的差集（今天「不在两张黑名单里 ⇒ 默认可见」的 59 条里，
 * 除 content 之外必须被新表收掉的 45 条）+ 门禁扫出来、报告漏掉的 6 条。
 *
 * 这是**冻结的期望值**，故意不写表达式：`EVENT_TIERS` 改错了这一条就会 FAIL。
 */
const EXPECTED_NEWLY_HIDDEN: readonly string[] = [
  // §3.2 应归 internal（14）
  'error',
  'hook.failed',
  'hook.error',
  'process.error',
  'shutdown.failed',
  'session.log.failed',
  'trace.write.failed',
  'trace.overflow',
  'plugin.failed',
  'plugin.init.failed',
  'plugin.dispose.failed',
  'context.cleared_tool_result',
  'team.budget.warning',
  'team.budget.blocked',
  // §3.3 应归 observe（31）
  'agent.retired',
  'agent.rotate.approved',
  'agent.rotate.denied',
  'agent.rotate.failed',
  'agent.updated',
  'agent.role.changed',
  'agent.rejoined',
  'agent.permission.cancelled',
  'session.forked',
  'guardrail.modified',
  'plugin.loaded',
  'plugin.changed',
  'config.loaded',
  'update.available',
  'rpc.result_invalid',
  'federation.received',
  'federation.rejected',
  'mcp.server.connected',
  'mcp.server.disconnected',
  'mcp.resource.read',
  'mcp.tool.called',
  'mcp.warning',
  'mcp.server.failed',
  'mcp.tool.failed',
  'channel.feishu.connected',
  'channel.feishu.disconnected',
  'channel.feishu.message.received',
  'channel.feishu.reply.sent',
  'channel.feishu.error',
  'eval.run.started',
  'eval.run.completed',
  // 报告漏掉的真实名字（门禁扫出来的，见 §「事件名非字面量」一节的覆盖口径）
  'team.budget.override',
  'tool.permission.expired',
  'delegate.started',
  'delegate_task.started',
  'delegate.completed',
  'delegate.failed',
];

/** 报告 §3.1：这些今天可见、**必须继续可见**（content 类被误藏是本方案最痛的风险）。 */
const EXPECTED_CONTENT: readonly string[] = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.finalize.failed',
  'user.message',
  'llm.stream.chunk',
  'tool.call.started',
  'tool.call.completed',
  'tool.call.failed',
  'guardrail.blocked',
  'guardrail.error',
  'agent.limit.warning',
  'agent.reply.stale',
];

/**
 * 今天的两张黑名单（**冻结副本**，只为本脚本的影子对拍存在；产品代码里已经删掉）。
 * 不要在别处复用：口径已经翻成白名单，这里是历史 oracle。
 */
const LEGACY_INTERNAL: readonly string[] = [
  'context.changed',
  'session.saved',
  'llm.request',
  'llm.response',
  'llm.retry',
  'llm.stream.summary',
  'message.injected',
  'run.checkpoint',
  'run.resumed',
  'runtime.notice',
  'replay.started',
  'replay.completed',
  'context.pressure',
  'context.compacted',
  'agent.rotating',
  'agent.rotated',
  'agent.restarting',
  'agent.restarted',
  'agent.compact_forked',
  'message.compaction',
  'prompt.prefix_changed',
  'limit.blocked',
  'hook.started',
  'hook.completed',
  'hook.system_prompt_ignored',
  'hook.additional_context_deprecated',
];

const LEGACY_CHAT_HIDDEN: readonly string[] = [
  'session.created',
  'session.activated',
  'agent.session.activated',
  'agent.create.failed',
  'agent.forked',
  'session.rewound',
  'session.titled',
  'session.deleted',
  'tool.permission.request',
  'tool.permission.response',
  'ask.user.requested',
  'ask.user.answered',
  'ask.user.timeout',
  'agent.spawned',
  'agent.message.queued',
  'agent.message.notified',
  'agent.message.sent',
  'agent.closed',
  'agent.stale',
  'agent.permission.requested',
  'agent.permission.responded',
  'agent.queue.entered',
  'agent.queue.left',
];

/** 服务端确实会写团队日志的事件（`team-service.ts` 的 `systemEventFor` + `onRunEvent`）。 */
const SERVER_TEAM_LOG: readonly string[] = [
  'agent.spawned',
  'agent.rejoined',
  'agent.closed',
  'agent.rotated',
  'agent.forked',
  'run.completed',
  'run.failed',
  'run.cancelled',
];

const failures: string[] = [];

function fail(where: string, message: string): void {
  failures.push(`${where} ${message}`);
}

function note(message: string): void {
  console.log(`note  ${message}`);
}

// ── 文件遍历 ──────────────────────────────────────────────

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')))
      yield full;
  }
}

async function scanRoots(): Promise<string[]> {
  const roots = [...BASE_ROOTS];
  const plugins = join(REPO, 'plugins');
  for (const group of await readdir(plugins, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const plugin of await readdir(join(plugins, group.name), { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      for (const leaf of ['src', 'web-src']) {
        roots.push(join('plugins', group.name, plugin.name, leaf));
      }
    }
  }
  return roots;
}

function relative(file: string): string {
  return file
    .slice(REPO.length + 1)
    .split('\\')
    .join('/');
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function addSite(
  sites: Map<string, { where: string; kind: string }[]>,
  name: string,
  where: string,
  kind: string,
): void {
  const list = sites.get(name);
  if (list) {
    if (!list.some((site) => site.where === where && site.kind === kind)) {
      list.push({ where, kind });
    }
  } else {
    sites.set(name, [{ where, kind }]);
  }
}

// ── A1 / A2 / A3：扫源码 ──────────────────────────────────

async function scanSources(): Promise<Map<string, { where: string; kind: string }[]>> {
  const sites = new Map<string, { where: string; kind: string }[]>();
  for (const root of await scanRoots()) {
    for await (const file of walk(join(REPO, root))) {
      const text = await readFile(file, 'utf8');
      const rel = relative(file);
      const eventish = EVENTISH.test(text);
      const patterns: { pattern: RegExp; kind: string }[] = SITE_PATTERNS.map((pattern) => ({
        pattern,
        kind: 'produce',
      }));
      if (eventish) {
        for (const pattern of CONSUMER_PATTERNS) patterns.push({ pattern, kind: 'consume' });
      }
      for (const { pattern, kind } of patterns) {
        pattern.lastIndex = 0;
        let match = pattern.exec(text);
        while (match !== null) {
          for (const group of match.slice(1)) {
            if (group === undefined) continue;
            addSite(sites, group, `${rel}:${lineOf(text, match.index)}`, kind);
          }
          match = pattern.exec(text);
        }
      }
      // A3：非字面量的事件名（转发点）。只允许白名单里的包装函数。
      const allowed = NON_LITERAL_ALLOWLIST.find((entry) => entry.file === rel);
      NON_LITERAL.lastIndex = 0;
      let literal = NON_LITERAL.exec(text);
      while (literal !== null) {
        const where = `${rel}:${lineOf(text, literal.index)}`;
        if (allowed === undefined) {
          const value = literal[1] ?? 'type 简写';
          fail(
            where,
            `[A3 非字面量] 事件名不是字符串字面量（${value}）：` +
              '要么写成字面量，要么把包装点登记进 NON_LITERAL_ALLOWLIST',
          );
        }
        literal = NON_LITERAL.exec(text);
      }
    }
  }
  return sites;
}

function checkUnclassified(sites: Map<string, { where: string; kind: string }[]>): void {
  for (const [name, places] of [...sites].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (tierOf(name) !== undefined) continue;
    const where = places[0]?.where ?? '(unknown)';
    fail(
      where,
      `[A1 未分类] 事件类型 "${name}" 不在 EVENT_TIERS、也不属于已登记的前缀家族；` +
        '先在 apps/web/src/state/event-visibility.ts 登记档位，' +
        '再在 docs/architecture/events.md 的 marker 表里写一行',
    );
  }
}

function checkTableRot(sites: Map<string, { where: string; kind: string }[]>): void {
  for (const [name, spec] of [...Object.entries(EVENT_TIERS)].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const found = sites.has(name);
    if (spec.live && !found) {
      fail(
        `EVENT_TIERS["${name}"]`,
        '[A2 表腐烂] 标了 live: true，但源码里扫不到这个事件名（改名了？还是已下线？）',
      );
    }
    if (!spec.live && found) {
      note(`[legacy] ${name} 只有消费点、没有生产者（表里 live: false）`);
    }
  }
}

// ── A4：渲染不变量 fixture ────────────────────────────────

function entryOf(type: string, data: Record<string, unknown> = {}): StoredEvent {
  const event = { type, run_id: 'gate-run', ts: 1, data } as unknown as RunEvent;
  return { event, seq: 1 };
}

function visible(type: string, showInternal: boolean): boolean {
  return isVisibleInChat(type, { showInternal, errorLevel: 'user' });
}

function rawEventItems(type: string): boolean {
  const group = buildGroup('gate-run', [entryOf(type)]);
  return group.items.some((item) => item.kind === 'event');
}

function checkRenderFixtures(): void {
  for (const [name, spec] of Object.entries(EVENT_TIERS)) {
    checkTierSemantics(name, spec);
    checkFailureTier(name, spec);
    if (spec.tier !== 'content') continue;
    // content 的表示层：必须是专用卡片 / typed notice，不能是原始事件卡
    // （`rawCard: true` 的 `guardrail.blocked` 与 `承接: 'card'` 的 tool.call.* 例外）。
    if (spec.rawCard !== true && spec.承接 !== 'card' && rawEventItems(name)) {
      fail(
        `EVENT_TIERS["${name}"]`,
        '[A4 渲染] content 档落了原始事件行（kind: "event"）；要么给 typed notice / 卡片，' +
          '要么显式标 rawCard: true',
      );
    }
  }
  // 未登记类型：按 internal 处理，且必须折叠成 notice（绝不裸卡）。
  const unknown = 'plugin.something.unregistered';
  if (tierOf(unknown) !== undefined) {
    fail('EVENT_TIERS', `[A4 兜底] fixture 用的未登记类型 "${unknown}" 竟然被登记了`);
  }
  if (visible(unknown, false)) {
    fail('fixture', '[A4 兜底] 未登记类型在默认档可见（应按 internal 隐藏）');
  }
  if (!visible(unknown, true)) {
    fail('fixture', '[A4 兜底] 未登记类型在 showInternal 下不可见');
  }
  const unknownGroup = buildGroup('gate-run', [entryOf(unknown)]);
  if (!unknownGroup.items.some((item) => item.kind === 'notice')) {
    fail('apps/web/src/state/events.ts', '[A4 兜底] 未登记类型没有落成 notice（裸卡回来了）');
  }
  if (unknownGroup.items.some((item) => item.kind === 'event')) {
    fail('apps/web/src/state/events.ts', '[A4 兜底] 未登记类型落成了原始事件行');
  }
  // 家族前缀本身必须能被 tierOf 还原（门禁管不到的边界至少不会裸卡）。
  for (const family of EVENT_TIER_FAMILIES) {
    const sample = `${family.prefix}visibility.gate`;
    if (tierOf(sample) !== family.tier) {
      fail('EVENT_TIER_FAMILIES', `[A4 家族] "${sample}" 没有命中 ${family.tier} 档`);
    }
  }
  checkShadow();
}

function checkTierSemantics(name: string, spec: EventSpec): void {
  const off = visible(name, false);
  const on = visible(name, true);
  if (spec.tier === 'content') {
    if (!off || !on) fail(`EVENT_TIERS["${name}"]`, '[A4 fixture] content 档必须两档都可见');
    return;
  }
  if (spec.tier === 'observe') {
    if (off || on) {
      fail(`EVENT_TIERS["${name}"]`, '[A4 fixture] observe 档必须两档都不可见（与开关无关）');
    }
    return;
  }
  if (off) fail(`EVENT_TIERS["${name}"]`, '[A4 fixture] internal 档默认档不该可见');
  if (!on) fail(`EVENT_TIERS["${name}"]`, '[A4 fixture] internal 档在 showInternal 下必须可见');
}

function checkFailureTier(name: string, spec: EventSpec): void {
  // 任何集合都在 `ui.errorLevel` 之前过滤：塞进 observe 等于静默真失败。
  if (spec.tier === 'observe' && isErrorEventType(name)) {
    fail(
      `EVENT_TIERS["${name}"]`,
      '[A4 失败档位] observe 档里出现了失败类（.failed / .error / error / guardrail.blocked）；' +
        '失败类只能 content 或 internal',
    );
  }
  if (spec.tier !== 'content' && isErrorEventType(name) && /^(run|tool|guardrail)\./.test(name)) {
    fail(
      `EVENT_TIERS["${name}"]`,
      '[A4 失败档位] run. / tool. / guardrail. 前缀的失败类必须是 content',
    );
  }
}

function legacyVisible(type: string): boolean {
  // 影子口径 = 今天两张黑名单的**集合判定**（errorLevel 那层单列在 fixture 里，
  // 因为「靠名字后缀偶然安全」正是本方案要收掉的东西）。
  return (
    !LEGACY_CHAT_HIDDEN.includes(type) &&
    !LEGACY_INTERNAL.includes(type) &&
    !type.startsWith('subagent.')
  );
}

function checkShadow(): void {
  const computed: string[] = [];
  for (const name of Object.keys(EVENT_TIERS)) {
    const was = legacyVisible(name);
    const now = visible(name, false);
    if (was && !now) computed.push(name);
    // 反向：今天藏着的类型不得突然变可见（白名单只允许「收紧」，不允许「放开」）。
    if (!was && now) {
      fail(
        `EVENT_TIERS["${name}"]`,
        `[A4 影子] "${name}" 今天在两张黑名单里（不可见），新表却让它可见了；反向放宽必须单独立项`,
      );
    }
  }
  const expected = new Set(EXPECTED_NEWLY_HIDDEN);
  const actual = new Set(computed);
  for (const name of actual) {
    if (!expected.has(name)) {
      fail(
        `EVENT_TIERS["${name}"]`,
        '[A4 影子] 这条今天可见、新表收掉了，但不在审计报告 §3 的差集里（多藏了）',
      );
    }
  }
  for (const name of expected) {
    if (!actual.has(name)) {
      fail(
        `EVENT_TIERS["${name}"]`,
        '[A4 影子] 报告 §3 要求收掉的类型，新表仍可见（少藏了 / 或已改档）',
      );
    }
  }
  // content 类被误藏 = 最痛的风险：单独钉一遍，不只靠差集。
  for (const name of EXPECTED_CONTENT) {
    const spec = EVENT_TIERS[name];
    if (spec === undefined) {
      fail(`EVENT_TIERS["${name}"]`, '[A4 影子] 报告 §3.1 的 content 类型在表里不存在');
      continue;
    }
    if (spec.tier !== 'content' || !visible(name, false)) {
      fail(
        `EVENT_TIERS["${name}"]`,
        '[A4 影子] content 类型被降档 / 隐藏了（正文或工具会静默消失）',
      );
    }
  }
  // 分档计数（回归时一眼看出哪一档漏了）：115 条 = 15 content + 51 internal + 49 observe。
  // （114 → 115：新增 `prompt.system_context`（content，模型上下文卡），见 event-visibility.ts。）
  const counts = { content: 0, internal: 0, observe: 0 };
  for (const spec of Object.values(EVENT_TIERS)) counts[spec.tier] += 1;
  const total = counts.content + counts.internal + counts.observe;
  if (total !== 115) {
    fail('EVENT_TIERS', `[A4 影子] 表里应有 115 条，实际 ${total} 条`);
  }
  note(
    `[shadow] 影子对拍：今天可见→新表隐藏 ${actual.size} 条（期望 ${expected.size}）；` +
      `分档 content ${counts.content} / internal ${counts.internal} / observe ${counts.observe}`,
  );
}

// ── A5：双链对拍（团队日志 ↔ SYSTEM_KEYS） ────────────────

async function checkTeamChain(): Promise<void> {
  const serviceText = await readFile(join(REPO, 'packages/agent/src/team-service.ts'), 'utf8');
  const start = serviceText.indexOf('private systemEventFor(');
  if (start < 0) {
    fail('packages/agent/src/team-service.ts', '[A5 双链] 找不到 systemEventFor');
    return;
  }
  // 只取函数体（到 2 空格缩进的收尾 `}` 或下一个成员为止），否则会把后面的类字段
  // / 其它方法的字符串字面量当成 system_event 值。
  const tail = serviceText.slice(start);
  const endMatch = /\n {2}\}\n/.exec(tail);
  const body = endMatch === null ? tail : tail.slice(0, endMatch.index);
  const cases = [...body.matchAll(/case\s+'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'\s*:/g)].map(
    (match) => match[1] as string,
  );
  const systemEvents = new Set(
    [...body.matchAll(/'([a-z]+)'/g)].map((match) => match[1] as string),
  );
  for (const name of cases) {
    const spec = EVENT_TIERS[name];
    if (spec === undefined) {
      fail(
        'packages/agent/src/team-service.ts',
        `[A5 双链] systemEventFor 认得 "${name}"，但表里没有这条`,
      );
      continue;
    }
    if (spec.teamLog !== 'system') {
      fail(
        `EVENT_TIERS["${name}"]`,
        '[A5 双链] 服务端会给它写 system 行，表里必须声明 teamLog: "system"',
      );
    }
  }
  if (cases.length === 0) {
    fail('packages/agent/src/team-service.ts', '[A5 双链] systemEventFor 没有 case');
  }

  const rowFile = join(REPO, 'apps/web/src/domains/team/TeamMessageRow.tsx');
  const rowText = await readFile(rowFile, 'utf8');
  const keysStart = rowText.indexOf('const SYSTEM_KEYS');
  const keysBlock = keysStart < 0 ? '' : rowText.slice(keysStart, rowText.indexOf('};', keysStart));
  const keys = new Set(
    [...keysBlock.matchAll(/^\s*([a-z_]+):/gm)].map((match) => match[1] as string),
  );
  if (keys.size === 0) {
    fail('apps/web/src/domains/team/TeamMessageRow.tsx', '[A5 双链] 找不到 SYSTEM_KEYS');
  }
  for (const value of systemEvents) {
    if (!keys.has(value)) {
      fail(
        'apps/web/src/domains/team/TeamMessageRow.tsx',
        `[A5 双链] 服务端会写 system_event: "${value}"，但 SYSTEM_KEYS 没有对应文案`,
      );
    }
  }
  for (const key of keys) {
    if (!systemEvents.has(key)) {
      note(`[legacy] SYSTEM_KEYS.${key} 只出现在旧日志里（新代码不再写）`);
    }
  }

  // 表里的 teamLog 声明与服务端事实一致（多声明 = 假承诺，少声明 = 漏写团队行）。
  const declared = new Set(
    Object.entries(EVENT_TIERS)
      .filter(([, spec]) => spec.teamLog !== undefined && spec.teamLog !== 'none')
      .map(([name]) => name),
  );
  for (const name of SERVER_TEAM_LOG) {
    if (!declared.has(name)) {
      fail(`EVENT_TIERS["${name}"]`, '[A5 双链] 服务端会写团队日志，表里却没声明 teamLog');
    }
  }
  for (const name of declared) {
    if (!SERVER_TEAM_LOG.includes(name)) {
      fail(
        `EVENT_TIERS["${name}"]`,
        '[A5 双链] 表里声明了 teamLog，但服务端不会为它写团队日志（假承诺）',
      );
    }
  }
}

// ── A6：文档 marker 对拍 ──────────────────────────────────

async function checkDocs(): Promise<void> {
  const file = join(REPO, 'docs/architecture/events.md');
  const text = await readFile(file, 'utf8');
  const begin = text.indexOf('<!-- event-visibility:begin -->');
  const end = text.indexOf('<!-- event-visibility:end -->');
  if (begin < 0 || end < begin) {
    fail('docs/architecture/events.md', '[A6 文档] 缺少 event-visibility:begin/end marker');
    return;
  }
  const section = text.slice(begin, end);
  const documented = new Set(
    [...section.matchAll(/^\|\s*`([a-z0-9_.]+)`\s*\|/gm)].map((match) => match[1] as string),
  );
  for (const name of Object.keys(EVENT_TIERS)) {
    if (!documented.has(name)) {
      fail('docs/architecture/events.md', `[A6 文档] 表里有 "${name}"，marker 表里没有`);
    }
  }
  for (const name of documented) {
    if (EVENT_TIERS[name] === undefined) {
      fail('docs/architecture/events.md', `[A6 文档] marker 表写了 "${name}"，代码里没登记`);
    }
  }
}

// ── 入口 ──────────────────────────────────────────────────

const sites = await scanSources();
console.log(`scanned ${sites.size} event name(s) in ${(await scanRoots()).length} source root(s)`);
checkUnclassified(sites);
checkTableRot(sites);
checkRenderFixtures();
await checkTeamChain();
await checkDocs();

if (failures.length > 0) {
  for (const failure of failures) console.log(`FAIL  ${failure}`);
  console.error(`event visibility: ${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log('event visibility: all checks passed');
