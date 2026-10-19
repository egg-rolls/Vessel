import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTenantPaths } from '../../packages/core/src/index';
import { createSessionBackend } from '../session-factory';
import {
  resolveContinueSessionId,
  runSessionList,
  validateResumeSessionId,
} from '../session-resume';

describe('session-resume（0.6.1 E8）', () => {
  let root: string;
  let configPath: string;
  let dataDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-resume-'));
    dataDir = path.join(root, 'data');
    configPath = path.join(root, 'vessel.yaml');
    fs.writeFileSync(configPath, `data_dir: ${JSON.stringify(dataDir)}\n`, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function options() {
    return {
      configPath,
      userConfigPath: path.join(root, 'missing-user.yaml'),
      env: {},
    };
  }

  async function seed(): Promise<void> {
    const paths = resolveTenantPaths(dataDir, 'default');
    const backend = createSessionBackend(
      { backend: 'file' },
      { tenantSessionsDir: paths.sessions_dir, tenantId: 'default' },
    );
    await backend.save({
      run_id: 'run-old',
      session_id: 's-old',
      messages: [{ role: 'user', content: 'old' }],
      started_at: 1000,
      updated_at: 1000,
      status: 'completed',
    });
    await backend.save({
      run_id: 'run-new',
      session_id: 's-new',
      messages: [{ role: 'user', content: 'new' }],
      started_at: 2000,
      updated_at: 2000,
      status: 'completed',
    });
    // 空会话不应被 continue 选中
    await backend.save({
      run_id: 'run-empty',
      session_id: 's-empty',
      messages: [],
      started_at: 3000,
      updated_at: 3000,
      status: 'completed',
    });
  }

  it('continue 选择最近的非空会话', async () => {
    await seed();
    const resolved = await resolveContinueSessionId(options());
    expect(resolved).toEqual({ ok: true, sessionId: 's-new', tenantId: 'default' });
  });

  it('没有任何会话时 continue 显式失败', async () => {
    const resolved = await resolveContinueSessionId(options());
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('no_sessions');
  });

  it('resume 校验存在且非空', async () => {
    await seed();
    expect(await validateResumeSessionId('s-old', options())).toEqual({ ok: true });

    const missing = await validateResumeSessionId('nope', options());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('session_not_found');

    const empty = await validateResumeSessionId('s-empty', options());
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain('session_empty');
  });

  it('memory 后端不能跨进程续接', async () => {
    fs.writeFileSync(
      configPath,
      `data_dir: ${JSON.stringify(dataDir)}\nsession:\n  backend: memory\n`,
      'utf-8',
    );
    const resolved = await resolveContinueSessionId(options());
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain('session_backend_memory');
  });

  it('runSessionList 输出会话且不构造 runtime', async () => {
    await seed();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runSessionList(options())).toBe(0);
      const text = log.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(text).toContain('s-new');
      expect(text).toContain('s-old');
      expect(text).not.toContain('s-empty');
    } finally {
      log.mockRestore();
    }
  });
});
