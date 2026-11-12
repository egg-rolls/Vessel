/**
 * Self Card 增量告知（0.52）：基础信息改了，**不重建 body、不热替换 Self Card**，
 * 而是在该成员的下一轮 BeforeLlm 追加一条 `vessel:notice` 环境信息，说清楚
 * 「你 Self Card 里的那一行现在是什么」。
 *
 * 为什么不热替换（用户裁决，2026-02）：
 * - Self Card 是 system 前缀的一部分（CONTRACT-prefix-invariant）：`selfCard` /
 *   `systemPrompt` / `model` 在 `ExecutionUnit` 构造期赋值、之后只读。改它要么破坏只读
 *   契约、要么每轮让整段历史缓存失效；两者都比「多一条尾消息」贵得多。
 * - 各字段的**真实生效点本来就不一样**：改名 / 改 Team / 改 parent 立即生效（花名册、
 *   地址、权限档位），改 model / system prompt 要等下一具 body。把这件事如实说出来，
 *   比假装卡没变有用 —— 模型据此知道该信哪一半。
 *
 * 不新造事件、不新造通道：这条尾消息与 `runtime-notice-hook` / `refs-notice-hook` 是
 * 同一条（`role: 'user'` + `name: 'vessel:notice'`），Web 由 `env-notice.ts` 渲成环境
 * 信息卡（scope `selfcard`）。不写 system、不新增事件类型、不进 `RunOptions.messages`。
 *
 * 去重口径（与 `refs-notice-hook` 同一族）：记住「模型现在相信的值」，注入一次就把它推进
 * 到当前值；下一轮 diff 为空 ⇒ 不再注入。所以**同一变更只报一次**，而回滚（A→B→A）因为
 * 与「相信的值」不同、照样会报 —— 只按 spawn 快照去重的话，回滚会被静默吞掉。
 *
 * 一处已知边界：本模块只覆盖**成员**（`MemberExecutionHost` 的 body）。owner 的
 * Self Card 由 `src/tenant-runtime-factory.ts` 构造，不经这条通道。
 *
 * @module @vessel-agent/agent
 */

import type { Hook, HookType, Message } from '@vessel-agent/core';
import type { MemberExecutionPermissionMode } from './runtime.js';
import type { MemberExecutionMember } from './types.js';

/**
 * `HookType.BeforeLlm` 的字面值（`packages/core/src/types/hook.ts`）。
 *
 * 为什么不用 `HookType.BeforeLlm`：本模块要保持**零运行时依赖**，`src/self-card-delta.test.ts`
 * 才能在任何一份 checkout 里直接 `bun run`（与 `refs-notice-hook.test.ts` 同口径；未装
 * node_modules 时 `@vessel-agent/core` 解析不到）。而 D5（`scripts/check-deps.ts`）禁止
 * 非 core 包相对 import core 内部，所以也不能走相对路径 —— 只剩「值取自字面量、类型由
 * 枚举兜住」这一条。上面的 `as HookType` 让拼错的值在 typecheck 里就报错。
 */
const BEFORE_LLM = 'before_llm' as HookType;

/** 注册名（同一具 body 的插件宿主上幂等注册用）。 */
export const SELF_CARD_DELTA_HOOK = 'self-card-delta';

/** 注入消息的 `name`：与其它环境信息同一条通道（Web 按它认 `notice`）。 */
export const SELF_CARD_DELTA_MESSAGE_NAME = 'vessel:notice';

/**
 * details 行的线格式前缀：两个空格 + `·`，**必须**与 `src/runtime-notice-hook.ts` 的
 * `NOTICE_DETAIL_MARK` 逐字相同 —— Web 的 `env-notice.ts` 按这个标记认「明细行」，标记
 * 对不上时整条消息会被读成一整行（明细挤进卡头的 single-line ellipsis，展开区空着）。
 * 两边分属 packages 与应用层，`packages/agent` 不能反向依赖 `src/`，所以这里重写一份；
 * `src/self-card-delta.test.ts` 断言两者相等，防止哪天单边改动。
 */
export const SELF_CARD_DELTA_DETAIL_MARK = '  · ';

/** 单个值在环境信息里的最大长度（名字 / model / team id 都很短，防脏数据把行撑爆）。 */
const VALUE_MAX = 60;

/**
 * Self Card 里会被「基础信息变更」作废的那几行。
 *
 * 不含 `depth` / `limits` / `context`：它们来自进程级配置（宿主选项），没有运行期改动
 * 路径；也不含 `tools`：工具面热刷新是另一条通道（`refreshTools`），不在本模块范围内。
 */
export type SelfCardField = 'name' | 'parent' | 'team' | 'model' | 'system_prompt' | 'permission';

/**
 * 固定顺序：diff 与文案都按这个顺序走。
 *
 * 顺序只影响「一条消息里几行的先后」，但必须**稳定**：同一批变更在任何一轮里都要拼出同一个
 * 字符串，否则去重与测试都会变成看运气。
 */
