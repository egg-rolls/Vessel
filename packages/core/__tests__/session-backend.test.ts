import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionCorruptError } from '../src/index';
import { FileSessionBackend } from '../src/session/file-backend';
import { MemorySessionBackend } from '../src/session/session-backend';
import { SQLiteSessionBackend } from '../src/session/sqlite-backend';
import type { RunState } from '../src/types/session';

const createRunState = (sessionId: string, overrides?: Partial<RunState>): RunState => ({
  run_id: `run-${sessionId}`,
  session_id: sessionId,
  messages: [{ role: 'user', content: 'test' }],
  started_at: Date.now(),
  status: 'running',
  ...overrides,
});

describe('MemorySessionBackend', () => {
  let backend: MemorySessionBackend;

  beforeEach(() => {
    backend = new MemorySessionBackend();
  });

  it('should save and load run states', async () => {
    const state = createRunState('session-1');
    await backend.save(state);

    const loaded = await backend.load('session-1');
    expect(loaded).toEqual(state);
  });

  it('should return null for missing sessions', async () => {
    const loaded = await backend.load('missing-session');
    expect(loaded).toBeNull();
  });

  it('should delete sessions', async () => {
    const state = createRunState('session-1');
    await backend.save(state);

    expect(await backend.load('session-1')).not.toBeNull();

    await backend.delete('session-1');

    expect(await backend.load('session-1')).toBeNull();
  });

  it('should list sessions', async () => {
    await backend.save(createRunState('session-1'));
    await backend.save(createRunState('session-2'));
    await backend.save(createRunState('session-3'));

    const sessions = await backend.list();
    expect(sessions).toHaveLength(3);
    expect(sessions).toContain('session-1');
    expect(sessions).toContain('session-2');
    expect(sessions).toContain('session-3');
  });

  it('should report size', async () => {
    expect(backend.size).toBe(0);

    await backend.save(createRunState('session-1'));
    expect(backend.size).toBe(1);

    await backend.save(createRunState('session-2'));
    expect(backend.size).toBe(2);
  });
});

describe('SQLiteSessionBackend', () => {
  let tmpDir: string;
  let backend: SQLiteSessionBackend | undefined;

  beforeEach(() => {
    // 隔离到系统临时目录，避免污染真实 .vessel/（同 headless.test.ts 的做法）
    tmpDir = mkdtempSync(join(tmpdir(), 'vessel-sqlite-'));
  });

  afterEach(() => {
    backend?.close();
    backend = undefined;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows 下文件锁可能未及时释放，残留只在系统临时目录
    }
  });

  it('父目录不存在时自动创建（首次运行不因缺目录失败）', async () => {
    backend = new SQLiteSessionBackend(join(tmpDir, 'deep', 'nested', 'sessions.db'));

    await backend.save(createRunState('session-1'));

    const loaded = await backend.load('session-1');
    expect(loaded?.session_id).toBe('session-1');
  });

  it(':memory: 走内存库（测试用，不建目录）', async () => {
    backend = new SQLiteSessionBackend(':memory:');

    await backend.save(createRunState('session-1'));
    expect((await backend.load('session-1'))?.session_id).toBe('session-1');
  });

  it('全量 CRUD + listRich（过滤空会话、按 updated_at 倒序、branch）', async () => {
    backend = new SQLiteSessionBackend(':memory:');

    await backend.save(
      createRunState('a', {
        status: 'completed',
        updated_at: 100,
        branch: 'main',
        messages: [{ role: 'user', content: 'first' }],
      }),
    );
    await backend.save(
      createRunState('b', {
        status: 'completed',
        updated_at: 200,
        messages: [{ role: 'user', content: 'second' }],
      }),
    );
    await backend.save(createRunState('empty', { messages: [], updated_at: 300 }));

    expect((await backend.list()).sort()).toEqual(['a', 'b', 'empty']);
    expect((await backend.load('a'))?.branch).toBe('main');

    const rich = await backend.listRich();
    expect(rich.map((r) => r.session_id)).toEqual(['b', 'a']);
    expect(rich[0]?.message_count).toBe(1);

    await backend.delete('a');
    expect((await backend.list()).sort()).toEqual(['b', 'empty']);
    expect(await backend.load('a')).toBeNull();
  });

  it('listRich 在 updated_at 相同时按 session_id 升序', async () => {
    backend = new SQLiteSessionBackend(':memory:');
    for (const id of ['b', 'a']) {
      await backend.save(
        createRunState(id, {
          status: 'completed',
          updated_at: 100,
          messages: [{ role: 'user', content: id }],
        }),
      );
    }

    const rich = await backend.listRich();
    expect(rich.map((r) => r.session_id)).toEqual(['a', 'b']);
  });
});

