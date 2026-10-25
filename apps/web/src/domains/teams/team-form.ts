/** Team create / edit 表单的纯函数：字段归一化。 */

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