export const SELF_CARD_FIELDS: readonly SelfCardField[] = [
  'name',
  'parent',
  'team',
  'model',
  'system_prompt',
  'permission',
];

/**
 * 一份「Self Card 相关身份」快照。
 *
 * 只收 Self Card 真正渲染出来的行（外加决定 `how to ask for help` 的权限档），因为这条
 * 通道存在的唯一理由就是纠正那张卡；收多了就变成「环境信息里复述一遍成员记录」。
 */
export interface SelfCardIdentity {
  /** Self Card 的 `role:` 行装的是**成员名**（不是 `AgentRole`），见 `buildSelfCard`。 */
  readonly name?: string;
  readonly parent_id?: string;
  readonly team_id?: string;
  readonly model?: string;
  /** system prompt 正文只用来判「变没变」，**绝不**写进环境信息（可能上千字）。 */
  readonly system_prompt?: string;
  /** 决定工具面与 `how to ask for help` 的档位（`effectivePermissionMode` 的结果）。 */
  readonly permission_mode?: MemberExecutionPermissionMode;
}

/** diff 的一条：字段 + 旧值 + 新值（`undefined` = 那一行当时不存在 / 未设置）。 */
export interface SelfCardChange {
  readonly field: SelfCardField;
  readonly from?: string;
  readonly to?: string;
}

/**
 * 空串按「没有」处理：`team_id: ''` 与缺省都意味着 unbound，不能报成一次变更。
 *
 * `system_prompt` 也走这里判空（空串 = 没设置），但保留原文用于比较：首尾空白是用户写
 * 的内容，改了就该报。
 */
