/**
 * 配置层工具名兼容换算（表驱动，单一真源）。
 *
 * 用户 YAML 的 `permission.auto_approve` / `never_auto_approve` 里可能仍写着**已改名**的工具
 * 旧名。注册侧只认现行名（见 docs/dev/handoff/tool-name-legality.md §5），选择侧不换算
 * ⇒ 用户当年选的 always / never **静默失效**：不报错、只是规则不生效（L-011 同一个形状）。
 *
 * 三条硬口径：
 * 1. **只登记「确实存在过的旧名」**，一律精确匹配（表查找），**禁止**前缀 / 大小写归一 /
 *    点号与下划线互换之类的模糊换算 —— 那等于允许任意别名，把注册期的名字校验废掉。
 * 2. 表的值必须是**现行、真实存在**的工具名：由 `scripts/check-tool-name-aliases.ts` 对着
 *    真实工具注册表核对（探针不复制这张表，直接 import 本模块，避免第二份真源）。
 * 3. 只有「改过名」的工具才进表；新增工具不需要在这里登记。
 *
 * @module vessel/legacy-tool-names
 */

/**
 * 旧名 → 现行名（精确映射）。
 *
 * - `ask_user` → `ask`：0.52 前 `ask` 工具叫 `ask_user`；
 * - `pii.reveal` → `piiReveal`：点号会让 provider 400 拒掉**整个请求**，0.52 改名
 *   （见 `docs/dev/handoff/tool-name-legality.md` §3）。
 */
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  ask_user: 'ask',
  'pii.reveal': 'piiReveal',
};

/**
 * 把配置里的工具名换算成现行名。
 *
 * 未登记的（含已在用新名的）**原样返回**，且绝不二次换算：用户也可能在
 * `auto_approve` 里写插件 / MCP 工具名，那不在本表的职责范围。
 */
export function normalizeLegacyToolName(name: string): string {
  if (!Object.hasOwn(LEGACY_TOOL_NAME_ALIASES, name)) return name;
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name;
}
