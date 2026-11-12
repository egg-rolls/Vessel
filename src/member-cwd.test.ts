/**
 * 「成员 cwd」链路的窄属性测试（0.51 Bug 1：成员 cwd 进入工具层）。
 *
 * 为什么长成这样：仓库没有 test gate（见 AGENTS.md「验证纪律」），纯/近纯函数的探针是
 * 被允许的例外；写法沿用 `src/refs-notice-hook.test.ts` 与 `plugins/.../test/probe.ts`
 * （`check()` + 计数 + 汇总）。直接跑：
 *
 *   bun run src/member-cwd.test.ts
 *
 * 判定看**输出文本**（`OK member-cwd: passed N / N` 或 `FAIL ...`）：本机 bun 是 Windows 版，
 * 退出码不可信。命名带 `.test.ts` 让它落在发布包外，同时留在 `bun run typecheck` 的范围内。
 *
 * 必须在**仓库根**跑：其中两条用例要靠「相对路径读 `package.json`」判定落到了
 * `process.cwd()`（降级终点就是它，换成别的落点就没有可判的东西了）。
 *
 * 断言的是**行为不变量**，不是实现细节：
 * - 优先级：工具参数 cwd > `agent.cwd` > 成员 cwd（`ToolContext.cwd`）> `process.cwd()`；
 * - 成员 cwd 是**默认起点**：目录不存在时降级、不改错；显式配的 `agent.cwd` 仍硬错；
 * - 成员 cwd 不放宽路径边界（deny 目录 / `allowed_roots` 照旧）；
 * - 锚点 Team 不参与（判据 `memberCwdFromTeam` 是 create 与装配层共用的那一份）。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ToolContext, ToolDefinition } from '../packages/core/src/index';
import {
  isAnchorWorkspace,
  memberCwdFromTeam,
  resolveMemberCwd,
} from '../packages/agent/src/member-cwd';
import { createBasicTools } from '../plugins/tools/basic-tools/src/index';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, got?: string): void {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(got === undefined ? name : `${name} | got: ${got}`);
}

/** 探针里的工具上下文：工具只用到 `signal` / `session_id` / `cwd`，事件流用空壳。 */
function ctxFor(cwd?: string): ToolContext {
  return {
    run_id: 'run-cwd-test',
    messages: [],
    events: {} as unknown as ToolContext['events'],
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

function toolNamed(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool: ${name}`);
  return tool;
}

/** 建一个临时目录并在里面放一个可辨认的文件（成功 = 从**这个目录**读到了内容） */
function scaffoldDir(root: string, name: string, marker: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'marker.txt'), marker, 'utf-8');
  return dir;
}

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'vessel-cwd-'));
  const configuredDir = scaffoldDir(root, 'configured', 'from-configured');
  const memberDir = scaffoldDir(root, 'member', 'from-member');
  const missingDir = path.join(root, 'does-not-exist');
  const deniedDir = path.join(root, 'denied-root');

  // ---- 1. 未配 agent.cwd、成员有 cwd ⇒ 用成员 cwd ----
  const bare = createBasicTools({});
  const bareRead = toolNamed(bare, 'read');
  const memberRead = await bareRead.handler({ path: 'marker.txt' }, ctxFor(memberDir));
  check('成员 cwd 生效（read）', memberRead.includes('from-member'), memberRead);

  const bareBash = toolNamed(bare, 'bash');
  const memberBash = await bareBash.handler(
    { command: 'cat marker.txt' },
    ctxFor(memberDir),
  );
  check('成员 cwd 生效（bash）', memberBash.includes('from-member'), memberBash);

  // 没有成员 cwd ⇒ 旧行为（进程 cwd）。这里只用「相对路径仍可解析」断言，不写死目录。
  const noCwd = await bareRead.handler({ path: 'package.json' }, ctxFor());
  check('无成员 cwd 退回进程 cwd', noCwd.includes('"name": "vessel-agent"'), noCwd);

  // ---- 2. agent.cwd 优先于成员 cwd（用户口径：全局默认压过 Team 基础路径） ----
  const configured = createBasicTools({ cwd: configuredDir });
  const configuredRead = toolNamed(configured, 'read');
  const configuredOut = await configuredRead.handler({ path: 'marker.txt' }, ctxFor(memberDir));
  check('agent.cwd 压过成员 cwd', configuredOut.includes('from-configured'), configuredOut);

  // 工具级显式 cwd 参数仍然最高（bash 有 cwd 参数）
  const configuredBash = toolNamed(configured, 'bash');
  const explicitOut = await configuredBash.handler(
    { command: 'cat marker.txt', cwd: memberDir },
    ctxFor(configuredDir),
  );
  check('工具参数 cwd 最高', explicitOut.includes('from-member'), explicitOut);

  // ---- 3. 降级不改错 ----
  // 3a. 成员 cwd 目录不存在 ⇒ 退回下一级（这里没有 agent.cwd，所以落进程 cwd），不报错
  const degradedRead = await bareRead.handler({ path: 'package.json' }, ctxFor(missingDir));
  check('成员 cwd 不存在时降级', degradedRead.includes('"name": "vessel-agent"'), degradedRead);
  check('降级不产生错误文本', !degradedRead.startsWith('错误'), degradedRead.slice(0, 40));

  const degradedBash = await bareBash.handler({ command: 'pwd' }, ctxFor(missingDir));
  check('成员 cwd 不存在时 bash 仍可跑', !degradedBash.startsWith('错误'), degradedBash.slice(0, 40));

  // 3b. 显式配出来的 agent.cwd 不存在 ⇒ 保持原有硬错（不静默回退，掩盖配置错误）
  const brokenConfig = createBasicTools({ cwd: missingDir });
  const brokenRead = await toolNamed(brokenConfig, 'read').handler(
    { path: 'marker.txt' },
    ctxFor(memberDir),
  );
  check('配置坏 cwd 仍硬错', brokenRead.includes('配置的默认工作目录不存在'), brokenRead);

  // ---- 4. 成员 cwd 不放宽路径边界 ----
  // 4a. 成员 cwd 落在 deny 目录 ⇒ 与显式 cwd 同一条判定（bash 直接拒绝执行）
  const denyCtx = ctxFor(path.join(homedir(), '.ssh'));
  const denyOut = await bareBash.handler({ command: 'pwd' }, denyCtx);
  check('deny 目录的成员 cwd 被拒', denyOut.includes('敏感路径拒绝列表'), denyOut);

  // 4b. 配了 allowed_roots 后，成员 cwd 越界 ⇒ checkPermission 仍是 ask（不是 allow）
  const rooted = createBasicTools({ allowedRoots: [configuredDir] });
  const rootedRead = toolNamed(rooted, 'read');
  const outsideDecision = await rootedRead.checkPermission?.(
    { path: 'marker.txt' },
    ctxFor(deniedDir),
  );
  check('成员 cwd 越界仍 ask', outsideDecision === 'ask', String(outsideDecision));
  const insideDecision = await rootedRead.checkPermission?.(
    { path: 'marker.txt' },
    ctxFor(configuredDir),
  );
  check('成员 cwd 在根内仍 allow', insideDecision === 'allow', String(insideDecision));

  // ---- 5. 锚点 Team 不参与（create 与装配层共用 memberCwdFromTeam） ----
  const dataDir = path.join(root, 'data');
  const anchors = [path.join(dataDir, 'default'), path.join(dataDir, 'headless')];

  const anchorPicked = memberCwdFromTeam(path.join(dataDir, 'default'), anchors);
  check('锚点 default 被排除', anchorPicked === undefined, String(anchorPicked));
  const headlessPicked = memberCwdFromTeam(path.join(dataDir, 'headless'), anchors);
  check('锚点 headless 被排除', headlessPicked === undefined, String(headlessPicked));
  // 大小写 / 尾分隔符差异也要收敛（Windows 上 workspace 与 dataDir 派生值经常不同写法）
  const casePicked = memberCwdFromTeam(path.join(dataDir, 'DEFAULT') + path.sep, anchors);
  check('锚点判据收敛写法差异', casePicked === undefined, String(casePicked));

  const projectPicked = memberCwdFromTeam(memberDir, anchors);
  check('显式 Team 基础路径保留', projectPicked === memberDir, String(projectPicked));
  check('没有 workspace 就没有成员 cwd', memberCwdFromTeam(undefined, anchors) === undefined);

  // 没有锚点配置（纯内存 / 测试）时任何路径都不算锚点
  check('无锚点时默认不排除', memberCwdFromTeam(memberDir, []) === memberDir);
  check('isAnchorWorkspace 单点判据', isAnchorWorkspace(path.join(dataDir, 'default'), anchors));

  // ---- 6. resolveMemberCwd：记录快照 > Team 兜底；失效降级 ----
  const fromRecord = resolveMemberCwd({ recordCwd: memberDir, teamCwd: configuredDir });
  check(
    '记录快照优先',
    fromRecord.cwd === memberDir && fromRecord.source === 'record',
    String(fromRecord.cwd),
  );

  const fromTeam = resolveMemberCwd({ teamCwd: configuredDir });
  check(
    'Team 兜底可用',
    fromTeam.cwd === configuredDir && fromTeam.source === 'team',
    String(fromTeam.cwd),
  );

  const recordBroken = resolveMemberCwd({ recordCwd: missingDir, teamCwd: configuredDir });
  check('快照失效退 Team 兜底', recordBroken.cwd === configuredDir, String(recordBroken.cwd));

  const bothBroken = resolveMemberCwd({ recordCwd: missingDir, teamCwd: missingDir });
  check(
    '两级都失效 ⇒ 降级',
    bothBroken.cwd === undefined && bothBroken.degraded === 'not_a_directory',
    JSON.stringify(bothBroken),
  );
  const none = resolveMemberCwd({});
  check('没有候选 ⇒ none', none.cwd === undefined && none.degraded === 'none', JSON.stringify(none));

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`OK member-cwd: passed ${String(passed)} / ${String(total)} checks`);
    return;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`FAILED member-cwd: passed ${String(passed)} / ${String(total)}`);
  process.exitCode = 1;
}

await main();
