#!/usr/bin/env bun

/**
 * 插件端口面门禁（0.51 期 0.5 + 期 0）。
 *
 * 这一期的验收是「什么都没变」，所以探针钉的是**边界**而不是功能：
 * 1. 清单：`vessel.scope` / `permissions.ports` 的接受与拒绝矩阵（含 in-process 包也走校验 ——
 *    期 0.5 补的那个洞：以前 in-process 包完全不校验，声明错了照样装进来）；
 * 2. 宿主：`registerMemberBodyContribution` 的去重 / 回滚，以及「贡献绝不进节点工具面」；
 * 3. 端口：`MemberInboxPort` 的三态映射、`quiet` 落档、只删未读未持有；
 *    端口给不出来时整条贡献不生效（fail-closed）；
 * 4. 空壳贡献：登记后 `listTools()` 与不登记逐条相同。
 *
 * 用法：bun run scripts/check-plugin-ports.ts
 * 退出码：0 = 全过；1 = 有 FAIL。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentInboxStore,
  buildMemberBodyPorts,
  createInboxMemberBodyContribution,
  MemberExecutionHost,
} from '@vessel-agent/agent';
import {
  type MemberBodyContribution,
  MemoryPluginHost,
  noopLogger,
  Runtime,
  type ToolDefinition,
} from '@vessel-agent/core';
import { PluginLoader } from '../src/plugin-loader';
import { validatePluginManifest } from '../src/plugin-manifest';

const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) return;
  failures.push(name);
  console.log(`FAIL ${name}`);
  if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
}

// ── 1 清单：声明面与 fail-closed ────────────────────────────────────────────

const CHILD_BASE = {
  id: 'demo',
  name: 'Demo',
  version: '0.1.0',
  engines: { vessel: '>=0.43 <1.0.0' },
  entry: 'src/index.ts',
};

const IN_PROCESS_BASE = {
  id: 'demo',
  name: 'Demo',
  version: '0.1.0',
  engines: { vessel: '>=0.43 <1.0.0' },
};

interface ManifestCase {
  name: string;
  raw: Record<string, unknown>;
  inProcess: boolean;
  /** 期望：通过 / 拒绝 */
  ok: boolean;
  vesselVersion: string;
}

const MANIFEST_CASES: readonly ManifestCase[] = [
  {
    name: 'M1 in-process 成员面插件通过（无 entry、scope member + ports）',
    raw: { ...IN_PROCESS_BASE, scope: 'member', permissions: { ports: ['inbox'] } },
    inProcess: true,
    ok: true,
    vesselVersion: '0.51.0',
  },
  {
    name: 'M2 scope 缺省为 node',
    raw: { ...IN_PROCESS_BASE },
    inProcess: true,
    ok: true,
    vesselVersion: '0.51.0',
  },
  {
    name: 'M3 未知端口名拒绝（白名单是闭集）',
    raw: { ...IN_PROCESS_BASE, scope: 'member', permissions: { ports: ['filesystem'] } },
    inProcess: true,
    ok: false,
    vesselVersion: '0.51.0',
  },
  {
    name: 'M4 声明 ports 但 scope 不是 member ⇒ 拒绝',
    raw: { ...IN_PROCESS_BASE, permissions: { ports: ['inbox'] } },
    inProcess: true,
    ok: false,
    vesselVersion: '0.51.0',
  },
  {
    name: 'M5 child 插件声明 scope member ⇒ 拒绝（child 没有 body 宿主）',
    raw: { ...CHILD_BASE, scope: 'member', contributes: {} },
    inProcess: false,
    ok: false,
    vesselVersion: '0.51.0',
  },
  {
    name: 'M6 scope 取值只允许 node / member',
    raw: { ...IN_PROCESS_BASE, scope: 'body' },
    inProcess: true,
    ok: false,
    vesselVersion: '0.51.0',
  },
  {
    name: 'M7 child 清单仍要求 entry（in-process 放宽不能外溢）',
    raw: { ...IN_PROCESS_BASE, contributes: {} },
    inProcess: false,
    ok: false,
    vesselVersion: '0.51.0',
  },
];

for (const testCase of MANIFEST_CASES) {
  const result = validateManifest(testCase);
  check(testCase.name, result === testCase.ok, { accepted: result });
}

function validateManifest(testCase: ManifestCase): boolean {
  // 直接调公共解析器：矩阵要的是「校验层怎么判」，与 loader 的目录扫描解耦。
  const result = validatePluginManifest(testCase.raw, {
    baseDir: process.cwd(),
    vesselVersion: testCase.vesselVersion,
    ...(testCase.inProcess ? { mode: 'in-process' as const } : {}),
  });
  return result.ok;
}

// ── 2 加载器：in-process 包也走清单校验（期 0.5 的洞） ──────────────────────

