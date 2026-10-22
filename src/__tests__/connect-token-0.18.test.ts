import { afterEach, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap } from '../bootstrap';
import type { RpcClient } from '../rpc';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-connect-token-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

it('显式 --connect-token 不被 VESSEL_CONNECT_TOKEN 覆盖', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'api_key: sk-test\n');
  const previous = process.env.VESSEL_CONNECT_TOKEN;
  process.env.VESSEL_CONNECT_TOKEN = 'env-token';
  let captured: string | undefined;
  let closed = false;
  const client: RpcClient & { close(): Promise<void> } = {
    request: async () => {
      throw new Error('offline');
    },
    subscribe: () => () => {},
    close: async () => {
      closed = true;
    },
  };
  try {
    const result = await bootstrap({
      useMock: true,
      headless: true,
      interactive: false,
      dataDir: dir,
      configPath: path.join(dir, 'missing.yaml'),
      userConfigPath: path.join(dir, 'config.yaml'),
      connect: 'https://127.0.0.1:9',
      connectToken: 'cli-token',
      rpcClientFactory: (options) => {
        captured = options.token;
        return client;
      },
    });
    await result.shutdown();
  } finally {
    if (previous === undefined) delete process.env.VESSEL_CONNECT_TOKEN;
    else process.env.VESSEL_CONNECT_TOKEN = previous;
  }

  expect(captured).toBe('cli-token');
  expect(closed).toBe(true);
});
