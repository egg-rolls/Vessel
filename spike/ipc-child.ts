/**
 * 一次性尖刺（0.57 tool-host-design）：IPC 对端，只回显帧。
 *
 * 两种传输模式，同一份帧协议（4 字节大端长度 + JSON 正文）：
 *   bun spike/ipc-child.ts             → stdio 管道（父进程 spawn，无监听端口）
 *   bun spike/ipc-child.ts tcp <port>  → 回环 TCP（127.0.0.1，有监听端口）
 *
 * 本文件只在 spike/ 下，量完可整体删除；不碰产品代码路径。
 */

const TCP_MODE = process.argv[2] === 'tcp';
const TCP_PORT = Number(process.argv[3] ?? '0');

let pending = new Uint8Array(0);

function encode(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.byteLength, false);
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** 收到一帧就原样回一帧；回包带 echo_n，确保对端真的解过 JSON 而不是回灌字节。 */
function handle(frame: Uint8Array, write: (bytes: Uint8Array) => void): void {
  const parsed = JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>;
  parsed['echo_n'] = typeof parsed['n'] === 'number' ? parsed['n'] : -1;
  write(encode(new TextEncoder().encode(JSON.stringify(parsed))));
}

if (TCP_MODE) {
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: TCP_PORT,
    socket: {
      data(s, chunk) {
        pending = concat(pending, new Uint8Array(chunk));
        const { frames, rest } = splitFrames(pending);
        pending = rest;
        for (const frame of frames) handle(frame, (bytes) => s.write(bytes));
      },
      open() {},
      close() {},
      error() {},
    },
  });
  void socket;
} else {
  const writer = Bun.stdout.writer();
  for await (const chunk of Bun.stdin.stream()) {
    pending = concat(pending, new Uint8Array(chunk));
    const { frames, rest } = splitFrames(pending);
    pending = rest;
    for (const frame of frames) {
      handle(frame, (bytes) => writer.write(bytes));
    }
    writer.flush();
  }
}
