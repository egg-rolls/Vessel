/**
 * 工具名的**唯一真源**：snake_case 规则 + 改名别名表 + 装配期审计。
 *
 * 三条口径（见 `docs/architecture/tools.md` 「命名规则」）：
 *
 * 1. **内置 / 插件工具名必须是 `^[a-z][a-z0-9_]*$`**（snake_case，≤64 字符）。
 *    provider 那条 `[a-zA-Z0-9_-]{1,64}` 只是下限，不是目标：驼峰 `piiReveal` 虽然能被
 *    provider 收下，但模型先验、MCP 生态、大小写不敏感的文件系统 / 环境、`grep` 全都不友好
 *    （`webSearch` 与 `web_search` 是两种拼法，搜一个漏一个）。
 * 2. **MCP 等外部来源的工具名原样透传**，不转换、不改写：名字是外部系统的，我们只保证
 *    「不合规也要**可见**」——同样过校验，但只报 warning，不阻断装配。
 * 3. **改名必须带别名**（一版），别名命中时把弃用提示回给模型，不静默。
 *    别名解析只有这一处（`MemoryPluginHost`），禁止每个工具各写一份 if。
 *
 * 为什么放在 runtime 而不是各插件：注册表是工具名进入系统的**唯一入口**
 * （`MemoryPluginHost.registerTool`），校验和别名只有落在这里才管得住新增工具。
 *
 * @module @vessel-agent/core/runtime
 */

import type { PluginHost } from '../types/plugin.js';
import type {
  ToolNameAlias,
  ToolNameAudit,
  ToolNameEntry,
  ToolNameViolation,
} from '../types/tool-name.js';

export type { ToolNameAlias, ToolNameAudit, ToolNameEntry, ToolNameViolation };

/**
 * 工具名的合法形态（唯一判据）。
 *
 * - 首字符必须是字母：数字开头在不少 schema 校验器里会被当成非法标识符；
 * - 只允许小写字母 / 数字 / 下划线：连字符（`-`）provider 允许但 MCP 清洗层会替换，
 *   大小写在大小写不敏感的环境里会撞名，点号会让**整个请求** 400。
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** 规则的正则源码（错误文案里直接贴它，别让人去翻代码） */
export const TOOL_NAME_RULE = '^[a-z][a-z0-9_]*$';

/** 工具名长度上限（provider 的硬约束） */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Provider 对工具名的硬约束（OpenAI 兼容接口与 Anthropic 都是这个形状）。
 *
 * 工具名原样进 `tools[].function.name`；带 `.` 等字符会让**整个请求** 400
 * （不是调用时才失败）。snake_case 是它的**子集**，但仍要单独校验长度：
 * `^[a-z][a-z0-9_]*$` 本身不限长。
 */
export const PROVIDER_SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 一条改名别名：旧名 → 现行名 + 弃用提示。
 *
 * 形状定义在 `types/tool-name.ts`（`types/**` 不放实现），这里 re-export。
 */

/**
 * 改名别名表（**单一真源**：注册表解析、配置层换算都从这里读）。
 *
 * 只登记「确实存在过的旧名」，一律精确匹配；**禁止**前缀 / 大小写归一 /
 * 点号-下划线互换之类的模糊换算 —— 那等于允许任意别名，会把注册期的名字校验废掉。
 */
export const TOOL_NAME_ALIASES: readonly ToolNameAlias[] = [
  {
    alias: 'piiReveal',
    target: 'pii_reveal',
    notice:
      'piiReveal 已重命名为 pii_reveal（0.55 起工具名统一 snake_case）；旧名保留一版，下一版移除，请改用 pii_reveal。',
    removeIn: '0.56',
  },
  {
    alias: 'pii.reveal',
    target: 'pii_reveal',
    notice:
      'pii.reveal 已重命名为 pii_reveal（0.52 去掉点号，0.55 统一 snake_case）；旧名保留一版，下一版移除，请改用 pii_reveal。',
    removeIn: '0.56',
  },
  {
    alias: 'ask_user',
    target: 'ask',
    notice: 'ask_user 已重命名为 ask；旧名保留一版，下一版移除，请改用 ask。',
    removeIn: '0.56',
  },
];

/** 按旧名查别名条目（精确匹配；查不到返回 undefined） */
export function findToolNameAlias(name: string): ToolNameAlias | undefined {
  return TOOL_NAME_ALIASES.find((entry) => entry.alias === name);
}

/** 旧名 → 现行名；不是旧名就原样返回（**不做**二次换算） */
export function resolveToolNameAlias(name: string): string {
  return findToolNameAlias(name)?.target ?? name;
}

/**
 * 驼峰 → 下划线（只处理大小写边界，不动其它字符）。
 *
 * `piiReveal` → `pii_reveal`；`HTTPThing` → `http_thing`；`mcp__s__t` 不变。
 */
function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
}

