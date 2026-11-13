/**
 * ask 选项的勾选语义 —— 纯函数，零 import。
 *
 * 用户 2026-11-13 报的直觉问题：**单选的选项点下去之后没法取消**，只能改选另一个，
 * 想回到「这题先不答」只能清空输入框。而 ask 本来是允许留空的（未答的行不进载荷、
 * 也不标已答，见 `isAskDraftAnswered`），所以「取消勾选」在语义上是合法的，只是 UI 缺了。
 *
 * 三个调用点（会话的逐题卡、团队/对话里的待批卡、待批页）共用这一个判定 + 一个组件
 * （`AskOptionChips`），所以改一次三处都生效 —— 这也是用户要求的「复用」。
 */
export function toggleAskOption(
  picks: readonly string[],
  option: string,
  multi: boolean,
): string[] {
  if (multi) {
    const next = new Set(picks);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    return [...next];
  }
  // 单选：再点一次已选中的项 = 取消选择（回到未答），不是「保持不变」。
  return picks.includes(option) ? [] : [option];
}
