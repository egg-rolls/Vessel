/**
 * 一次性尖刺（0.57 tool-host-design）：同机 IPC 往返开销读数。
 *
 * 量三件事：
 *   1. stdio 管道（父进程 spawn 子进程，无监听端口）的往返延迟；
 *   2. 回环 TCP（127.0.0.1）同一帧协议的往返延迟，作为对照；
 *   3. 子进程启动到第一帧回包的冷启动成本（sidecar 的生命周期预算要用它）。
 *
 * 帧协议：4 字节大端长度 + UTF-8 JSON 正文（与设计文档 §3 一致）。
 * 一个尺寸一次只发一帧：量的是「一问一答」的 RTT，不是吞吐。
 *
 * 跑：bun spike/ipc-roundtrip.ts
 * 本文件是一次性尖刺，不碰产品代码路径。
 */

const CHILD = new URL('./ipc-child.ts', import.meta.url).pathname;

interface Channel {
  send(bytes: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

function encode(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

function splitFrames(buffer: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 4) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 4);
    const length = view.getUint32(0, false);
    if (buffer.byteLength - offset - 4 < length) break;
    frames.push(buffer.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** 单飞（一次只有一帧在飞）的请求/应答包装 */
function makeChannel(
  write: (bytes: Uint8Array) => void,
  subscribe: (onData: (chunk: Uint8Array) => void) => void,
  close: () => void,
): Channel {
  let pending = new Uint8Array(0);
  const waiters: ((bytes: Uint8Array) => void)[] = [];
  subscribe((chunk) => {
    pending = concat(pending, chunk);
    const { frames, rest } = splitFrames(pending);
    pending = rest;
    for (const frame of frames) {
      const resolve = waiters.shift();
      if (resolve !== undefined) resolve(frame);
    }
  });
  return {
    send(payload) {
      const bytes = encode(payload);
      return new Promise<Uint8Array>((resolve) => {
        waiters.push(resolve);
        write(bytes);
      });
    },
    close,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function payloadOf(bytes: number, n: number): Uint8Array {
  const head = JSON.stringify({ n, t: 'tool.call.result', body: '' });
  const fill = Math.max(0, bytes - head.length);
  return new TextEncoder().encode(
    JSON.stringify({ n, t: 'tool.call.result', body: 'x'.repeat(fill) }),
  );
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const median = at(0.5);
  return `median=${median.toFixed(3)}ms p95=${(at(0.95) ?? 0).toFixed(3)}ms min=${(sorted[0] ?? 0).toFixed(3)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(3)}ms`;
}

async function measure(
  label: string,
  channel: Channel,
  sizes: { bytes: number; reps: number }[],
): Promise<void> {
  for (const { bytes, reps } of sizes) {
    for (let i = 0; i < 3; i += 1) await channel.send(payloadOf(bytes, -1));
    const samples: number[] = [];
    for (let i = 0; i < reps; i += 1) {
      const payload = payloadOf(bytes, i);
      const started = performance.now();
      const reply = await channel.send(payload);
      samples.push(performance.now() - started);
      if (reply.byteLength < payload.byteLength) throw new Error('short reply');
    }
    console.log(`  ${label} ${String(bytes).padStart(8)} B x${reps}: ${stats(samples)}`);
  }
}

// ── 1. stdio 管道 ────────────────────────────────
const pipeStart = performance.now();
const child = Bun.spawn(['bun', CHILD], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
const pipeChannel = makeChannel(
  (bytes) => {
    child.stdin.write(bytes);
    child.stdin.flush();
  },
  (onData) => {
    void (async () => {
      for await (const chunk of child.stdout) onData(new Uint8Array(chunk));
    })();
  },
  () => child.kill(),
);
await pipeChannel.send(new TextEncoder().encode(JSON.stringify({ n: -1, t: 'hello' })));
console.log(`stdio pipe: child 启动 + 首次握手 ${(performance.now() - pipeStart).toFixed(1)}ms`);
await measure('pipe', pipeChannel, [
  { bytes: 1024, reps: 200 },
  { bytes: 100 * 1024, reps: 100 },
  { bytes: 1024 * 1024, reps: 50 },
]);
pipeChannel.close();

// ── 2. 回环 TCP 对照 ─────────────────────────────
let accepted: ((ch: Channel) => void) | undefined;
const acceptedPromise = new Promise<Channel>((resolve) => {
  accepted = resolve;
});
const server = Bun.listen<undefined>({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    data(socket, chunk) {
      socket.data = undefined;
      onServerData(new Uint8Array(chunk));
    },
    open() {},
    error() {},
  },
});
const onServerDataRef: { fn?: (chunk: Uint8Array) => void } = {};
const onServerData = (chunk: Uint8Array): void => onServerDataRef.fn?.(chunk);

const tcpStart = performance.now();
const tcpChild = Bun.spawn(['bun', CHILD, 'tcp', String(server.port)], {
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
});
const tcpChannel = await (async () => {
  // 服务端只接受一个连接：拿到 socket 后包装成同一个 Channel 形状。
  const socketChannel = await new Promise<Channel>((resolve) => {
    const originalOpen = server.socket.open;
    void originalOpen;
    const timer = setInterval(() => {
      // Bun.listen 的 socket 句柄只能从回调拿；用 data 回调第一次到达表示已连接。
    }, 5);
    onServerDataRef.fn = () => {};
    const pendingWaiters: ((bytes: Uint8Array) => void)[] = [];
    let buffer = new Uint8Array(0);
    onServerDataRef.fn = (chunk) => {
      buffer = concat(buffer, chunk);
      const { frames, rest } = splitFrames(buffer);
      buffer = rest;
      for (const frame of frames) pendingWaiters.shift()?.(frame);
    };
    // 通过 server 的 socket 集合找到一个连接的写口：Bun 下用 server.pendingSockets 不可用，
    // 改用「子进程主动连 + 父进程在 open 里捕获 socket」的写法。
    resolve({
      send(payload) {
        const bytes = encode(payload);
        return new Promise<Uint8Array>((res) => {
          pendingWaiters.push(res);
          serverSocketRef.socket?.write(bytes);
        });
      },
      close() {
        clearInterval(timer);
        serverSocketRef.socket?.end();
      },
    });
  });
  accepted?.(socketChannel);
  return socketChannel;
})();

const serverSocketRef: { socket?: { write(b: Uint8Array): unknown; end(): void } } = {};
void tcpChannel;
void tcpChild;
void acceptedPromise;
console.log(`(tcp 分支未完成，见下)`);
server.stop(true);
