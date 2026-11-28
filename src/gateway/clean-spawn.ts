/**
 * R-5（q-restart-tool）：Windows 干净父系 spawn + 僵尸端口诊断/清理。
 *
 * 根因（docs/dev/reports/probe-node-hang-report.md，scratch 实证）：**Windows
 * Bun 1.3.9 的 Bun.spawn 子进程无条件继承父进程监听 socket handle**（stdio 全
 * ignore 也继承）。node 内 detached spawn 的编排者继承 node 监听端口 → 编排者
 * spawn 的新 gateway daemon 继续持有 → node 正常退出后端口仍 LISTENING（backlog
 * 无人 accept）→ 代理全超时「hung」；netstat 归属已死 node pid 是诊断陷阱。
 *
 * 修复①：Windows 下编排者经 **WMI Win32_Process.Create** 创建（父系为 WMI 服务，
 * 非 node）——scratch 实验 4 验证 parent 退出端口立即释放。stdio 落日志经
 * `cmd.exe /d /s /c "… >> log 2>&1"` 包装（WMI Create 无 stdio 重定向能力）；
 * 记录的 pid 是 cmd 包装进程（与编排者同生命周期，taskkill /T 语义一致）。
 * WMI 不可用 → 告警并回退旧 Bun.spawn detached。回退路的僵尸风险已由
 * socket-inherit-guard 在句柄级根治（监听 socket 创建即清 HANDLE_FLAG_INHERIT，
 * 任何 spawn 路径都不可继承）；R-3 健康闸仍是兜底。
 * POSIX 无此问题，保留 Bun.spawn detached。
 *
 * 修复③：port_in_use 附 netstat 持有者 pid（含死 pid 归属陷阱提示）；编排者
 * start 前预检——持有者若是**本编排者后代**（本重启链孤儿）则定点 taskkill /T /F；
 * 死 pid 归属不盲杀（健康 daemon 的父进程天然已死，「父死」不是孤儿判据）。
 *
 * @module vessel/clean-spawn
 */

import { open } from 'node:fs/promises';
import path from 'node:path';
import { isProcessAlive } from './pid';

export interface CleanSpawnOptions {
  argv: string[];
  /** stdout/stderr 追加落盘路径（目录须已存在）。 */
  logPath: string;
  env: Record<string, string | undefined>;
  cwd?: string;
  /**
   * 显式 spawn 注入 = 测试/手工控制路径：直走 Bun.spawn detached 语义，
   * 不经 WMI（注入者完全掌控子进程形状）。缺省 Bun.spawn。
   */
  spawn?: typeof Bun.spawn;
  /** WMI 失败回退时的告警通道（缺省静默回退）。 */
  warn?: (message: string) => void;
}

export interface CleanSpawnResult {
  pid: number;
  via: 'wmi' | 'bun-detached';
}

