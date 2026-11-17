/**
 * 配置层工具名兼容换算（表驱动，单一真源在 core）。
 *
 * 用户 YAML 的 `permission.auto_approve` / `never_auto_approve` 里可能仍写着**已改名**的工具
 * 旧名。注册侧只认现行名（见 docs/architecture/tools.md「命名规则」），选择侧不换算
 * ⇒ 用户当年选的 always / never **静默失效**：不报错、只是规则不生效（L-011 同一个形状）。
 *
 * 0.55 起表的真源搬到 core：`packages/core/src/runtime/tool-name.ts` 的
 * `TOOL_NAME_ALIASES`。为什么搬：同一张表要供**两处**使用 ——
 * 1. **注册表**（`MemoryPluginHost.getTool`）：模型调用旧名时要能解析到现行工具，
 *    并在结果里附一行弃用提示（不静默）；
 * 2. **配置层**（本模块）：`autoApprove` / `neverAutoApprove` 里的旧名要换算成现行名。
 *
 * 两处各存一份表就是第二份真源，改一处漏一处；所以本模块只做**适配**
 * （Record 视图 + 函数名保持兼容），不再自己登记别名。
 *
 * 三条硬口径不变：
 * 1. **只登记「确实存在过的旧名」**，一律精确匹配（表查找），**禁止**前缀 / 大小写归一 /
 *    点号与下划线互换之类的模糊换算 —— 那等于允许任意别名，把注册期的名字校验废掉。
 * 2. 表的值必须是**现行、真实存在**的工具名。
 * 3. 只有「改过名」的工具才进表；新增工具不需要在这里登记。
 *
 * @module vessel/legacy-tool-names
 */

import { resolveToolNameAlias, TOOL_NAME_ALIASES } from '@vessel-agent/core';

/**
 * 旧名 → 现行名（精确映射）。
 *
 * 由 core 的 `TOOL_NAME_ALIASES` 派生，**不在这里新增条目**：
 * - `ask_user` → `ask`：0.52 前 `ask` 工具叫 `ask_user`；
 * - `pii.reveal` → `pii_reveal`：点号会让 provider 400 拒掉**整个请求**（0.52 去掉点号）；
 * - `piiReveal` → `pii_reveal`：0.55 工具名统一 snake_case。
 */
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(TOOL_NAME_ALIASES.map((entry) => [entry.alias, entry.target])),
);

/**
 * 把配置里的工具名换算成现行名。
 *
 * 未登记的（含已在用新名的）**原样返回**，且绝不二次换算：用户也可能在
 * `auto_approve` 里写插件 / MCP 工具名，那不在本表的职责范围。
 */
export function normalizeLegacyToolName(name: string): string {
  return resolveToolNameAlias(name);
}
