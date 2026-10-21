import { afterEach, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryEventStream } from '../../packages/core/src/index';
import type { DurableCheckpointLike } from '../../packages/serve/src/durable';
import type { Gateway } from '../../packages/serve/src/gateway';
import { startTestGateway } from '../../packages/serve/__tests__/helpers';
import { type BootstrapResult, bootstrap } from '../bootstrap';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-connect-resume-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gatewayWithResume(
  events: MemoryEventStream,
  checkpoint: DurableCheckpointLike,
  publishTerminal: boolean,
): { gateway: Gateway; resumed: () => number } {
  let resumed = 0;
  const gateway = startTestGateway({
    events,
    port: 0,
    hostname: '127.0.0.1',
    token: 'connect-token',
    durable: {
      store: {
        load: async (runId: string) => (runId === checkpoint.run_id ? checkpoint : null),
        list: async () => [checkpoint],
      },
      resume: async (runId: string) => {
        resumed += 1;
        if (!publishTerminal) return;
        // 真正的 resume 是后台执行：事件可能先于 runs.resume 的 RPC 响应到达。
        events.publish({
          type: 'run.resumed',
          run_id: runId,
          data: { session_id: checkpoint.session_id },
          ts: Date.now(),
        });
        events.publish({
          type: 'run.completed',
          run_id: runId,
          data: {
            run_id: runId,
            session_id: checkpoint.session_id,
            output: 'resumed-output',
          },
          ts: Date.now(),
        });
      },
    },
  });
  cleanups.push(() => gateway.stop());
  return { gateway, resumed: () => resumed };
}

async function connect(gateway: Gateway): Promise<BootstrapResult> {
  const dataDir = tempDir();
  const result = await bootstrap({
    useMock: true,
    headless: true,
    interactive: false,
    dataDir,
    configPath: path.join(dataDir, 'missing.yaml'),
    userConfigPath: path.join(dataDir, 'config.yaml'),
    connect: gateway.url,
    connectToken: 'connect-token',
  });
  cleanups.push(() => void result.shutdown());
  return result;
}

it('--connect --resume-run 等终态：输出不得是空串，且 session 来自 run.completed', async () => {
  const events = new MemoryEventStream();
  const checkpoint: DurableCheckpointLike = {
    run_id: 'run-resume-1',
    session_id: 'session-resumed',
    status: 'interrupted',
    updated_at: 1000,
    tenant_id: 'default',
  };
  const { gateway, resumed } = gatewayWithResume(events, checkpoint, true);
  const result = await connect(gateway);

  const outcome = await result.resumeRun('run-resume-1');

  expect(outcome.result).toBe('resumed-output');
  expect(outcome.sessionId).toBe('session-resumed');
  expect(resumed()).toBe(1);
});

it('远程 resume 不可恢复：抛 run_not_resumable，而不是空串成功', async () => {
  const events = new MemoryEventStream();
  const checkpoint: DurableCheckpointLike = {
    run_id: 'run-done-1',
    session_id: 'session-done',
    status: 'completed',
    updated_at: 1000,
    tenant_id: 'default',
  };
  const { gateway, resumed } = gatewayWithResume(events, checkpoint, false);
  const result = await connect(gateway);

  await expect(result.resumeRun('run-done-1')).rejects.toMatchObject({
    code: 'run_not_resumable',
  });
  expect(resumed()).toBe(0);
});
