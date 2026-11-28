/**
 * CLI flag 取值校验纯函数（cli-single-source P1 · S2 自 args.ts 移居）。
 *
 * 设计 §2.3 / §5.3：自定义校验器保留为 schema（FLAG_DEFS.value.parse /
 * spec.validate）引用的纯函数。移居到此轻模块使 command-spec.ts 静态闭包
 * 不触达 args.ts 重闭包（help 早退零 IO，S4 §2.3）。args.ts 改为 import
 * 本模块（W2 删除 args.ts 重复声明前的兼容口径），行为逐字不变。
 *
 * @module vessel/cli-parse-validators
 */

// ── 端口 ─────────────────────────────────────────

// 0 是合法值：由系统分配（team loopback 节点推荐）
const MIN_PORT = 0;
const MAX_PORT = 65535;

/** 解析十进制端口；非法返回 null */
export function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  if (port < MIN_PORT || port > MAX_PORT) return null;
  return port;
}

// ── 时长 ─────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * `--older-than`：`<n><ms|s|m|h|d>`（裸数字按天）；非法返回 null。
 *
 * 单位写法照 `--timeout <dur>` 的既有形态（`parseTimeoutMs`）；但**不复用**它：
 * 它的上限是 24h，表达不了「30 天」，而且裸数字按秒 —— 这里裸数字按**天**，
 * 对齐 RPC `trace.prune` 的 `older_than_days` 与 `trace.retention_days` 的口径
 * （也偏保守：阈值更大 ⇒ 删得更少）。
 *
 * 0.51 起这个值只是 `vessel prune` 的**可选叠加**条件（比的是归档 / 停用时刻），
 * 不传就完全不看时间。
 */
export function parseOlderThanMs(raw: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? '', 10);
  // 0 = 删光全部（不是「不限」）：这种取值太容易误伤，一律当非法。
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] ?? 'd';
  const factor =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : DAY_MS;
  return amount * factor;
}

const MAX_STOP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** `--timeout <dur>`：ms/s/m（缺省 s）；100ms ≤ 值 ≤ 24h。 */
export function parseTimeoutMs(raw: string): number | null {
  const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2] ?? 's';
  const ms = unit === 'ms' ? amount : unit === 's' ? amount * 1000 : amount * 60_000;
  if (ms < 100 || ms > MAX_STOP_TIMEOUT_MS) return null;
  return ms;
}

// ── 名称 / scope ─────────────────────────────────

/** gateway 实例名（与 gateway/pid 的校验一致；解析层只做语法） */
const GATEWAY_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function parseInstanceName(raw: string): string | null {
  return GATEWAY_INSTANCE_RE.test(raw) ? raw : null;
}

const RELOAD_SCOPE_RE = /^[a-z][a-z0-9_-]*$/;

/** 逗号分隔的 reload scope；非法返回 null */
export function parseReloadScopes(raw: string): string[] | null {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  return parts.every((part) => RELOAD_SCOPE_RE.test(part)) ? parts : null;
}
// ── attention / hub 命令级校验器（S2 自 args.ts 移居；spec 引用） ──

/** attention 分页上限（与 `interactions.list` 的 limit 上界一致）。 */
export const ATTENTION_MAX_LIMIT = 500;

/** attention `--limit`：1..500。 */
export function parseAttentionLimit(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value >= 1 && value <= ATTENTION_MAX_LIMIT ? value : null;
}

/** 逗号分隔正整数；去重；空 / 0 / 非数字 → null。 */
export function parseAttentionSelect(raw: string): number[] | null {
  const parts = raw.split(',');
  const seen = new Set<number>();
  const selected: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value < 1) return null;
    if (seen.has(value)) continue;
    seen.add(value);
    selected.push(value);
  }
  return selected;
}

/** hub `--ttl`：范围可配（join-code / pair-code 60..3600）。 */
export function parseHubTtl(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

export const HUB_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** hub `--token-env / --code-env / --value-env / --api-key-env`：环境变量名语法。 */
export function parseHubEnvName(
  raw: string,
  flag: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!HUB_ENV_NAME_RE.test(raw)) {
    return { ok: false, error: `Invalid ${flag}: expected an environment variable name` };
  }
  return { ok: true, value: raw };
}

// ── plugin 名称 ──────────────────────────────────

const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** plugin 名称语法（与 plugin-command 同口径；解析层只做语法）。 */
export function parsePluginName(raw: string): string | null {
  return PLUGIN_NAME_RE.test(raw) ? raw : null;
}

// ── 入口常量 ─────────────────────────────────────

/** `--serve` 省略端口时的默认值 */
export const DEFAULT_SERVE_PORT = 8642;
