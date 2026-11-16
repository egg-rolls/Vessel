/**
 * 0.55 P0：平台监听的 fail-closed 守卫。
 *
 * 背景：反代与平台同机时客户端对端恒为 `127.0.0.1`，回环＝本机这个前提已经不成立。
 * 平台一旦绑到非回环地址又没有 platform token，任何能连上这个端口的人都能读平台面，
 * 并通过 `platform.nodes.credentials` 取 node token。所以：**非回环 + 无 token ⇒ 拒绝启动**
 * （与 node / hub 既有的非回环守卫对齐）。回环监听不受影响：端口只在本机可达。
 *
 * @module @vessel-agent/serve
 */

import { isLoopbackHostname } from '../gateway/auth.js';

/** 守卫文档位置（错误信息里直接给出）。 */
export const PLATFORM_LISTEN_GUARD_DOC = 'docs/operations/REVERSE-PROXY.md';

/** 监听地址是否只在本机可达。空 / 未定义按非回环处理（fail-closed）。 */
export function isLoopbackListen(hostname: string | undefined): boolean {
  if (typeof hostname !== 'string') return false;
  const trimmed = hostname.trim();
  if (trimmed === '') return false;
  return isLoopbackHostname(trimmed);
}

/**
 * 平台监听的安全判定。
 *
 * @returns 拒绝原因（多行、可直接照做）；`null` = 放行。
 */
export function platformListenGuard(input: {
  hostname: string | undefined;
  port?: number;
  platformToken: string | undefined;
}): string | null {
  if (isLoopbackListen(input.hostname)) return null;
  if (input.platformToken !== undefined && input.platformToken !== '') return null;
  const host =
    input.hostname === undefined || input.hostname.trim() === ''
      ? '0.0.0.0'
      : input.hostname.trim();
  const where =
    input.port === undefined || input.port === 0 ? host : `${host}:${String(input.port)}`;
  return [
    'platform_listen_insecure: 拒绝在非回环地址上启动平台 —— 没配 platform token。',
    `  listen  ${where}`,
    '  为什么：这个地址不在本机内部，谁都能 POST /platform/rpc，读平台面并取走 node token。',
    '',
    '两种修法，任选其一后重启：',
    '',
    '  1) 平台只监听回环（同机反代的标准形态；反代在本机转发进来）：',
    '       # config.yaml',
    '       gateway:',
    '         hostname: 127.0.0.1',
    '',
    '  2) 配一个 platform token（只走环境变量，别把令牌写进 YAML）：',
    '       export VESSEL_PLATFORM_TOKEN=$(openssl rand -hex 32)',
    '       # config.yaml',
    '       gateway:',
    '         token_env: VESSEL_PLATFORM_TOKEN',
    '     然后用令牌的**值**（不是变量名）打开页面：',
    `       http://${where}/#token=<上面生成的值>`,
    '     已经配了 gateway.token_env 却起不来：确认该变量在**服务进程**里非空（systemd 的',
    '     Environment= / env_file 要生效；只在一个终端里 export 只影响那个终端）。',
    '',
    '注意：platform token 必须与 node token 不同（同值会被 checkPlatformTokenConflict 拦下）。',
    `细节与迁移清单：${PLATFORM_LISTEN_GUARD_DOC}`,
  ].join('\n');
}
