/** Team create / edit 表单的纯函数：字段归一化与 policy JSON 解析。 */

export interface PolicyParseResult {
  ok: boolean;
  value?: Record<string, unknown>;
}

/** 空串 → undefined；用于创建时的可选字段。 */
export function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** nullable 字段：改动才返回；清空 → null。 */
export function nullableChange(
  value: string,
  initial: string,
): { changed: boolean; value: string | null } {
  const trimmed = value.trim();
  if (trimmed === initial.trim()) return { changed: false, value: null };
  return { changed: true, value: trimmed === '' ? null : trimmed };
}

/**
 * 解析 policy 文本：空文本 = 不发送；否则必须是 JSON 对象
 * （数组 / null / 标量都拒绝，与 canonical 校验一致）。
 */
export function parsePolicyText(text: string): PolicyParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** 回填 policy textarea：没有 policy 时显示 `{}`。 */
export function policyText(policy: Record<string, unknown> | undefined): string {
  return policy ? JSON.stringify(policy, null, 2) : '{}';
}
