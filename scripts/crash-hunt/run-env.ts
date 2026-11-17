/**
 * 带环境变量起子进程（**Windows 侧**的 bun）。
 *
 * 为什么需要它：从 WSL 里 `FOO=bar bun ...` 是**不生效**的 —— 环境变量属于 POSIX 侧，
 * 而 `bun` 是 `cmd.exe` 转发的 Windows 进程，它看到的是 Windows 的进程环境。实测：
 *
 *   FOO=bar bun -e 'console.log(process.env.FOO)'   →  undefined
 *
 * 所以本仓所有「环境变量开关」（`VESSEL_CRC32_NATIVE` / `VESSEL_PROXY_HTTP_STREAM` /
 * `VESSEL_RESOURCE_SAMPLE_MS` …）在 WSL 里只能通过这个入口设置：它用 `Bun.spawn` 显式
 * 传 `env`，跨进程边界不再依赖 shell。
 *
 * 用法：
 *   bun scripts/crash-hunt/run-env.ts VESSEL_CRC32_NATIVE=1 -- bun scripts/crash-hunt/probe-crc32.ts
 */

const separator = process.argv.indexOf('--');
if (separator === -1) {
  console.error(
    'usage: bun scripts/crash-hunt/run-env.ts KEY=VALUE [KEY=VALUE...] -- <command...>',
  );
  process.exit(2);
}

const pairs = process.argv.slice(2, separator);
const command = process.argv.slice(separator + 1);
if (command.length === 0) {
  console.error('no command after --');
  process.exit(2);
}

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
for (const pair of pairs) {
  const equals = pair.indexOf('=');
  if (equals <= 0) {
    console.error(`not KEY=VALUE: ${pair}`);
    process.exit(2);
  }
  env[pair.slice(0, equals)] = pair.slice(equals + 1);
}

// `bun` 在 Windows 上是个 .cmd 包装；直接用当前可执行文件（bun.exe）才不会被 shell 改写参数。
const exe = process.execPath;
const args = command[0] === 'bun' ? [exe, ...command.slice(1)] : command;
if (args[0] !== exe) {
  // 不是 bun 命令：交给系统解析（cmd / powershell 探针等）。
  console.error(`only bun commands are supported here, got: ${command[0]}`);
  process.exit(2);
}

const child = Bun.spawn(args, { env, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
const code = await child.exited;
process.exit(code);

export {};
