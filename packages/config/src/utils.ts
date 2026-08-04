/**
 * 配置工具函数
 * @module @vessel/config
 */

/**
 * 深合并两个对象
 * - 对象类型：递归合并
 * - 数组类型：直接替换（不合并）
 * - 基本类型：直接替换
 * - undefined 值：不覆盖
 *
 * @param base 基础对象
 * @param override 覆盖对象
 * @returns 合并后的新对象
 */
export function deepMerge<T extends Record<string, unknown>, U extends Record<string, unknown>>(
  base: T,
  override: U,
): T & U {
  const result = { ...base } as T & U;

  for (const key of Object.keys(override)) {
    const overrideValue = override[key as keyof U];

    // 跳过 undefined 值
    if (overrideValue === undefined) {
      continue;
    }

    const baseValue = base[key as keyof T];

    // 如果两个值都是对象（非数组），递归合并
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      (result as Record<string, unknown>)[key] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>,
      );
    } else {
      // 否则直接替换（包括数组、基本类型、null 等）
      (result as Record<string, unknown>)[key] = overrideValue;
    }
  }

  return result;
}

/**
 * 判断一个值是否为纯对象（非数组、非 null）
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