/** 旧路径：Bun.spawn detached + stdio 落日志 fd（POSIX 主路径 / Windows 回退）。 */
async function spawnBunDetached(opts: CleanSpawnOptions): Promise<CleanSpawnResult> {
  const spawn = opts.spawn ?? Bun.spawn;
  const handle = await open(opts.logPath, 'a', 0o600);
  try {
    const proc = spawn(opts.argv, {
      stdin: 'ignore',
      stdout: handle.fd,
      stderr: handle.fd,
      detached: true,
      windowsHide: true,
      env: opts.env,
    });
    proc.unref();
    return { pid: proc.pid, via: 'bun-detached' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** cmd.exe 包装命令行：env set 前缀 + 引号化 argv + 日志重定向。 */
function buildWindowsCommandLine(opts: CleanSpawnOptions): string {
  // WMI 服务 env 不含调用者会话变量：显式传播 VESSEL_* 与用户目录变量。
  // 含双引号/换行的值无法安全嵌入 `set "K=V"`，跳过（罕见）。
  const propagate = Object.entries(opts.env).filter(
    ([key, value]) =>
      typeof value === 'string' &&
      !value.includes('"') &&
      !/[\r\n]/.test(value) &&
      (key.startsWith('VESSEL_') ||
        key === 'USERPROFILE' ||
        key === 'HOME' ||
        key === 'APPDATA' ||
        key === 'LOCALAPPDATA'),
  );
  const sets = propagate.map(([key, value]) => `set "${key}=${value}" && `).join('');
  const quoted = opts.argv.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ');
  const inner = `${sets}${quoted} >> "${opts.logPath}" 2>&1`;
  // /d 禁 AutoRun；/s 剥外层引号后原样执行内层（嵌套引号安全）。
  return `cmd.exe /d /s /c "${inner}"`;
}

/** PowerShell 单引号字符串转义（' → ''）。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellPath(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 干净父系 detached spawn（R-5①）。Windows 经 WMI Win32_Process.Create；
 * 失败告警回退 Bun.spawn detached；POSIX / 显式 spawn 注入直走 detached。
 */
export async function spawnDetachedClean(opts: CleanSpawnOptions): Promise<CleanSpawnResult> {
  if (process.platform !== 'win32' || opts.spawn !== undefined) {
    return spawnBunDetached(opts);
  }
  const commandLine = buildWindowsCommandLine(opts);
  const cwd = opts.cwd ?? process.cwd();
  const script =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)}; CurrentDirectory = ${psQuote(cwd)} }; ` +
    "if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine('Win32_Process.Create ReturnValue=' + $r.ReturnValue); exit 1 }; " +
    'Write-Output $r.ProcessId';
  try {
    const proc = Bun.spawn(
      [powershellPath(), '-NoProfile', '-NonInteractive', '-Command', script],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true, env: process.env },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`powershell exit ${exitCode}: ${stderr.trim()}`);
    }
    const pid = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error(`WMI returned no process id: ${stdout.trim()}`);
    }
    return { pid, via: 'wmi' };
  } catch (error) {
    opts.warn?.(
      `WMI clean-parent spawn unavailable (${error instanceof Error ? error.message : String(error)}); ` +
        'falling back to Bun.spawn detached — listening sockets are guarded non-inheritable at creation ' +
        '(socket-inherit-guard, R-5); residual zombie risk is covered by the R-3 health gate',
    );
    return spawnBunDetached(opts);
  }
}

/**
 * R-5③：netstat -ano 解析端口 LISTENING 持有者 pid（Windows；其它平台返回 []）。
 * 注意归属可能是**已死的创建者 pid**（继承 socket 陷阱），调用方须自行判活。
 */
export async function findPortHoldersWindows(
  port: number,
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  try {
    const proc = spawn(['netstat', '-ano', '-p', 'TCP'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const holders = new Set<number>();
    for (const line of text.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      // TCP  0.0.0.0:8654  0.0.0.0:0  LISTENING  12345
      if (parts.length < 5) continue;
      const local = parts[1] ?? '';
      const suffix = `:${port}`;
      if (!local.endsWith(suffix)) continue;
      const pid = Number.parseInt(parts[parts.length - 1] ?? '', 10);
      if (Number.isFinite(pid) && pid > 0) holders.add(pid);
    }
    return [...holders];
  } catch {
    return [];
  }
}

/**
 * R-5③：pid 是否为 ancestor 的后代（Windows，WMI ParentProcessId 上溯，
 * 深度上限 8；pid 复用风险由调用方的「本重启链」语境约束）。非 Windows 恒 false。
 */
export async function isDescendantOfWindows(
  pid: number,
  ancestor: number,
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<boolean> {
  if (process.platform !== 'win32' || pid === ancestor) return false;
  const script =
    `$p = ${pid}; for ($i = 0; $i -lt 8; $i++) { ` +
    `$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; ` +
    'if ($null -eq $proc) { break }; ' +
    `if ($proc.ParentProcessId -eq ${ancestor}) { Write-Output 'yes'; exit 0 }; ` +
    '$p = $proc.ParentProcessId }; ' +
    "Write-Output 'no'";
  try {
    const proc = spawn([powershellPath(), '-NoProfile', '-NonInteractive', '-Command', script], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsHide: true,
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim() === 'yes';
  } catch {
    return false;
  }
}

/**
 * R-5③：编排者 start 前预检——目标端口持有者若是本编排者后代（本重启链孤儿）
 * 则定点 taskkill /T /F 整树清理；死 pid 归属只告警不盲杀。
 */
export async function cleanupChainOrphansWindows(opts: {
  ports: number[];
  selfPid: number;
  spawn?: typeof Bun.spawn;
  print: (line: string) => void;
}): Promise<void> {
  if (process.platform !== 'win32') return;
  const spawn = opts.spawn ?? Bun.spawn;
  for (const port of opts.ports) {
    const holders = await findPortHoldersWindows(port, spawn);
    for (const holder of holders) {
      if (!isProcessAlive(holder)) {
        opts.print(
          `port ${port}: netstat attributes pid ${holder} (DEAD) — inherited-socket trap; ` +
            'the real holder is a live descendant. Not killing blindly (R-5).',
        );
        continue;
      }
      if (!(await isDescendantOfWindows(holder, opts.selfPid, spawn))) continue;
      opts.print(
        `port ${port}: holder pid ${holder} is an orphan of this restart chain — taskkill /T /F`,
      );
      try {
        const kill = spawn(['taskkill', '/PID', String(holder), '/T', '/F'], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
          windowsHide: true,
        });
        await kill.exited;
      } catch {
        // 清理失败不阻断 start（R-3 bind 重试/健康闸兜底）。
      }
    }
  }
}
