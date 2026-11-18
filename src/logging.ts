/**
 * CLI / serve 的诊断日志装配（0.10 R2-14）。
 *
 * 规则：
 * - 日志只写 stderr；stdout 保留给命令结果 / JSON / UX 输出。
 * - 级别 / 格式 / 脱敏统一由 core 进程级日志中枢（log-hub）控制：
 *   `VESSEL_DEBUG` / `VESSEL_LOG_LEVEL` / `VESSEL_LOG_JSON` 在中枢加载时生效；
 *   config `observability.log` 经 `configureLogging` 热应用（P4 接入）。
 * - 返回 core 的 `Logger` 端口（中枢薄封装，阈值实时读取，构造后不固定）。
 *
 * @module vessel/logging
 */

import { createStderrLogger, type Logger } from '../packages/core/src/index';

/**
 * 创建 CLI / serve 共用的 stderr logger。
 * 环境变量覆盖由中枢在模块加载时读取；config 覆盖经 configureLogging 注入。
 */
export function createCliLogger(): Logger {
  return createStderrLogger();
}
