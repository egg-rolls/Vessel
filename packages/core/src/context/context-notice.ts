/**
 * 上下文类 env 卡的文案（0.52 V2）。
 *
 * 与 `pii/notice.ts` 同一套路：core 直接写出一张 `vessel:notice` 尾消息（追加，不改历史），
 * 正文首行是 `scope: summary`，明细行以 `  · ` 开头。作用域词 `context` 的定义是
 * 「系统提示词 / Self Card / 上下文本身变了」，见 `packages/agent/src/env-info-scope.ts`。
 * 本文件也产出 scope `tools` 的卡（tools-body-snapshot：请求 tools[] 是会话起点快照，
 * 中途工具面变化只追加卡）——线格式是 agent `formatEnvInfo` 的**字面量副本**，
 * 对拍义务见 `renderToolSurfaceNotice` 的注释（core 不能 import agent，依赖方向反了）。
 *
 * 语言：模型侧默认 en，UI 侧按用户语言渲染同一份文案。
 *
 * 为什么不带 provider 原文：超限错误正文里可能带一段请求片段，卡是模型与用户都能看到的
 * 消息，宁可不带；原始错误照旧走日志与 `llm.*` 事件。
 */
export type ContextNoticeLocale = 'en' | 'zh-CN';

/** 明细行前缀；与 `packages/agent` 的 env 卡保持同一格式（core 侧字面量复用）。 */
const DETAIL_MARK = '  · ';

/**
 * 系统提示词 / 工具表 / 模型变了时的环境信息卡（0.52 R6）。
 *
 * 以前这条路径靠 `PrefixChangeReason` 里的 `system_revision` / `tools_changed` /
 * `model_changed` 直接放行守卫 —— 于是前缀改写变成静默的（守卫看到 reason 什么都不发）。
 * 用户裁定这些变化**都不开新会话**，所以这里改成一张卡把变化讲清楚，守卫照旧报警。
 */
export function renderSystemRevisionNotice(locale: ContextNoticeLocale = 'en'): string {
  if (locale === 'zh-CN') {
    return [
      'context：这次请求的系统提示词 / 工具集 / 模型变了；会话没有重建',
      DETAIL_MARK + '本次 run 用新的基底继续，历史消息一条没动',
      DETAIL_MARK + '这不是你预期的变化时：检查模型 / 工具配置，或另开会话重新开始',
    ].join('\n');
  }
  return [
    'context: the system prompt / tool set / model behind this request changed; the session was not recreated',
    DETAIL_MARK + 'this run continues on the new base, no history message was rewritten',
    DETAIL_MARK +
      'if that change is unintended, check the model / tool configuration or start a new session',
  ].join('\n');
}

/**
 * run 内上下文撑爆时的「超限」卡。
 *
 * 这张卡存在的意义就是**不许静默改写历史**：run 内不压缩、不删中段、不插摘要，只把
 * 发生了什么与下一步在哪发生讲清楚，然后本次 Run 以 provider 的原始错误收尾。压缩留给
 * 下一个段起点（`new(compaction)` 开新段）。
 */
export function renderContextOverflowNotice(locale: ContextNoticeLocale = 'en'): string {
  if (locale === 'zh-CN') {
    return [
      'context：这一步还没跑完，上下文就满了；历史没有被就地改写',
      DETAIL_MARK + '下一步：本次 run 在此收尾，下一次 run 从压缩后的 seed 开新段',
      DETAIL_MARK + '本次 run 后续不再发请求（不删中段、不插摘要）',
    ].join('\n');
  }
  return [
    'context: the context window filled up before this step finished; history was not rewritten',
    DETAIL_MARK +
      'next step: this run ends here, the next run starts a new segment from a compacted seed',
    DETAIL_MARK + 'no in-place trimming, no mid-history summary swap inside this run',
  ].join('\n');
}

/**
 * 发送前闸的「没发」卡（0.55 P0）。
 *
 * 与 `renderContextOverflowNotice` 的区别：那张卡说的是「provider 已经打回了」，
 * 这张说的是「我们算出来会超，所以**根本没发**」—— 请求没有出去，也就没有 HTTP 400，
 * 但用户必须知道这一轮为什么停在这里，以及下一轮会发生什么。所以两个数字都带上：
 * 估算值（下一次请求视图，已按锚点校正）与窗口上限。
 *
 * 两个数字都来自本地估算（不是 provider 回报）：卡里不写 "provider said"，避免把
 * 「我们的上界」说成「对方的判定」。精确到 token 的数只在这里出现一次，明细行不再重复。
 */
