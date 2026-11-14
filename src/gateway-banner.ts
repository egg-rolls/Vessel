/**
 * Gateway 启动 banner（纯 console 排版）。
 *
 * 两层呈现（0.51）：
 * - **人类终端**（stdout 是 TTY、允许 ANSI、非 `--json`）→ box 面板；
 * - **其它一切**（管道 / 重定向 / daemon 子进程 / `--json` / `NO_COLOR` / `TERM=dumb`）
 *   → 一行纯文本，不带框线。
 *
 * 判定唯一入口是 `wantsBoxBanner`；子进程 stdout 被重定向到
 * `<dataDir>/logs/*.log`，因此日志文件里不会再出现 ASCII 框线。
 *
 * 安全约束：不打印任何 token（含前缀），也不在 URL 中拼接 token。
 *
 * @module vessel/gateway-banner
 */

import { isLoopbackHostname } from '../packages/config/src/index';
import type { Gateway } from '../packages/serve/src/index';
import { shouldUseColor, ui } from './ui-style';

/** banner 呈现判定输入（测试注入；缺省读进程状态与环境） */
export interface BannerDisplayOptions {
  /** 覆盖 TTY 检测；缺省 `process.stdout.isTTY === true` */
  isTTY?: boolean;
  /** 机器可读输出（`--json` / `--quiet`）：不打 box，只留一行 */
  machine?: boolean;
  env?: Record<string, string | undefined>;
}

/**
 * 是否人类终端：`stdout` 是 TTY 且不是机器可读输出。
 *
 * daemon / `gateway start` 平台进程 spawn 的 node / hub 子进程 stdout 都指向日志文件，
 * 这里天然判 false。
 */
export function isHumanTerminal(options: BannerDisplayOptions = {}): boolean {
  if (options.machine === true) return false;
  return options.isTTY ?? process.stdout.isTTY === true;
}

/**
 * box 只在人类终端且允许 ANSI 时画；`NO_COLOR` / `TERM=dumb` 与 `ui` 同口径降级成一行。
 */
