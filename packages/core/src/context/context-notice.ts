/**
 * 上下文类 env 卡的文案（0.52 V2）。
 *
 * 与 `pii/notice.ts` 同一套路：core 直接写出一张 `vessel:notice` 尾消息（追加，不改历史），
 * 正文首行是 `scope: summary`，明细行以 `  · ` 开头。作用域词 `context` 的定义是
 * 「系统提示词 / Self Card / 上下文本身变了」，见 `packages/agent/src/env-info-scope.ts`。
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
    DETAIL_MARK + 'if that change is unintended, check the model / tool configuration or start a new session',
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
    DETAIL_MARK + 'next step: this run ends here, the next run starts a new segment from a compacted seed',
    DETAIL_MARK + 'no in-place trimming, no mid-history summary swap inside this run',
  ].join('\n');
}
