/**
 * 配置来源脱敏（DECISION-020 §R1.1）。
 *
 * `config.get` / `config.sources` 会返回 asm 注入的 sources 映射；键里可能带有
 * `serve.tokens.<真实 token>.tenantId`，任何 read token 都能据此反推 admin token。
 * 返回前必须把 token 段替换为 `<set>`（多个 token 依次 `<set#2>`…），
 * 并把 `serve.tokens.*` / `*.apiKey` / `*.token` 的来源值一并收敛为 `<set>`。
 *
 * TODO(0.10 merge): `packages/config` 的 `redactSourcePaths` 合入后删除本实现，
 * 改为从 `@vessel/config` 复用同一导出（asm 是冻结契约的 owner）。
 *
 * @module @vessel/serve/gateway
 */

/** 敏感来源叶子：`*.apiKey` / `*.token` 的来源值不再暴露（只表示“已设置”）。 */
const SENSITIVE_SOURCE_LEAF = /(?:^|\.)(?:apiKey|token)$/;

/**
 * 脱敏来源映射；不修改入参。
 *
 * - `serve.tokens.<token>.*`：token 段替换为 `<set>` / `<set#N>`，来源值 → `<set>`；
 * - `*.apiKey` / `*.token`：来源值 → `<set>`；
 * - 其它路径与来源原样返回。
 */
export function redactSourcePaths<T extends string>(
  sources: Record<string, T>,
): Record<string, string> {
  const tokenMasks = new Map<string, string>();
  const out: Record<string, string> = {};

  for (const [path, source] of Object.entries(sources)) {
    const segments = path.split('.');
    const isServeTokens = segments[0] === 'serve' && segments[1] === 'tokens';
    let redactedPath = path;

    if (isServeTokens && segments.length >= 3) {
      const token = segments[2] ?? '';
      let mask = tokenMasks.get(token);
      if (mask === undefined) {
        mask = tokenMasks.size === 0 ? '<set>' : `<set#${tokenMasks.size + 1}>`;
        tokenMasks.set(token, mask);
      }
      segments[2] = mask;
      redactedPath = segments.join('.');
    }

    const sensitive = isServeTokens || SENSITIVE_SOURCE_LEAF.test(path);
    out[redactedPath] = sensitive ? '<set>' : source;
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactServeTokens(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const entries = Object.values(value);
  const out: Record<string, unknown> = {};
  entries.forEach((entry, index) => {
    const key = entries.length === 1 ? '<set>' : `<set#${index + 1}>`;
    out[key] = isRecord(entry) ? { ...entry } : {};
  });
  return out;
}

function redactConfigNode(node: unknown, path: string[]): unknown {
  if (Array.isArray(node)) return node.map((item) => redactConfigNode(item, path));
  if (!isRecord(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const fullPath = [...path, key];
    const atServeTokens =
      fullPath.length >= 2 &&
      fullPath[fullPath.length - 2] === 'serve' &&
      fullPath[fullPath.length - 1] === 'tokens';
    out[key] = atServeTokens ? redactServeTokens(value) : redactConfigNode(value, fullPath);
  }
  return out;
}

/**
 * `config.get` 的防御性脱敏：即使注入方忘了先跑 asm 的 `redactConfig`，
 * 也不把 `serve.tokens` 的真实 token 键返回给 read principal。
 * 只处理 `serve.tokens`；其余密钥字段仍由 asm `redactConfig` 负责。
 *
 * TODO(0.10 merge): 与 `redactSourcePaths` 一起改为复用 `@vessel/config`。
 */
export function redactConfigServeTokens<T>(config: T): T {
  return redactConfigNode(config, []) as T;
}