export function wantsBoxBanner(options: BannerDisplayOptions = {}): boolean {
  if (!isHumanTerminal(options)) return false;
  return shouldUseColor({
    ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
}

/** 估算字符串在终端的显示宽度（宽字符按 2 列计） */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x2190 && code <= 0x21ff) ||
      (code >= 0x2300 && code <= 0x27bf);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右补空格 */
function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * 用 ─/│ 边框绘制标题面板（纯 console 排版，不引入 Ink）。
 * `lines` 已按 `inner` 补齐（含 ANSI），这里不再二次计算宽度。
 */
function boxPanel(title: string, lines: string[], inner: number): string {
  const rule = '─'.repeat(inner + 2);
  const top = `${ui.brand('┌')}${ui.brand(rule)}${ui.brand('┐')}`;
  const titleRow = `${ui.brand('│')} ${ui.title(padDisplay(title, inner))} ${ui.brand('│')}`;
  const sep = `${ui.brand('├')}${ui.brand(rule)}${ui.brand('┤')}`;
  const body = lines.map((l) => `${ui.brand('│')} ${l} ${ui.brand('│')}`).join('\n');
  const bottom = `${ui.brand('└')}${ui.brand(rule)}${ui.brand('┘')}`;
  return [top, titleRow, sep, body, bottom].join('\n');
}

/** `gateway start` 前台摘要中的节点行。 */
export interface PlatformStartupNode {
  name: string;
  url: string;
  autoStart: boolean;
  /** handoff（0.52）：进程不是本平台 spawn 的，而是 adopt 来的既有 node。 */
  adopted?: boolean;
}

/** 本地 Hub 的启动结果：本次 spawn / adopt 已有实例 / 关闭 / 拉起失败。 */
export type PlatformStartupHub =
  | { state: 'auto-started' | 'adopted'; url: string }
  | { state: 'disabled' | 'unavailable' };

/** `gateway start` 前台摘要输入（字段全部来自运行态，不打印 token）。 */
export interface PlatformStartupInfo {
  version: string;
  platformUrl: string;
  nodes: PlatformStartupNode[];
  hub: PlatformStartupHub;
  /** 从进程启动到摘要输出经过的毫秒数。 */
  readyMs: number;
  /** 已本地化的 Ctrl+C 提示；缺省不输出。 */
  stopHint?: string;
}

function platformHubValue(hub: PlatformStartupHub): string {
  if (hub.state === 'auto-started' || hub.state === 'adopted') {
    return `${hub.url} (${hub.state})`;
  }
  return hub.state;
}

/**
 * `gateway start` 前台 Vite 风格启动摘要（0.50）。
 *
 * 纯文本、无边框、无 alt-screen；URL 可直接复制。token 只给来源提示，不打印值。
 * 是否打这一份由调用方的 `isHumanTerminal()` 决定（非 TTY 走逐行日志口径）；
 * box 版 `renderGatewayBanner` 只在 `wantsBoxBanner()` 为真时由 cli.ts 调用。
 */
export function renderPlatformStartup(info: PlatformStartupInfo): string {
  const rows: Array<[string, string]> = [
    ['Platform', info.platformUrl],
    ...info.nodes.map((node, index): [string, string] => [
      index === 0 ? 'Node' : '',
      `${node.url} (${node.name})${node.autoStart ? '' : '  (auto_start: false)'}` +
        `${node.adopted === true ? '  (adopted)' : ''}`,
    ]),
    ['Hub', platformHubValue(info.hub)],
    ['Web', info.platformUrl],
    ['Token', 'see serve.token / VESSEL_GATEWAY_TOKEN'],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = [`${ui.title('Vessel Gateway')} ${info.version}`];
  for (const [label, value] of rows) {
    lines.push(`${ui.dim(label.padEnd(labelWidth))}  ${value}`);
  }
  lines.push(ui.ok(`ready in ${info.readyMs} ms`));
  if (info.stopHint !== undefined) lines.push('', ui.dim(info.stopHint));
  return lines.join('\n');
}

/** `--serve` 启动 banner：仅展示 gateway 地址与 token 占位 */
export function renderGatewayBanner(gateway: Gateway): string {
  const rows: Array<[string, string]> = [
    ['Gateway', gateway.url],
    ['Token', '***  ← 见 serve.token / serve.admin_token / VESSEL_GATEWAY_TOKEN'],
  ];
  if (gateway.tls) rows.push(['TLS', 'on']);
  if (!isLoopbackHostname(new URL(gateway.url).hostname)) {
    rows.push(['Remote', 'listening beyond loopback (allow_remote)']);
  }
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const hint = '👉 启动 Web 控制台：打开 Gateway 地址并粘贴 Token（值不在此处打印）';
  const plainLines = rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
  plainLines.push('', hint);
  const inner = Math.max(displayWidth('Vessel Gateway') + 2, ...plainLines.map(displayWidth));
  const padTo = (text: string): string => ' '.repeat(Math.max(0, inner - displayWidth(text)));
  const lines = rows.map(([label, value]) => {
    const labelPart = label.padEnd(labelWidth);
    const valuePart = `  ${value}`;
    return `${ui.brand(labelPart)}${valuePart}${padTo(labelPart + valuePart)}`;
  });
  lines.push(padTo(''), ui.dim(hint) + padTo(hint));
  return boxPanel('Vessel Gateway', lines, inner);
}

/**
 * 非人类终端 / `--json` / `NO_COLOR` 的降级呈现：一行纯文本，无框线、无 ANSI。
 *
 * 例：`Vessel Gateway 0.50.0 · http://127.0.0.1:8644`。token 仍不打印。
 */
export function renderGatewayBannerOneLine(gateway: Gateway, version?: string): string {
  const head =
    version !== undefined && version !== '' ? `Vessel Gateway ${version}` : 'Vessel Gateway';
  return `${head} · ${gateway.url}`;
}
