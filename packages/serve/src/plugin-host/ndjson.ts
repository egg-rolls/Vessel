/**
 * NDJSON codec 单实现（engine-pool 契约 S10）。
 *
 * 行分割 + UTF-8 字节守卫 + JSON 序列化/解析；child.ts / entry.ts / pool.ts 消费同一份。
 * pending 关联、稳定错误码、throw/丢弃/fail 语义由各消费方自持：
 * 入站经 onFrame / onViolation 折回，出站经 writeFrame 返回值折回（超限 false）。
 *
 * 入站语义（child.ts 行泵现态）：按 \n 分割；剥单个尾部 \r；trim 后为空则跳过；
 * 完整行不论大小都交付解析（守卫只针对尚无换行的残留 buffer）；残留超限 →
 * 清 buffer + onViolation('inbound', bytes)。非 JSON / 非对象行静默跳过。
 * 出站语义：JSON.stringify + UTF-8 字节守卫；超限 → onViolation('outbound', bytes) + false。
 *
 * @module @vessel-agent/serve/plugin-host
 */

export interface NdjsonOptions {
  maxBytes: number;
  onFrame(frame: Record<string, unknown>): void;
  onViolation(kind: 'inbound' | 'outbound', bytes: number): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把 NDJSON 帧泵挂到 Node 可读流上（Web stream 消费方自行 fromWeb 桥接）。
 * 流错误 / 消费回调抛错 → 静默停泵（现态 pump catch 语义）；EOF → 解码器 flush
 * 后再走一次行分割 + 残留守卫（未终结的残留不交付为帧）。close() 幂等停泵。
 */
export function attachNdjsonReader(
  input: NodeJS.ReadableStream,
  o: NdjsonOptions,
): { close(): void } {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  // 不变式：bufferBytes === encode(buffer).byteLength（UTF-8 对字符串拼接可加，
  // 增量计数与逐次全量编码逐字等价；避免残留增长时的 O(n²) 重复编码）。
  let bufferBytes = 0;
  let closed = false;

  function deliver(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // 非 JSON 行：静默跳过（冻结 S10 形状无解析诊断回调）。
      return;
    }
    if (isRecord(frame)) o.onFrame(frame);
  }

  function feed(chunk: string): void {
    buffer += chunk;
    bufferBytes += encoder.encode(chunk).byteLength;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const rawLine = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      bufferBytes -= encoder.encode(rawLine).byteLength + 1;
      let line = rawLine;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length > 0) deliver(line);
      index = buffer.indexOf('\n');
    }
    if (bufferBytes > o.maxBytes) {
      const bytes = bufferBytes;
      buffer = '';
      bufferBytes = 0;
      o.onViolation('inbound', bytes);
    }
  }

  function stop(): void {
    if (closed) return;
    closed = true;
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('error', onError);
    input.pause();
  }

  function onData(chunk: Uint8Array | string): void {
    if (closed) return;
    try {
      feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    } catch {
      // 消费回调抛错（现态 onStdout → pump catch）：停泵，不再 flush。
      stop();
    }
  }

  function onEnd(): void {
    if (closed) return;
    try {
      feed(decoder.decode());
    } catch {
      // 现态 EOF flush 同在 pump try 内：抛错静默。
    }
    stop();
  }

  function onError(): void {
    // 进程退出时流可能抛错（现态 pump catch）：停泵，不 flush。
    stop();
  }

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onError);
  return { close: stop };
}

/**
 * NDJSON 写端：序列化 + 字节守卫。超限返回 false（调用方折错/丢弃，现态语义）；
 * 写入直达 output.write（无内部缓冲），换行符随帧一次写入。
 */
export function createNdjsonWriter(
  output: NodeJS.WritableStream,
  o: NdjsonOptions,
): { writeFrame(frame: Record<string, unknown>): boolean } {
  const encoder = new TextEncoder();
  return {
    writeFrame(frame: Record<string, unknown>): boolean {
      const line = JSON.stringify(frame);
      const bytes = encoder.encode(line).byteLength;
      if (bytes > o.maxBytes) {
        o.onViolation('outbound', bytes);
        return false;
      }
      output.write(`${line}\n`);
      return true;
    },
  };
}
