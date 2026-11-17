/**
 * 工具名规则的**纯类型**（0.55，snake_case）。
 *
 * `types/**` 不放实现：常量与函数在 `runtime/tool-name.ts`，这里只有形状。
 * 为什么要把它们抽出来：`PluginHost` 接口（`types/plugin.ts`）要引用
 * `auditToolNames()` / `getToolAlias()` 的返回类型，而 `types/**` 不得反向依赖实现模块。
 *
 * @module @vessel-agent/core/types
 */

/**
 * 一条改名别名：旧名 → 现行名 + 弃用提示。
 *
 * `removeIn` 是计划移除的版本，只用于生成提示文案（不做自动过期判断——
 * 过期靠人删表，自动过期会让「什么时候断的」变得不可见）。
 */
export interface ToolNameAlias {
  /** 旧名（模型 / 配置里可能仍在用的那个） */
  alias: string;
  /** 现行名（必须真实存在，由审计核对） */
  target: string;
  /** 命中别名时回给模型的一行提示（不静默的关键） */
  notice: string;
  /** 计划移除的版本号 */
  removeIn: string;
}

/** 一条待审计的工具名（注册表或任何装配期名单） */
export interface ToolNameEntry {
  name: string;
  /** 外部来源（MCP / 第三方插件通道）：不合规只 warning，不阻断 */
  external?: boolean;
  /** 外部来源的可读标识（例如 `mcp:<server>`），只进文案 */
  source?: string;
}

/** 一条违规 / 一条外部告警的结构化形状（日志与错误文案同源） */
export interface ToolNameViolation {
  name: string;
  external: boolean;
  /** 自动算出的 snake_case 建议名 */
  suggestion: string;
  /** 完整的说明句（含建议与「怎么改」） */
  message: string;
}

/** 一次装配期审计的结果 */
export interface ToolNameAudit {
  /** 无阻断级违规（外部工具的不合规不算阻断） */
  ok: boolean;
  /** 阻断级：内置 / 插件工具名不合规 */
  violations: ToolNameViolation[];
  /** 非阻断级：外部工具名不合规（原样透传，但要在装配日志里可见） */
  warnings: ToolNameViolation[];
  /** 违规汇总文案（`ok === true` 时为空串） */
  message: string;
}