const tempRoot = mkdtempSync(join(tmpdir(), 'vessel-plugin-ports-'));
try {
  writeInProcessPlugin('member-body-ok', {
    id: 'member-body-ok',
    name: 'Member body ok',
    version: '0.1.0',
    engines: { vessel: '>=0.43 <1.0.0' },
    scope: 'member',
    permissions: { ports: ['inbox'] },
  });
  // 期 0.5 之前：这个包会被当成普通 in-process 插件装进来（vessel 段根本没人校验）。
  writeInProcessPlugin('bad-ports', {
    id: 'bad-ports',
    name: 'Bad ports',
    version: '0.1.0',
    engines: { vessel: '>=0.43 <1.0.0' },
    permissions: { ports: ['inbox'] },
  });
  // 旧形态：只有 override 标记、没有清单字段，必须继续可用（0.51 期 0 零行为变化）。
  writeInProcessPlugin('legacy-override', { override: true });

  const loader = new PluginLoader({
    roots: [{ dir: tempRoot, source: 'project', layout: 'auto' }],
  });
  // 拒绝必须是 `plugin_manifest_invalid` 报出来的，而不是「悄悄少一个插件」；
  // 顺手把这行告警收进断言，探针输出才只剩结果。
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
  };
  const names = (() => {
    try {
      return loader.list().map((descriptor) => descriptor.name);
    } finally {
      console.warn = realWarn;
    }
  })();
  check('L1 成员面插件被接受', names.includes('member-body-ok'), names);
  check(
    'L2 ports 与 scope 不匹配的 in-process 包被拒（期 0.5）',
    !names.includes('bad-ports'),
    names,
  );
  check('L3 只有 override 的旧形态仍然加载', names.includes('legacy-override'), names);
  check(
    'L4 拒绝是通过 plugin_manifest_invalid 报出来的',
    warnings.some(
      (line) => line.startsWith('[plugin_manifest_invalid]') && line.includes('bad-ports'),
    ),
    warnings,
  );
  const accepted = loader.list().find((descriptor) => descriptor.name === 'member-body-ok');
  check(
    'L5 解析出的 in-process 清单带 scope / ports',
    accepted?.capabilityManifest?.scope === 'member' &&
      accepted?.capabilityManifest?.permissions.ports.join(',') === 'inbox',
    accepted?.capabilityManifest,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function writeInProcessPlugin(name: string, vessel: Record<string, unknown>): void {
  const dir = join(tempRoot, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@vessel-agent/${name}`,
      version: '0.1.0',
      type: 'module',
      exports: { '.': './src/index.ts' },
      vessel,
    }),
  );
  writeFileSync(join(dir, 'src', 'index.ts'), 'export default { name: "x", install() {} };\n');
}

// ── 3 宿主：贡献的登记 / 去重 / 回滚，且不进节点工具面 ─────────────────────

const host = new MemoryPluginHost();
const shell: MemberBodyContribution<'inbox'> = createInboxMemberBodyContribution();
check('H1 空壳贡献声明 inbox 端口', shell.ports.join(',') === 'inbox', shell.ports);

const toolsBefore = host.listTools().map((tool) => tool.name);
host.registerMemberBodyContribution(shell);
check('H2 贡献登记后能读回', host.getMemberBodyContributions().length === 1);
check(
  'H3 贡献不进节点工具面（listTools 逐条相同）',
  JSON.stringify(host.listTools().map((tool) => tool.name)) === JSON.stringify(toolsBefore),
  host.listTools().map((tool) => tool.name),
);

const replacement: MemberBodyContribution<'inbox'> = { ...shell, tools: () => [] };
host.registerMemberBodyContribution(replacement);
check('H4 同名再登记 = 覆盖（去重）', host.getMemberBodyContributions().length === 1);

const scope = host.beginPluginInstall();
const temporary: MemberBodyContribution<'inbox'> = { ...shell, name: 'temporary' };
host.registerMemberBodyContribution(temporary);
check('H5 安装期间登记可见', host.getMemberBodyContributions().length === 2);
scope.rollback();
check('H6 安装回滚摘掉本次登记', host.getMemberBodyContributions().length === 1);

const overwriteScope = host.beginPluginInstall();
host.registerMemberBodyContribution({ ...shell, name: 'overwrite-target' });
host.registerMemberBodyContribution({ ...shell, name: 'overwrite-target', tools: () => [] });
overwriteScope.rollback();
check(
  'H7 回滚复原被覆盖的那次登记，而不是留个洞',
  host.getMemberBodyContributions().length === 1,
  host.getMemberBodyContributions().map((entry) => entry.name),
);

// ── 4 端口：三态、quiet 落档、只删未读未持有、fail-closed ──────────────────

const dataDir = mkdtempSync(join(tmpdir(), 'vessel-plugin-ports-inbox-'));
try {
  const store = new AgentInboxStore({ dataDir, tenantId: 'default', logger: noopLogger });
  const ports = buildMemberBodyPorts({
    requested: ['inbox'],
    inbox: store,
    agentId: 'member-1',
    sessionId: 'sess-1',
  });
  check('P1 有收件箱时端口表可用', ports !== undefined);

  const inboxPort = ports?.inbox;
  if (inboxPort === undefined) throw new Error('inbox port missing');

  store.append('member-1', { id: 'm1', ts: 1, source: 'human', text: 'hello' });
  store.append('member-1', { id: 'm2', ts: 2, source: 'human', text: 'second' });
  store.hold('member-1', 'm2', 'sess-old');

  const listed = inboxPort.list();
  check(
    'P2 list 只给可读条目，held 折叠进三态',
    listed.unread === 1 && listed.messages.map((message) => message.id).join(',') === 'm1',
    listed,
  );
  const withHeld = inboxPort.list({ includeHeld: true });
  check(
    'P3 list(includeHeld) 把在途条目标成 held',
    withHeld.messages.some((message) => message.id === 'm2' && message.status === 'held'),
    withHeld,
  );

  const discarded = inboxPort.discard(['m2', 'nope']);
  check(
    'P4 discard 只删未读未持有（held 与未知 id 进 skipped）',
    discarded.deleted.length === 0 &&
      discarded.skipped.map((entry) => entry.reason).join(',') === 'held,not_found',
    discarded,
  );

  const appended = inboxPort.appendOwn({ text: 'own note' });
  check('P5 appendOwn 落档成功', appended.accepted === true, appended);

  const read = await inboxPort.read({ ids: ['m1'] });
  check(
    'P6 read 给正文；未被持有的条目读即 consumed（端口如实回报，所以不需要 markConsumed）',
    read.length === 1 && read[0]?.text === 'hello' && read[0]?.status === 'consumed',
    read,
  );
  const afterRead = inboxPort.list();
  check(
    'P7 读过的条目不再出现在可读列表里（只剩 appendOwn 那条）',
    !afterRead.messages.some((message) => message.id === 'm1') &&
      afterRead.messages.some((message) => message.text === 'own note'),
    afterRead,
  );

  check(
    'P8 没有收件箱时端口表整条给不出来（fail-closed，不降级成半个端口面）',
    buildMemberBodyPorts({
      requested: ['inbox'],
      inbox: undefined,
      agentId: 'member-1',
      sessionId: 'sess-1',
    }) === undefined,
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 5 空壳贡献的工具面（期 0 的验收：什么都没变） ─────────────────────────

const shellTools: readonly ToolDefinition[] = shell.tools({
  pluginId: shell.name,
  agentId: 'member-1',
  sessionId: 'sess-1',
  ports: { inbox: {} as never },
  isActive: () => true,
  publish: () => {},
});
check(
  'T1 空壳贡献不产出工具',
  shellTools.length === 0,
  shellTools.map((tool) => tool.name),
);

// ── 6 成员身体：登记空壳贡献前后，`tools.list{agent_id}` 的推导值逐字相同 ──

const surfaceDataDir = mkdtempSync(join(tmpdir(), 'vessel-plugin-ports-surface-'));
try {
  const shareStore = new AgentInboxStore({
    dataDir: surfaceDataDir,
    tenantId: 'default',
    logger: noopLogger,
  });
  const withParentTool = (host: MemoryPluginHost): MemoryPluginHost => {
    host.registerTool({
      name: 'read',
      description: 'read a file',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    });
    return host;
  };
  const bare = withParentTool(new MemoryPluginHost());
  const withShellHost = withParentTool(new MemoryPluginHost());
  withShellHost.registerMemberBodyContribution(shell);

  const derivedSurface = (
    pluginHost: MemoryPluginHost,
    withInbox: boolean,
  ): readonly { name: string }[] => {
    const memberHost = new MemberExecutionHost({
      runtime: new Runtime(),
      pluginHost,
      permissionMode: 'allow',
    });
    // 收件箱是「运行期注入」那一半：两条路径都要比，否则「没 attach 收件箱」没人测。
    if (withInbox) memberHost.attachInbox?.(shareStore);
    // 0.51：`toolSurface` 与 `tools.list` 同形 —— 直接是条目数组，不再包一层对象。
    return memberHost.toolSurface({
      id: 'member-1',
      session_id: 'sess-1',
      role: 'member',
      visibility: 'private',
    });
  };
  const toolNames = (surface: readonly { name: string }[]): string[] =>
    surface.map((entry) => entry.name);

  for (const withInbox of [false, true]) {
    const label = withInbox ? '（attach 收件箱）' : '（无收件箱）';
    const before = derivedSurface(bare, withInbox);
    const after = derivedSurface(withShellHost, withInbox);
    // 无收件箱时端口给不出来 ⇒ 贡献整条不装配；attach 之后它才真的参与合并。
    // 两种情形都必须与不登记贡献时逐字相同。
    check(`S1 推导工具面逐字相同${label}`, JSON.stringify(before) === JSON.stringify(after), {
      bare: toolNames(before),
      withShell: toolNames(after),
    });
  }
  const inboxNames = toolNames(derivedSurface(withShellHost, true));
  check('S2 收件箱工具仍出现在工具面里', inboxNames.includes('inbox'), inboxNames);
} finally {
  rmSync(surfaceDataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`plugin ports: ${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log('plugin ports: all checks passed');
