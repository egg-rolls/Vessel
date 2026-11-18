/**
 * 登录策略注册表：`kind` → 策略。**唯一**的 provider 清单。
 *
 * 加一个 provider = 加一个策略文件 + 在 `BUILT_IN_STRATEGIES` 里加一行。
 * 这里没有 `switch (kind)`、没有白名单数组：validator 只问注册表「这个 kind 存在吗、
 * 它的 allow_user_ids 长什么样」，因此永远不会再出现
 * 「`backends[1].kind must be one of: github_oauth, password`」这种
 * 「用户不知道还能写什么」的报错 —— 文案由注册表现算，列出的永远是当前真实支持的 kind。
 *
 * 运行期注册（`registerAuthStrategy`）是给测试 / 第三方用的：它证明「不改 validator
 * 也能多一个 kind」。生产路径不做动态注册。
 *
 * @module @vessel-agent/config/auth-strategies/registry
 */

import { GITEE_STRATEGY } from './gitee.js';
import { GITHUB_STRATEGY } from './github.js';
import { MICROSOFT_STRATEGY } from './microsoft.js';
import { PASSWORD_STRATEGY } from './password.js';
import { type AuthStrategy, PASSWORD_STRATEGY_KIND } from './types.js';

/**
 * 内置策略。**这就是那一行注册**：新 provider 只往这里加一个元素。
 *
 * 顺序 = `/auth/status` 与 `/auth/whoami` 里 `backends` 的稳定顺序。
 */
const BUILT_IN_STRATEGIES: readonly AuthStrategy[] = [
  GITHUB_STRATEGY,
  MICROSOFT_STRATEGY,
  GITEE_STRATEGY,
  PASSWORD_STRATEGY,
];

/** `auth.backends[].kind` 缺省值（0.56 P1 的写法：不写 kind 就是 GitHub）。 */
export const DEFAULT_AUTH_BACKEND_KIND = GITHUB_STRATEGY.kind;

const REGISTRY = new Map<string, AuthStrategy>();

function put(strategy: AuthStrategy, options: { replace: boolean }): void {
  const existing = REGISTRY.get(strategy.kind);
  if (existing !== undefined && existing !== strategy && !options.replace) {
    throw new Error(
      `auth strategy kind "${strategy.kind}" is already registered (ids: ${existing.id}, ${strategy.id})`,
    );
  }
  REGISTRY.set(strategy.kind, strategy);
}

for (const strategy of BUILT_IN_STRATEGIES) put(strategy, { replace: false });

/**
 * 运行期注册一个策略（测试 / 第三方扩展）。重复 kind 抛错。
 *
 * 生产路径只用内置策略；这条通路存在的意义是证明「加 provider 不需要改校验器」。
 */
export function registerAuthStrategy(strategy: AuthStrategy): void {
  put(strategy, { replace: false });
}

/** 测试用：把注册表恢复到「只有内置策略」。 */
export function resetAuthStrategies(): void {
  REGISTRY.clear();
  for (const strategy of BUILT_IN_STRATEGIES) put(strategy, { replace: false });
}

/** 按 kind 取策略；`undefined` = 配置没写 kind（用缺省策略）。未知 kind 返回 null。 */
export function getAuthStrategy(kind: string | undefined): AuthStrategy | null {
  if (kind === undefined) return REGISTRY.get(DEFAULT_AUTH_BACKEND_KIND) ?? null;
  return REGISTRY.get(kind) ?? null;
}

/** 已注册的策略（注册顺序）。 */
export function authStrategies(): AuthStrategy[] {
  return [...REGISTRY.values()];
}

/** 已注册的 kind。 */
export function registeredAuthKinds(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * 报错文案用的「已注册 kind + 人类可读名」清单，例如
 * `github_oauth (GitHub), gitee_oauth (Gitee), microsoft_oauth (Microsoft), password (口令)`。
 */
export function describeRegisteredAuthKinds(): string {
  return authStrategies()
    .map((strategy) => `${strategy.kind} (${strategy.label})`)
    .join(', ');
}

/**
 * 该 kind 是否属于「有 302 授权跳转」的后端。
 *
 * 只有口令后端不需要公网来源白名单（它不需要 `redirect_uri`）；新的 OAuth provider
 * 默认都需要 —— 缺省应该是安全的那一侧。
 */
export function requiresPublicOrigin(kind: string): boolean {
  return kind !== PASSWORD_STRATEGY_KIND;
}

/** 有授权跳转的策略（口令之后剩下的那些），用于路由匹配。 */
export function redirectAuthStrategies(): AuthStrategy[] {
  return authStrategies().filter((strategy) => requiresPublicOrigin(strategy.kind));
}
