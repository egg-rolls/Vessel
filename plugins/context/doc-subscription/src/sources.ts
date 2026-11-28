/**
 * 三源四方法 facade（q-sub-unify-p1 M3，设计稿 §3.2）。
 *
 * **提取非发明**：每个方法体纯委托现态函数，行为逐字不变；P1 hook 观察循环
 * 不改道（仍直调现态函数），facade 是 additive 契约面，P4 才迁路由。
 * agent 源（M4b）原生按契约建，证明契约可用。
 *
 * 映射（§3.2）：
 * - file: resolveTarget=resolveInput+canonicalPath+evaluatePath（prepareEntry 校验段）；
 *   detect=observeEntry；format=formatSubscriptionNotice（无 content 基线形）。
 * - health: resolveTarget=isValidHealthTarget；detect=observeHealthEntry；format=formatHealthNotice。
 * - script: resolveTarget=isValidScriptName；detect=processScriptEntry（drain）；
 *   format=formatScriptNotice（TChange=ScriptNoticeEntry 富素材）。
 *
 * 预算说明：format 的 budget 参数是契约形状；现态行/明细预算由 notice.ts 常量
 * 强制（SUBSCRIPTION_NOTICE_MAX_LINES / DETAILS_MAX），facade 不另立预算。
 */

import { canonicalPath, evaluatePath, type PathBoundary } from '@vessel-agent/basic-tools';
import type {
  NoticeBudget,
  NoticePayload,
  SourceModule,
  TargetResolution,
} from '@vessel-agent/core';
import { type DocSubscriptionConfig, isValidScriptName, resolveInput } from './config.js';
import { healthSubscriptionKey, isValidHealthTarget } from './health.js';
import {
  type BeforeLlmHookDeps,
  observeEntry,
  observeHealthEntry,
  processScriptEntry,
  type ScriptProcessOutcome,
} from './hook.js';
import {
  formatHealthNotice,
  formatScriptNotice,
  formatSubscriptionNotice,
  HEALTH_NOTICE_SCOPE,
  SCRIPT_NOTICE_SCOPE,
  type ScriptNoticeEntry,
  SUBSCRIPTION_NOTICE_DETAILS_MAX,
  SUBSCRIPTION_NOTICE_MAX_LINES,
  SUBSCRIPTION_NOTICE_SCOPE,
} from './notice.js';
import { type ScriptRunner, scriptSubscriptionKey } from './script.js';
import type { SubscriptionEntry } from './store.js';

/** 现态注册预算（notice.ts 常量的契约镜像）。 */
export const REGISTERED_NOTICE_BUDGET: NoticeBudget = {
  maxLines: SUBSCRIPTION_NOTICE_MAX_LINES,
  maxDetails: SUBSCRIPTION_NOTICE_DETAILS_MAX,
};

/** file 源 resolveTarget 上下文（prepareEntry 校验段所需）。 */
export interface FileResolveContext {
  config: DocSubscriptionConfig;
  boundary: PathBoundary;
}

/** script 源 detect 上下文（processScriptEntry 参数族）。 */
export interface ScriptDetectContext {
  spec: Parameters<typeof processScriptEntry>[1];
  runner: ScriptRunner;
  sessionId: string;
  config: DocSubscriptionConfig;
  now: number;
  kickoffDue: boolean;
}

/** file 源 facade：纯委托 observeEntry / formatSubscriptionNotice。 */
export const fileSource: SourceModule<SubscriptionEntry, BeforeLlmHookDeps> = {
  source: SUBSCRIPTION_NOTICE_SCOPE,
  resolveTarget(input: string, ctx: FileResolveContext): TargetResolution {
    const canonical = canonicalPath(resolveInput(ctx.config, input.trim()));
    if (evaluatePath(canonical, ctx.boundary) !== 'allow') {
      return { ok: false, error: 'boundary' };
    }
    return { ok: true, key: canonical, target: canonical };
  },
  async detect(entry, deps) {
    const observed = await observeEntry(entry, deps);
    if (observed === undefined) return undefined;
    return { rev: observed.rev, material: observed };
  },
  cursor: { kind: 'content-hash', sentinels: ['deleted'] },
  format(changes: readonly string[], _budget: NoticeBudget): NoticePayload {
    return {
      scope: SUBSCRIPTION_NOTICE_SCOPE,
      content: formatSubscriptionNotice(changes, changes.length),
    };
  },
  delivery: 'ambient',
};

/** health 源 facade：纯委托 observeHealthEntry / formatHealthNotice。 */
export const healthSource: SourceModule<SubscriptionEntry, BeforeLlmHookDeps> = {
  source: HEALTH_NOTICE_SCOPE,
  resolveTarget(input: string): TargetResolution {
    const target = input.trim();
    if (!isValidHealthTarget(target)) return { ok: false, error: 'invalid_target' };
    return { ok: true, key: healthSubscriptionKey(target), target };
  },
  async detect(entry, deps) {
    const observed = await observeHealthEntry(entry, deps);
    if (observed === undefined) return undefined;
    return { rev: observed.rev, material: observed };
  },
  cursor: { kind: 'signature', sentinels: ['', 'down'] },
  format(changes: readonly string[], _budget: NoticeBudget): NoticePayload {
    return { scope: HEALTH_NOTICE_SCOPE, content: formatHealthNotice(changes, changes.length) };
  },
  delivery: 'ambient',
};

/** script 源 facade：纯委托 processScriptEntry / formatScriptNotice。 */
export const scriptSource: SourceModule<SubscriptionEntry, ScriptDetectContext, ScriptNoticeEntry> =
  {
    source: SCRIPT_NOTICE_SCOPE,
    resolveTarget(input: string): TargetResolution {
      const name = input.trim();
      if (!isValidScriptName(name)) return { ok: false, error: 'invalid_name' };
      return { ok: true, key: scriptSubscriptionKey(name), target: name };
    },
    async detect(entry, ctx) {
      const outcome: ScriptProcessOutcome = processScriptEntry(
        entry,
        ctx.spec,
        ctx.runner,
        ctx.sessionId,
        ctx.config,
        ctx.now,
        ctx.kickoffDue,
      );
      return { rev: outcome.entry.rev, material: outcome };
    },
    cursor: { kind: 'stdout-hash', sentinels: ['empty'] },
    format(changes: readonly ScriptNoticeEntry[], _budget: NoticeBudget): NoticePayload {
      const scope = changes[0]?.scope ?? SCRIPT_NOTICE_SCOPE;
      return { scope, content: formatScriptNotice(changes, changes.length, scope) };
    },
    delivery: 'ambient',
  };

/**
 * 装配期断言（模块加载即跑，非测试形态）：facade 契约不变量。
 * 违反即 throw —— 装配失败可见，不静默降级。
 */
for (const mod of [fileSource, healthSource, scriptSource]) {
  if (mod.delivery !== 'ambient') {
    throw new Error(`source-module invariant: ${mod.source} must be ambient in P1`);
  }
  if (
    typeof mod.resolveTarget !== 'function' ||
    typeof mod.detect !== 'function' ||
    typeof mod.format !== 'function'
  ) {
    throw new Error(`source-module invariant: ${mod.source} missing contract methods`);
  }
}
