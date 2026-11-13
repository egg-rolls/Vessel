#!/usr/bin/env bun

/**
 * `agent` 工具的 `list` 输出门禁（0.52）。
 *
 * 用户的原话是「agent list 能看到 body_history，建议不显示」——它对人排查 rotate 有用，
 * 对 Agent 只是每次 list 凭空多出的 N 条噪声。做法是**只在工具序列化这一层剥掉**，
 * DTO / `agents.list` RPC / Web 成员详情保持完整。这个界限必须钉住，因为两种退化都不会报错：
 *
 * - A/B 工具输出：owner 路径与 Team roster 路径都不能再把 `body_history` 吐给模型；
 *   同时 `bodies`（还在的 body）与 `id`/`session_id`/`state` 必须原样保留 —— 剥多了是另一种坏；
 * - C 数据源没被砍：`registry.ts` 里仍在构造 `body_history`（人还能看到），
 *   否则「不显示」会被下一个人理解成「删字段」，管理面跟着一起失明；
 * - D 静态接线：剥壳函数在 list 的两条返回路径上都被调用（只剥一条是典型漏点）。
 *
 * 用法：bun run scripts/check-agent-tool-list.ts（退出码 0 = 全过，1 = 有 FAIL）
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentTool } from '../packages/agent/src/tool';

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

/** 一具退役 body 的档案：工具输出里必须消失，RPC 里必须还在 */
const RETIRED_BODY = {
  session_id: 'sess-old',
  epoch: 0,
  retired_at: 1_700_000_000_000,
  binding: { kind: 'owner' },
};

const MEMBER = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ask-dedupe',
  session_id: 'sess-live',
  state: 'idle',
  role: 'temporary',
  visibility: 'private',
  bodies: [{ session_id: 'sess-live', epoch: 1 }],
  body_history: [RETIRED_BODY],
};

type FakeService = Parameters<typeof createAgentTool>[0];

function toolFor(service: unknown, options: Record<string, unknown> = {}) {
  return createAgentTool(service as FakeService, options as never);
}

const ownerTool = toolFor({
  list: async () => [MEMBER],
});

const ownerOut = JSON.parse(
  await ownerTool.handler?.({ action: 'list' }, { run_id: 'r1' } as never),
) as Record<string, unknown>[];

const firstOwner = (ownerOut[0] ?? {}) as Record<string, unknown>;

// A. owner 路径
expect(ownerOut.length === 1, `A: owner list 应返回 1 条，实际 ${String(ownerOut.length)} 条`);
expect(
  firstOwner.body_history === undefined,
  'A: owner list 仍然吐出了 body_history（0.52 起工具层必须剥掉）',
);
expect(firstOwner.id === MEMBER.id, 'A: 剥壳把 id 也剥掉了');
expect(firstOwner.session_id === MEMBER.session_id, 'A: 剥壳把 session_id 也剥掉了');
expect(firstOwner.state === MEMBER.state, 'A: 剥壳把 state 也剥掉了');
expect(
  Array.isArray(firstOwner.bodies) && (firstOwner.bodies as unknown[]).length === 1,
  'A: bodies（还在的 body）被误删 —— 现状 body 是 Agent 需要的信息',
);
expect(
  JSON.stringify(ownerOut).includes('sess-old') === false,
  'A: 退役 body 的 session id 仍然出现在工具输出里',
);

// B. Team roster 路径（成员调用）
const rosterTool = toolFor(
  { identify: async () => ({ id: 'caller', team_id: 'team-1' }), list: async () => [] },
  {
    ownerSessionId: 'sess-owner',
    team: { listForCaller: async () => [MEMBER] },
  },
);

const rosterOut = JSON.parse(
  await rosterTool.handler?.({ action: 'list' }, {
    run_id: 'r2',
    session_id: 'sess-member',
  } as never),
) as Record<string, unknown>[];

expect(rosterOut.length === 1, `B: roster list 应返回 1 条，实际 ${String(rosterOut.length)} 条`);
expect(
  rosterOut[0]?.body_history === undefined,
  'B: team roster 路径仍然吐出了 body_history（两条返回路径都要剥）',
);
expect(rosterOut[0]?.session_id === MEMBER.session_id, 'B: roster 路径把 session_id 剥掉了');

// C. 数据源没被砍：管理面（RPC / Web 详情）仍要有 body_history
const registry = await source('packages/agent/src/registry.ts');
expect(
  registry.includes('body_history'),
  'C: registry.ts 里已经没有 body_history —— 这是删数据源，不是「不显示」；管理面会一起失明',
);

// D. 静态接线：list 的两条返回路径都套了剥壳函数
const toolSrc = await source('packages/agent/src/tool.ts');
const stripCalls = toolSrc.match(/withoutBodyHistory\(/gu)?.length ?? 0;
expect(
  stripCalls >= 2,
  `D: tool.ts 里 withoutBodyHistory( 只出现 ${String(stripCalls)} 次 —— list 的两条返回路径要各调一次`,
);
expect(
  toolSrc.includes('return JSON.stringify(await service.list(filter));') === false,
  'D: owner 路径的 list 仍是裸 JSON.stringify(await service.list(filter)) —— 剥壳没接上',
);
expect(
  /return JSON\.stringify\(withoutBodyHistory\(await service\.list\(filter\)\)\);/u.test(toolSrc),
  'D: owner 路径必须 JSON.stringify(withoutBodyHistory(await service.list(filter)))',
);

if (failures.length > 0) {
  console.error(
    `check-agent-tool-list: ${String(failures.length)} 项 FAIL（共 ${String(checked)} 项）`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-agent-tool-list: OK（${String(checked)} 项：owner / roster 两条路径剥 body_history + 保留 bodies + 数据源仍在 + 接线）`,
);