/**
 * 给一个不合规的工具名算**自动建议**（用于错误 / 告警文案里的「怎么改」）。
 *
 * `webSearch` → `web_search`；`some.external.Tool` → `some_external_tool`。
 * 只是建议：改名必须由人决定（并要把旧名登记进 `TOOL_NAME_ALIASES`）。
 */
export function suggestToolName(name: string): string {
  let suggestion = camelToSnake(name)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toLowerCase()
    .replace(/^_+/, '');
  // 首字符必须是字母：空串 / 数字开头时补一个可读前缀，别产出 `_2fa` 这种还是不合法的建议。
  if (!/^[a-z]/.test(suggestion)) suggestion = `tool_${suggestion}`;
  if (suggestion.length > MAX_TOOL_NAME_LENGTH) {
    suggestion = suggestion.slice(0, MAX_TOOL_NAME_LENGTH);
  }
  return suggestion;
}

/** 名字是否合规（长度 + 正则） */
export function isToolNameLegal(name: string): boolean {
  return name.length <= MAX_TOOL_NAME_LENGTH && TOOL_NAME_PATTERN.test(name);
}

/**
 * 不合规时返回**可直接贴进错误文案**的说明（含「怎么改」）；合规返回 undefined。
 *
 * @param name 工具名
 * @param options.external 外部来源（MCP 等）：文案换成「原样透传」，不催改名
 */
export function describeToolNameProblem(
  name: string,
  options: { external?: boolean; source?: string } = {},
): string | undefined {
  if (isToolNameLegal(name)) return undefined;
  const suggestion = suggestToolName(name);
  const rule =
    `不合规：必须匹配 ${TOOL_NAME_RULE}（snake_case：小写字母 / 数字 / 下划线，` +
    `字母开头，≤${MAX_TOOL_NAME_LENGTH} 字符）`;
  if (options.external === true) {
    const source = options.source ?? 'MCP / 插件外部通道';
    return (
      `外部工具名（${source}）"${name}" ${rule}。这个名字由外部系统决定，我们**原样透传、不改写**` +
      `（可在对方配置里改成 "${suggestion}"）；这里只保证它**可见**——装配日志里会列出。` +
      '规则见 docs/architecture/tools.md 「命名规则」。'
    );
  }
  return (
    `工具名 "${name}" ${rule}。请改成 "${suggestion}"` +
    '（改后把旧名登记进 TOOL_NAME_ALIASES，至少保留一版别名）；' +
    '规则见 docs/architecture/tools.md 「命名规则」。'
  );
}

/** 审计一批工具名：内置违规阻断，外部违规只 warning。纯函数，便于装配期与工具面复用。 */
export function auditToolNames(entries: readonly ToolNameEntry[]): ToolNameAudit {
  const violations: ToolNameViolation[] = [];
  const warnings: ToolNameViolation[] = [];
  for (const entry of entries) {
    const message = describeToolNameProblem(entry.name, {
      ...(entry.external !== undefined ? { external: entry.external } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
    });
    if (message === undefined) continue;
    const violation: ToolNameViolation = {
      name: entry.name,
      external: entry.external === true,
      suggestion: suggestToolName(entry.name),
      message,
    };
    if (entry.external === true) warnings.push(violation);
    else violations.push(violation);
  }
  const message =
    violations.length === 0
      ? ''
      : [
          `工具名不合规（${violations.length} 项）—— 装配失败，原因：工具名原样进 provider 的 ` +
            'tools[].function.name，不合规会让**整个请求**被拒，所以宁可在装配期炸。',
          ...violations.map(
            (violation) => `  - "${violation.name}" → 建议 "${violation.suggestion}"`,
          ),
          '改名时必须把旧名登记进 packages/core/src/runtime/tool-name.ts 的 TOOL_NAME_ALIASES（保留一版别名）。',
        ].join('\n');
  return { ok: violations.length === 0, violations, warnings, message };
}

/**
 * 装配期断言：宿主上的工具名必须全部 snake_case。
 *
 * 内置 / 插件工具违规 ⇒ **抛错并列出全部违规项**（不是等模型调用时才炸）；
 * 外部（MCP）工具违规 ⇒ 进 `warnings`，由装配方写日志 —— 名字我们管不了，但必须可见。
 *
 * @param host 已装配完成的工具宿主
 * @param label 出错时定位装配点的标签（例如 `bootstrap.final`）
 * @throws ToolNameAudit 失败时抛出 Error，message 已含全部违规项与建议
 */
export function assertToolNameLegality(host: PluginHost, label = 'tool assembly'): ToolNameAudit {
  const audit =
    typeof host.auditToolNames === 'function'
      ? host.auditToolNames()
      : auditToolNames(host.listTools().map((tool) => ({ name: tool.name })));
  if (!audit.ok) {
    throw new Error(`[${label}] ${audit.message}`);
  }
  return audit;
}
