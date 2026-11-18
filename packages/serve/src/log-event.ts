/**
 * 运维事件日志入口（serve 侧）。
 *
 * P2 起**排版与级别控制都在 core**：
 * - 排版唯一来源：`@vessel-agent/core` 的 `log-format.ts`（EVENT_FIELDS 字段序、
 *   单行 key=value、json 逃生阀），这里 re-export 保持既有导入路径；
 * - 级别 / 脱敏 / 格式 / 时间：core 日志中枢（`log-hub.ts`），`logEvent` 只转发。
 *
 * 本文件保留 serve 领域的级别判定（`wsClosedLevel`）—— 那是「这条事件该用什么级别」
 * 的业务规则，不是排版，也不进中枢。
 *
 * 历史约束仍然成立（实现已搬入 core/log-format.ts）：
 * 1. **单行**：所有值压掉换行与连续空白，一行就是一条事件；
 * 2. **字段序固定**：顺序来自 EVENT_FIELDS 的事件定义，不跟对象字面量顺序走；
 * 3. **不丢信息**：定义表没写的字段照样追加输出，只省略空 / null / undefined / false；
 * 4. **机器可读逃生阀**：format=json（或 VESSEL_LOG_JSON=1）时退单行 JSON。
 *
 * @module @vessel-agent/serve/log-event
 */

import {
  type EventFieldKind,
  emitLogLine,
  formatEventFields,
  formatEventLine,
} from '@vessel-agent/core';

export { type EventFieldKind, formatEventFields, formatEventLine };

/**
 * `gateway.ws.closed` 的级别判定（node 侧与平台代理共用同一份规则）。
 *
 * 正常关闭（客户端发起的 1000/1001）= debug；异常（1006/1011，或服务端发起）= warn；
 * 其余码 = info。审计账**不折叠**（第十四条）：只改级别，不丢记录 —— 每条连接仍是一行。
 * `by` 兼容两侧口径：node 侧 `close_by`（client / server_*），代理侧 `who`
 * （downstream / upstream / platform）。
 */
export function wsClosedLevel(code: number, by: string): 'debug' | 'info' | 'warn' {
  if (by !== 'client' && by !== 'downstream') return 'warn';
  if (code === 1006 || code === 1011) return 'warn';
  if (code === 1000 || code === 1001) return 'debug';
  return 'info';
}

/**
 * 打一条事件日志（转发到 core 日志中枢）。
 *
 * 级别过滤 / 脱敏 / 排版统一在中枢：debug 缺省不输出，`VESSEL_DEBUG` /
 * `VESSEL_LOG_LEVEL` / config `observability.log` 控制（优先级见 log-hub 文件头）。
 */
export function logEvent(
  level: 'debug' | 'warn' | 'error' | 'info',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  emitLogLine(level, event, fields);
}
