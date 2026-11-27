/**
 * 权限缺省规则的**单一真源**（q-arch-p0-fixes perm-F1）。
 *
 * 事故形状：`never_auto_approve` 的缺省名单曾在三处各写一份 ——
 * 成员 wiring（`src/runtime/bootstrap.ts`）是 `['agent.close', 'pii_reveal']`，
 * 而 `resolveRuntimePermission`（`src/runtime/tenant-runtime-factory.ts`）与
 * 持久化读侧（`src/data/permission-store.ts`）只有 `['agent.close']`。
 * 权限热应用（`replaceRules`）是**整体替换**：用户配置没有显式写
 * `never_auto_approve` 时，热应用从后两处取缺省 ⇒ 成员侧「PII 真值解锁永远人批」
 * 的默认保护被静默抹掉。三处引用本常量后，缺省名单只有一份，改一处即全局生效。
 *
 * 语义保持不变：**用户显式配置（含空数组）优先**，本常量只在键缺失时兜底。
 *
 * @module vessel/permission-defaults
 */

/**
 * 缺省强制人工审批（never auto-approve）的工具名单。
 *
 * - `agent.close`：关闭成员是不可逆操作，默认永远人批（0.27 配置级保险）。
 * - `pii_reveal`：PII 真值解锁**永远**要人批（0.52）。默认放行会让 reveal 因为
 *   拿不到审批 id 而永久拒绝，反而把「用户明确同意」这条路堵死；显式列入强制
 *   审批名单后语义才正确。名字必须与注册表一致（0.55 起统一 snake_case
 *   `pii_reveal`，见 `packages/core/src/pii/reveal.ts` 的 `PII_REVEAL_TOOL_NAME`）。
 */
export const DEFAULT_NEVER_AUTO_APPROVE: readonly string[] = ['agent.close', 'pii_reveal'];
