/**
 * R-5 根治（q-spawn-inheritance-guard）：监听 socket 句柄防继承。
 *
 * 根因（生产取证 + 受控复现）：**Windows Bun 1.3.9 创建监听 socket 时带
 * HANDLE_FLAG_INHERIT=1**，而 Bun.spawn 走 CreateProcess(bInheritHandles=TRUE)
 * ——父进程一切可继承句柄（含监听 socket，stdio 全 ignore 也照传）无条件复制给
 * 子进程。父死后子进程僵尸持有端口 → 新代 bind EADDRINUSE（R-5 同型事故：
 * node 死 → gateway 继承 8644 → 新 node node_start_failed）。
 *
 * 根治：监听建立后立即清掉监听句柄的 HANDLE_FLAG_INHERIT —— 句柄级不可继承，
 * **任何** spawn 路径（spawnDaemon / node-supervisor / pool-supervisor /
 * spawnDetachedClean 的 WMI 失败回退，以及未来新增路径）都无法再继承监听 socket。
 * 不改任何 spawn 逻辑：pid/exitCode/kill/stdio 日志重定向语义零变化。
 *
 * 实证（Bun 1.3.9 win32 受控探针）：
 * - 对照：父 listen → detached spawn → 父退出 → 子 bind 同端口 EADDRINUSE（僵尸复现）。
 * - 防护：清标志后同流程 → 父退出端口立即释放，子 bind 成功；serve/fetch 功能不变。
 *
 * 句柄获取两条路：
 * - Bun.listen / node:net server：`server.fd` / `server._handle.fd` 在 win32 即
 *   原始内核 HANDLE（GetHandleInformation 实证），直接 SetHandleInformation。
 * - Bun.serve（无 fd 暴露）：NtQuerySystemInformation(SystemHandleInformationEx=64)
 *   枚举本进程句柄 + getsockname 按端口匹配。注意必须用 Ex（class 64）：经典
 *   SystemHandleInformation(16) 的 pid 字段是 USHORT，pid>65535 时截断漏配。
 *
 * POSIX：Bun 监听 fd 默认 FD_CLOEXEC=1（linux bun 1.3.9 实证），exec 不传非
 * stdio fd → 无需动作（no-op）。
 *
 * 失败口径：ffi 不可用/句柄操作失败一律静默降级（不阻断监听）；R-3 健康闸与
 * R-5③ 孤儿清理仍是兜底防线。
 *
 * @module vessel/socket-inherit-guard
 */

import { dlopen, FFIType, ptr, read } from 'bun:ffi';

/** HANDLE_FLAG_INHERIT（winbase.h）。 */
const HANDLE_FLAG_INHERIT = 1;
/** STATUS_INFO_LENGTH_MISMATCH (0xC0000004)，按 i32 返回为负值。 */
const STATUS_INFO_LENGTH_MISMATCH = -1073741820;
/** SystemHandleInformationEx：pid/handle 全宽（ULONG_PTR），经典 16 的 pid 是 USHORT 会截断。 */
const SYSTEM_HANDLE_INFORMATION_EX = 64;
/** Ex 布局：{ ULONG_PTR NumberOfHandles; ULONG_PTR Reserved; } 后每条目 40 字节。 */
const EX_HEADER_BYTES = 16;
const EX_ENTRY_BYTES = 40;
/** 条目内偏移：Object@0, UniqueProcessId@8, HandleValue@16。 */
const EX_PID_OFFSET = 8;
const EX_HANDLE_OFFSET = 16;
const AF_INET = 2;
/** Windows AF_INET6 = 23（Linux 是 10，此路仅 win32 走）。 */
const AF_INET6_WINDOWS = 23;
/** 枚举缓冲上限 256MB（实测全系统 ~18 万句柄 ≈ 7MB）。 */
const MAX_BUFFER_BYTES = 1 << 28;

interface Win32FFI {
  SetHandleInformation: (handle: number, mask: number, flags: number) => number;
  GetHandleInformation: (handle: number, flags: Uint32Array) => number;
  GetCurrentProcessId: () => number;
  NtQuerySystemInformation: (cls: number, buf: Uint8Array, size: number, ret: null) => number;
  getsockname: (handle: number, addr: Uint8Array, len: Int32Array) => number;
}

let cached: Win32FFI | null | undefined;