describe('FileSessionBackend', () => {
  const TEST_DIR = '.vessel/test-sessions';
  let backend: FileSessionBackend;

  beforeEach(() => {
    backend = new FileSessionBackend(TEST_DIR);
  });

  afterEach(() => {
    backend.close();
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  it('should save and load run states', async () => {
    const state = createRunState('session-1');
    await backend.save(state);

    const loaded = await backend.load('session-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.session_id).toBe('session-1');
    expect(loaded?.run_id).toBe('run-session-1');
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'test' }]);
  });

  it('should return null for missing sessions', async () => {
    const loaded = await backend.load('missing-session');
    expect(loaded).toBeNull();
  });

  it('should delete sessions', async () => {
    const state = createRunState('session-1');
    await backend.save(state);

    expect(await backend.load('session-1')).not.toBeNull();

    await backend.delete('session-1');

    expect(await backend.load('session-1')).toBeNull();
  });

  it('should list sessions', async () => {
    await backend.save(createRunState('session-1'));
    await backend.save(createRunState('session-2'));
    await backend.save(createRunState('session-3'));

    const sessions = await backend.list();
    expect(sessions).toHaveLength(3);
    expect(sessions).toContain('session-1');
    expect(sessions).toContain('session-2');
    expect(sessions).toContain('session-3');
  });

  it('should return empty list for non-existent directory', async () => {
    const fresh = new FileSessionBackend('.vessel/nonexistent');
    const sessions = await fresh.list();
    expect(sessions).toEqual([]);
    fresh.close();
  });

  it('should auto-derive title and preview on save', async () => {
    const state = createRunState('with-title', {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is the weather today in Tokyo?' },
      ],
    });
    await backend.save(state);

    const loaded = await backend.load('with-title');
    expect(loaded?.title).toBe('What is the weather today in Tokyo?');
    expect(loaded?.preview).toBe('What is the weather today in Tokyo?');
  });

  it('派生 title 时跳过注入消息，取首轮真实用户输入（C-07）', async () => {
    const state = createRunState('injected', {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '<file path="skills/x.md">技能正文</file>' },
        { role: 'user', content: '请按这个来' },
        { role: 'assistant', content: '好的' },
      ],
    });
    await backend.save(state);

    const loaded = await backend.load('injected');
    expect(loaded?.title).toBe('请按这个来');
    expect(loaded?.preview).toBe('请按这个来');
  });

  it('should preserve explicit title and preview on save', async () => {
    const state = createRunState('explicit', {
      title: 'Custom Title',
      preview: 'Custom preview text',
      messages: [{ role: 'user', content: 'Original message' }],
    });
    await backend.save(state);

    const loaded = await backend.load('explicit');
    expect(loaded?.title).toBe('Custom Title');
    expect(loaded?.preview).toBe('Custom preview text');
  });

  it('should auto-set updated_at when not provided', async () => {
    const state = createRunState('timed');
    await backend.save(state);

    const loaded = await backend.load('timed');
    expect(loaded?.updated_at).toBeGreaterThan(0);
  });

  describe('损坏检测（0.8.1）', () => {
    it('load 对损坏 JSON 抛 SessionCorruptError（含 path/cause），不返回 null', async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const path = join(TEST_DIR, 'corrupt.json');
      await writeFile(path, '{ not json', 'utf8');

      const error = await backend.load('corrupt').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SessionCorruptError);
      expect((error as SessionCorruptError).code).toBe('session_corrupt');
      expect((error as SessionCorruptError).path).toContain('corrupt.json');
      expect((error as SessionCorruptError).cause).toBeInstanceOf(Error);
    });

    it('主路径存在但损坏时不回退 legacy 路径', async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const id = 'space id';
      // 主路径（编码）损坏；legacy（未编码）是合法 JSON
      await writeFile(join(TEST_DIR, `${encodeURIComponent(id)}.json`), 'broken', 'utf8');
      await writeFile(
        join(TEST_DIR, `${id}.json`),
        JSON.stringify(createRunState(id, { messages: [{ role: 'user', content: 'legacy' }] })),
        'utf8',
      );

      await expect(backend.load(id)).rejects.toBeInstanceOf(SessionCorruptError);
    });

    it('只有主路径 ENOENT 时才回退 legacy', async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const id = 'legacy only id';
      await writeFile(
        join(TEST_DIR, `${id}.json`),
        JSON.stringify(createRunState(id, { messages: [{ role: 'user', content: 'old' }] })),
        'utf8',
      );

      expect((await backend.load(id))?.messages[0]?.content).toBe('old');
    });

    it('delete 对损坏文件抛错且不删除（不静默保留/删除）', async () => {
      await mkdir(TEST_DIR, { recursive: true });
      const path = join(TEST_DIR, 'broken-delete.json');
      await writeFile(path, '{ not json', 'utf8');

      await expect(backend.delete('broken-delete')).rejects.toBeInstanceOf(SessionCorruptError);
      expect(await readFile(path, 'utf8')).toBe('{ not json');
    });
  });

  describe('listRich', () => {
    it('should filter empty sessions and sort by updated_at desc', async () => {
      await backend.save(
        createRunState('empty', {
          messages: [],
          status: 'completed',
        }),
      );
      await backend.save(
        createRunState('old', {
          messages: [{ role: 'user', content: 'old msg' }],
          status: 'completed',
          updated_at: 2000,
        }),
      );
      await backend.save(
        createRunState('new', {
          messages: [{ role: 'user', content: 'new msg' }],
          status: 'completed',
          updated_at: 5000,
        }),
      );

      const rich = await backend.listRich();
      expect(rich.length).toBe(2); // empty filtered out
      expect(rich[0]?.session_id).toBe('new');
      expect(rich[1]?.session_id).toBe('old');
      expect(rich[0]?.preview).toBe('new msg');
      expect(rich[0]?.message_count).toBe(1);
    });

    it('updated_at 相同时按 session_id 升序', async () => {
      for (const id of ['b', 'a']) {
        await backend.save(
          createRunState(id, {
            messages: [{ role: 'user', content: id }],
            status: 'completed',
            updated_at: 1000,
          }),
        );
      }

      const rich = await backend.listRich();
      expect(rich.map((session) => session.session_id)).toEqual(['a', 'b']);
    });

    it('should persist and return branch field', async () => {
      await backend.save(
        createRunState('with-branch', {
          messages: [{ role: 'user', content: 'test' }],
          status: 'completed',
          branch: 'feat/my-feature',
        }),
      );
      await backend.save(
        createRunState('no-branch', {
          messages: [{ role: 'user', content: 'test2' }],
          status: 'completed',
        }),
      );

      const rich = await backend.listRich();
      const withBranch = rich.find((s) => s.session_id === 'with-branch');
      const noBranch = rich.find((s) => s.session_id === 'no-branch');
      expect(withBranch?.branch).toBe('feat/my-feature');
      expect(noBranch?.branch).toBeUndefined();
    });
  });
});