function normalizeOf(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `MemberExecutionMember`（+ 当前权限档）→ 身份快照。
 *
 * 权限档由调用方给：它是 `effectivePermissionMode(member)` 的结果，只有宿主知道
 * （Team 成员在 `forceBridgeForTeams` 下会被强制成 bridge，见 `buildSurface`）。
 */
export function selfCardIdentityOf(
  member: Pick<MemberExecutionMember, 'name' | 'parent_id' | 'team_id' | 'model' | 'system_prompt'>,
  permissionMode?: MemberExecutionPermissionMode,
): SelfCardIdentity {
  const name = normalizeOf(member.name);
  const parentId = normalizeOf(member.parent_id);
  const teamId = normalizeOf(member.team_id);
  const model = normalizeOf(member.model);
  const systemPrompt = member.system_prompt;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(parentId !== undefined ? { parent_id: parentId } : {}),
    ...(teamId !== undefined ? { team_id: teamId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(systemPrompt !== undefined && normalizeOf(systemPrompt) !== undefined
      ? { system_prompt: systemPrompt }
      : {}),
    ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
  };
}

/** 字段 → 快照里的值（唯一映射点：diff 从这里取，不许各写一份）。 */
function fieldValueOf(identity: SelfCardIdentity, field: SelfCardField): string | undefined {
  switch (field) {
    case 'name':
      return identity.name;
    case 'parent':
      return identity.parent_id;
    case 'team':
      return identity.team_id;
    case 'model':
      return identity.model;
    case 'system_prompt':
      return identity.system_prompt;
    case 'permission':
      return identity.permission_mode;
  }
}

/**
 * 「模型相信的值」→「这一轮的真值」，逐字段 diff（纯函数）。
 *
 * 只报**真的不同**的字段：没变更 / 字段没变都返回空数组，调用方据此完全不注入。
 */
export function diffSelfCardIdentity(
  reported: SelfCardIdentity,
  current: SelfCardIdentity,
): SelfCardChange[] {
  const changes: SelfCardChange[] = [];
  for (const field of SELF_CARD_FIELDS) {
    const from = fieldValueOf(reported, field);
    const to = fieldValueOf(current, field);
    if (from === to) continue;
    changes.push({
      field,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
  }
  return changes;
}

/** 字段 → 行内标签（前三个与 Self Card 的行名对齐，模型能直接对上是哪一行）。 */
const FIELD_LABELS: Readonly<Record<SelfCardField, string>> = {
  name: 'name',
  parent: 'parent',
  team: 'team',
  model: 'model',
  system_prompt: 'system prompt',
  permission: 'permission mode',
};

/**
 * 字段 → 「这件事到底生效到哪一步」。
 *
 * 全部来自实测（报告 0.51 §2.3–§2.5）：Self Card 与 EU 的 `model` / `systemPrompt` 都是
 * 构造期快照，改记录只影响**下一具 body**；而改名 / Team / parent 在花名册与地址里立即
 * 生效，只有模型看到的那张卡还停在旧值。写成一句真话，模型才不会拿旧 model 解释新行为。
 */
const FIELD_APPLIES: Readonly<Record<SelfCardField, string>> = {
  name: 'rename is already effective, but the `role:` line of your Self Card still shows the old name',
  parent: 'the `parent:` line of your Self Card is out of date',
  team: 'the `team:` line of your Self Card is out of date',
  model: 'this body keeps the old model; the next body uses the new one',
  system_prompt: 'this body keeps the old system prompt; the next body uses the new one',
  permission: 'this body keeps the old tool surface; the next body applies the new mode',
};

/** 值 → 行内文本：压成一行 + 裁长 + 空值占位（`(none)` 与 Web 卡的读感一致）。 */
function valueText(value: string | undefined): string {
  if (value === undefined) return '(none)';
  const flat = value.replace(/\s+/g, ' ');
  return flat.length <= VALUE_MAX ? flat : `${flat.slice(0, VALUE_MAX)}…`;
}

/** 一条 change → details 行（system prompt 只说「加了 / 去了 / 换了」，不贴正文）。 */
function changeLineOf(change: SelfCardChange): string {
  const applies = FIELD_APPLIES[change.field];
  if (change.field === 'system_prompt') {
    const verb =
      change.from === undefined ? 'added' : change.to === undefined ? 'removed' : 'replaced';
    return `${FIELD_LABELS.system_prompt}: ${verb} (${applies})`;
  }
  const from = valueText(change.from);
  const to = valueText(change.to);
  return `${FIELD_LABELS[change.field]}: ${from} → ${to} (${applies})`;
}

/**
 * 一批变更 → 一条环境信息正文（首行 summary + 每字段一行 details）。
 *
 * 真实形状（`\n` 是换行）：
 * ```
 * selfcard: 2 fields changed; the Self Card in your system prompt is out of date
 *   · name: human-2 → Minelog-main (rename is already effective, but the `role:` line of your Self Card still shows the old name)
 *   · model: volcengine/deepseek-flash → volcengine/deepseek-pro (this body keeps the old model; the next body uses the new one)
 * ```
 * 首行必须带 `selfcard` 这个 scope 词：Web 的 `env-notice.ts` 按**行首 token** 认 scope，
 * 认不出就落到兜底 `context`（内容照样能读，但卡头标签会变成「上下文」）。
 */
export function formatSelfCardDelta(changes: readonly SelfCardChange[]): string {
  const count = changes.length;
  const head =
    `selfcard: ${String(count)} field${count === 1 ? '' : 's'} changed; ` +
    'the Self Card in your system prompt is out of date';
  const details = changes.map((change) => `${SELF_CARD_DELTA_DETAIL_MARK}${changeLineOf(change)}`);
  return [head, ...details].join('\n');
}

export interface SelfCardDeltaHookOptions {
  /**
   * spawn 那一刻 Self Card 里的值：**模型现在看到的就是它**。
   *
   * 不用 registry 的当前值当起点（那是「事实」，不是「模型相信的东西」），否则改名发生在
   * spawn 之后、注册 hook 之前的那一版会被误判成「已经告过」。
   */
  baseline: SelfCardIdentity;
  /**
   * 这一轮的真值（每轮 BeforeLlm 现算一次）。
   *
   * 用函数而不是快照：基础信息由 `AgentService` 在 `agents.update` 时推进，权限档还要跟着
   * `effectivePermissionMode`（Team 成员被强制 bridge）走；快照在第二次变更后就过期。
   * 探针抛错按「这一轮不报」处理，绝不让一条提示拖垮一轮 LLM 请求。
   */
  current: () => SelfCardIdentity;
}

/**
 * 一具 body 的 Self Card 增量告知 hook（spawn 时注册，与 `createInboxNoticeHook` 同位）。
 *
 * 每个 hook 实例 = 一具 body：状态（`reported`）放在闭包里，rotate 换 body 就从新快照重新
 * 开始 —— 新 body 的 Self Card 本来就是重算的，旧 body 的记忆在这里既没用也会误导。
 */
export function createSelfCardDeltaHook(options: SelfCardDeltaHookOptions): Hook {
  /** 模型此刻相信的 Self Card 值（初始 = spawn 快照）；每注入一次就推进到当前值。 */
  let reported = options.baseline;
  return {
    name: SELF_CARD_DELTA_HOOK,
    type: BEFORE_LLM,
    async run(ctx): Promise<void> {
      let current: SelfCardIdentity;
      try {
        current = options.current();
      } catch {
        return;
      }
      const changes = diffSelfCardIdentity(reported, current);
      if (changes.length === 0) return;
      // 先推进再注入：同一批变更在**同一 run 的后续 LLM 请求**里（tool-calling loop 每轮都
      // 跑一次 BeforeLlm）也会被 diff 挡掉，不需要另存一份「已报签名」。
      reported = current;
      const message: Message = {
        role: 'user',
        name: SELF_CARD_DELTA_MESSAGE_NAME,
        content: formatSelfCardDelta(changes),
        timestamp: Date.now(),
      };
      ctx.messages = [...(ctx.messages ?? []), message];
    },
  };
}