function loadWin32(): Win32FFI | null {
  if (cached !== undefined) return cached;
  try {
    const k32 = dlopen('kernel32.dll', {
      SetHandleInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
      GetHandleInformation: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetCurrentProcessId: { args: [], returns: FFIType.u32 },
    });
    const ntdll = dlopen('ntdll.dll', {
      NtQuerySystemInformation: {
        args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    const ws2 = dlopen('ws2_32.dll', {
      getsockname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    // bun 1.3.9 类型口径与运行时差异：FFIType.ptr 运行时接受 number（实证），
    // 类型却只列 bigint|TypedArray|Pointer（bigint 运行时反而抛错）——按实证口径转型。
    cached = {
      SetHandleInformation: k32.symbols
        .SetHandleInformation as unknown as Win32FFI['SetHandleInformation'],
      GetHandleInformation: k32.symbols
        .GetHandleInformation as unknown as Win32FFI['GetHandleInformation'],
      GetCurrentProcessId: k32.symbols.GetCurrentProcessId,
      NtQuerySystemInformation: ntdll.symbols
        .NtQuerySystemInformation as unknown as Win32FFI['NtQuerySystemInformation'],
      getsockname: ws2.symbols.getsockname as unknown as Win32FFI['getsockname'],
    };
  } catch {
    cached = null;
  }
  return cached ?? null;
}

/** 清句柄的 HANDLE_FLAG_INHERIT；成功返回 true。 */
function clearInheritFlag(ffi: Win32FFI, handle: number): boolean {
  return ffi.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) !== 0;
}

/** Bun.listen 的 `fd` / node:net server 的 `_handle.fd`（win32 即原始 HANDLE）。 */
function serverHandle(server: unknown): number | undefined {
  if (server === null || typeof server !== 'object') return undefined;
  const s = server as { fd?: unknown; _handle?: { fd?: unknown } | null };
  if (typeof s.fd === 'number' && Number.isInteger(s.fd) && s.fd >= 0) return s.fd;
  const handle = s._handle;
  if (handle && typeof handle.fd === 'number' && Number.isInteger(handle.fd) && handle.fd >= 0) {
    return handle.fd;
  }
  return undefined;
}

/**
 * Bun.serve 等无 fd 暴露的监听：枚举本进程句柄，getsockname 按本地端口匹配，
 * 命中的句柄全部清继承标志（监听 socket 及当下已 accept 的连接 socket——
 * 两者都不应被子进程继承）。
 */
function markByPortEnumeration(ffi: Win32FFI, port: number): void {
  const pid = ffi.GetCurrentProcessId();
  let size = 1 << 20;
  let buf = new Uint8Array(size);
  for (;;) {
    const status = ffi.NtQuerySystemInformation(SYSTEM_HANDLE_INFORMATION_EX, buf, size, null);
    if (status === 0) {
      const count = Number(read.u64(ptr(buf), 0));
      if (EX_HEADER_BYTES + count * EX_ENTRY_BYTES <= buf.length) break;
      // 快照在查询间隙增长：按实际条目数扩容重查。
      size = Math.max(size * 2, (EX_HEADER_BYTES + count * EX_ENTRY_BYTES) * 2);
    } else if (status === STATUS_INFO_LENGTH_MISMATCH) {
      size *= 2;
    } else {
      return;
    }
    if (size > MAX_BUFFER_BYTES) return;
    buf = new Uint8Array(size);
  }
  const count = Number(read.u64(ptr(buf), 0));
  // sockaddr_in6 最大 28 字节；端口在两种 sockaddr 里都是 offset 2 的大端 u16。
  const addr = new Uint8Array(32);
  const addrLen = new Int32Array([32]);
  for (let i = 0; i < count; i++) {
    const off = EX_HEADER_BYTES + i * EX_ENTRY_BYTES;
    if (Number(read.u64(ptr(buf), off + EX_PID_OFFSET)) !== pid) continue;
    const handle = Number(read.u64(ptr(buf), off + EX_HANDLE_OFFSET));
    addrLen[0] = 32;
    if (ffi.getsockname(handle, addr, addrLen) !== 0) continue;
    const family = read.u16(ptr(addr), 0);
    if (family !== AF_INET && family !== AF_INET6_WINDOWS) continue;
    const localPort = (read.u8(ptr(addr), 2) << 8) | read.u8(ptr(addr), 3);
    if (localPort === port) clearInheritFlag(ffi, handle);
  }
}

/**
 * 监听建立后调用：使该端口的监听 socket 句柄不可被子进程继承（win32）。
 * POSIX 为 no-op（Bun 默认 FD_CLOEXEC）。任何失败静默降级，绝不抛出。
 *
 * @param port 实际绑定端口（port 0 时传 server.port）。
 * @param server Bun.serve / Bun.listen / node:net server（有 fd 走直路，无则枚举）。
 */
export function guardListenerInheritance(port: number, server?: unknown): void {
  if (process.platform !== 'win32') return;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
  const ffi = loadWin32();
  if (ffi === null) return;
  try {
    const handle = serverHandle(server);
    if (handle !== undefined) {
      const flags = new Uint32Array(1);
      // 先验句柄有效（fd 语义异平台差异防御），再清标志；失败落枚举路。
      if (ffi.GetHandleInformation(handle, flags) !== 0 && clearInheritFlag(ffi, handle)) {
        return;
      }
    }
    markByPortEnumeration(ffi, port);
  } catch {
    // 防护失败不阻断监听；R-3 健康闸 / R-5③ 孤儿清理兜底仍在。
  }
}
