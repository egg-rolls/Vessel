/**
 * A5：装配层把 tenantId 透传给 FileRunStore。
 *
 * delete 的跨 tenant 归属校验属于 core；这里只验证 asm 接线后
 * save 补齐 tenant_id、load/list 过滤其它 tenant。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { createRunStore } from '../run-store-factory';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-run-store-'));
  dirs.push(dir);
  return dir;
}

describe('createRunStore - tenantId', () => {
  it('透传 tenantId：写入补齐 tenant_id，load/list 过滤其它 tenant', async () => {
    const dir = tmpDir();
    const config = {
      durable: { enabled: true, backend: 'file', path: dir },
    } as VesselConfig;

    const acme = createRunStore(config, { tenantId: 'acme' });
    const work = createRunStore(config, { tenantId: 'work' });
    if (!acme || !work) throw new Error('expected file run stores');

    await acme.save({
      run_id: 'acme-run',
      session_id: 's-acme',
      status: 'interrupted',
      messages: [],
      created_at: 1,
      updated_at: 2,
    });
    await work.save({
      run_id: 'work-run',
      session_id: 's-work',
      status: 'interrupted',
      messages: [],
      created_at: 1,
      updated_at: 3,
    });

    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'acme-run.json'), 'utf8')) as {
      tenant_id?: string;
    };
    expect(raw.tenant_id).toBe('acme');

    expect((await acme.list()).map((checkpoint) => checkpoint.run_id)).toEqual(['acme-run']);
    expect((await work.list()).map((checkpoint) => checkpoint.run_id)).toEqual(['work-run']);
    expect(await acme.load('work-run')).toBeNull();
    expect(await work.load('acme-run')).toBeNull();
  });
});