export function renderContextWindowExceededNotice(
  input: { used: number; max: number },
  locale: ContextNoticeLocale = 'en',
): string {
  const used = String(Math.round(input.used));
  const max = String(Math.round(input.max));
  const percent = input.max > 0 ? String(Math.round((input.used / input.max) * 100)) : '?';
  if (locale === 'zh-CN') {
    return [
      'context：下一次请求估算 ' + used + ' / ' + max + ' tokens（' + percent + '%），已达窗口上限',
      DETAIL_MARK + '本轮**没有**把这条请求发出去（发了只会被 provider 打回）',
      DETAIL_MARK + '下一步：本次 run 在此收尾；下一次 run 从段起点压缩后的 seed 继续',
      DETAIL_MARK + '若压缩后仍然超限：开新会话，或先 pop 掉那段巨型输出',
    ].join('\n');
  }
  return [
    'context: next request would be ' +
      used +
      ' / ' +
      max +
      ' tokens (' +
      percent +
      '%), at the window limit',
    DETAIL_MARK + 'this request was NOT sent (the provider would only reject it)',
    DETAIL_MARK + 'next step: this run ends here; the next run continues from a compacted seed',
    DETAIL_MARK +
      'if it is still over after compaction: start a new session or pop that huge output',
  ].join('\n');
}

/**
 * 明细行数上限。**字面量副本**：必须与 agent `ENV_INFO_DETAILS_MAX`（env-info-scope.ts）
 * 及 Web `ENV_NOTICE_DETAILS_MAX`（apps/web/src/domains/chat/env-notice.ts）相同（10）。
 */
const TOOL_SURFACE_DETAILS_MAX = 10;

/** 新增工具 description 的最大长度（D3：一句用法，压成一行；防脏数据撑爆行）。 */
const TOOL_DESCRIPTION_MAX = 80;

/** description → 行内文本：压成一行 + 裁长（同 model-change-notice `modelValueText` 的口径）。 */
function toolDescriptionText(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  return flat.length <= TOOL_DESCRIPTION_MAX ? flat : `${flat.slice(0, TOOL_DESCRIPTION_MAX)}…`;
}

/**
 * 工具面变更环境信息卡（tools-body-snapshot，唯一生产者 = core EU 的
 * `ExecutionUnit.appendToolSurfaceNotice`）。
 *
 * 请求 tools[] 是会话起点快照、会话内不变；中途宿主工具面增删只以本卡告知。
 * 首行摘要写清生效点（新会话 / 新 body 才进请求列表）；新增行带一句 description
 * 讲用法（≤80 字符，不带 inputSchema —— 参数靠 best-effort 调用 + 校验错误反馈）；
 * 移除行明说「调用会被拒绝」（执行侧 live getTool miss ⇒ tool_not_found，run 继续）。
 *
 * **对拍义务**（原 C3 对拍脚本已按宪法删除，改动本函数时人工核对，
 * 口径见 `docs/architecture/env-info-append-only.md`）：
 * - 首词 `tools` 必须在 agent `ENV_INFO_SCOPES` 与 Web `ENV_NOTICE_SCOPES` 里都认得
 *   （卡头标签走 i18n `chat.env.scope.tools`，en / zh-CN）；
 * - {@link DETAIL_MARK} 必须与 `ENV_INFO_DETAIL_MARK` 及 Web 明细标记逐字相同（两空格 + `·`）；
 * - {@link TOOL_SURFACE_DETAILS_MAX} 行收口 + 「and N more」与 `formatEnvInfo` 同形。
 *
 * 文案 en（模型侧默认，与 renderModelChangeNotice 一致）；名字集合由调用方排序，
 * 同一批变更永远拼出同一个字符串（去重的前提）。
 */
export function renderToolSurfaceNotice(
  added: readonly { name: string; description?: string }[],
  removed: readonly string[],
): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`${String(added.length)} added`);
  if (removed.length > 0) parts.push(`${String(removed.length)} removed`);
  const head =
    `tools: ${parts.join(', ')}; ` +
    'the request tool list is a session-start snapshot and stays fixed until a new session/body';
  const details = [
    ...added.map((tool) => {
      const description =
        tool.description !== undefined && tool.description.trim() !== ''
          ? ` — ${toolDescriptionText(tool.description)}`
          : '';
      return `+ ${tool.name}${description}`;
    }),
    ...removed.map((name) => `- ${name} (removed; calls will be rejected)`),
  ];
  const kept = details.slice(0, TOOL_SURFACE_DETAILS_MAX);
  const dropped = details.length - kept.length;
  const lines = kept.map((detail) => `${DETAIL_MARK}${detail}`);
  if (dropped > 0) lines.push(`${DETAIL_MARK}and ${String(dropped)} more`);
  return [head, ...lines].join('\n');
}
