import { afterEach, describe, expect, test } from 'bun:test';
import {
  fetchAllNodeAttention,
  NODES_STORAGE_KEY,
  nodeTokenKey,
  readNodeToken,
  readStoredNodes,
  removeNodeToken,
  storeNodeToken,
  validateNodeDraft,
  writeStoredNodes,
} from '../src/gateway/nodes';

type StorageKind = 'sessionStorage' | 'localStorage';

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** 内存 Storage；只实现 nodes.ts 用到的三个方法。 */
function installFakeStorage(kind: StorageKind) {
  const map = new Map<string, string>();
  const previous = (globalThis as Record<string, unknown>)[kind];
  const storage: FakeStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  (globalThis as Record<string, unknown>)[kind] = storage;
  cleanups.push(() => {
    if (previous === undefined) delete (globalThis as Record<string, unknown>)[kind];
    else (globalThis as Record<string, unknown>)[kind] = previous;
  });
  return map;
}

function stubFetch(handler: (url: string, authorization: string | null) => Response) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, authorization });
    return handler(url, authorization);
  }) as typeof fetch;
  cleanups.push(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('node credential storage', () => {
  test('metadata JSON never holds the token and localStorage stays empty', () => {
    const session = installFakeStorage('sessionStorage');
    const local = installFakeStorage('localStorage');

    writeStoredNodes([{ name: 'office', url: 'https://office.example' }]);
    storeNodeToken('office', 'human-token-office');

    const metadata = session.get(NODES_STORAGE_KEY) ?? '';
    expect(metadata).toContain('office');
    expect(metadata).toContain('https://office.example');
    expect(metadata).not.toContain('human-token-office');
    expect(metadata).not.toContain('token');

    // token 落在独立 key，元数据与 localStorage 都拿不到。
    expect(session.get(nodeTokenKey('office'))).toBe('human-token-office');
    expect(local.size).toBe(0);

    expect(readStoredNodes()).toEqual([{ name: 'office', url: 'https://office.example' }]);
    expect(readNodeToken('office')).toBe('human-token-office');

    removeNodeToken('office');
    expect(readNodeToken('office')).toBeNull();
  });

  test('a corrupted metadata blob degrades to an empty list instead of throwing', () => {
    const session = installFakeStorage('sessionStorage');
    session.set(NODES_STORAGE_KEY, '{not json');
    expect(readStoredNodes()).toEqual([]);
  });
});

describe('fetchAllNodeAttention', () => {
  test('one node 401 does not hide another node and tokens are never cross-used', async () => {
    installFakeStorage('sessionStorage');
    storeNodeToken('alpha', 'token-alpha');
    storeNodeToken('beta', 'token-beta');

    const calls = stubFetch((_url, authorization) => {
      if (authorization === 'Bearer token-beta') {
        return json(
          {
            v: 1,
            id: 'req',
            ok: false,
            error: { code: 'unauthorized', message: 'invalid gateway token' },
          },
          401,
        );
      }
      return json({
        v: 1,
        id: 'req',
        ok: true,
        result: {
          interactions: [
            {
              kind: 'permission',
              request_id: 'req-1',
              run_id: 'run-1',
              created_at: 1,
              status: 'pending',
            },
          ],
          total: 1,
          next_cursor: 'next-1',
        },
      });
    });

    const nodes = [
      { name: 'alpha', url: 'https://alpha.example' },
      { name: 'beta', url: 'https://beta.example' },
    ];
    // 与 NodeProvider 相同：每个节点显式解析自己的 token，避免聚合层复用同一个凭据。
    const results = await fetchAllNodeAttention(
      nodes,
      { status: 'pending', limit: 20, order: 'newest' },
      (node) => readNodeToken(node.name) ?? undefined,
    );

    expect(results).toHaveLength(2);
    const alpha = results.find((result) => result.node.name === 'alpha');
    const beta = results.find((result) => result.node.name === 'beta');

    expect(alpha?.ok).toBe(true);
    if (alpha?.ok) {
      expect(alpha.page.interactions.map((item) => item.request_id)).toEqual(['req-1']);
      expect(alpha.page.total).toBe(1);
      expect(alpha.page.next_cursor).toBe('next-1');
    }

    // beta 的失败只属于 beta 分组，且带稳定 code / status。
    expect(beta?.ok).toBe(false);
    if (beta && !beta.ok) {
      expect(beta.error.code).toBe('unauthorized');
      expect(beta.error.status).toBe(401);
    }

    // 每个节点用自己的 token，证明 Authorization 头没有串用。
    const alphaCall = calls.find((call) => call.url.startsWith('https://alpha.example'));
    const betaCall = calls.find((call) => call.url.startsWith('https://beta.example'));
    expect(alphaCall?.authorization).toBe('Bearer token-alpha');
    expect(betaCall?.authorization).toBe('Bearer token-beta');
    expect(alphaCall?.authorization).not.toBe(betaCall?.authorization);

    // 聚合结果（含错误）不含任何 token。
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain('token-alpha');
    expect(serialized).not.toContain('token-beta');
  });
});

describe('validateNodeDraft', () => {
  test('rejects duplicate names, illegal URLs and empty tokens', () => {
    const existing = [{ name: 'alpha', url: 'https://alpha.example' }];

    expect(
      validateNodeDraft(
        { name: 'alpha', url: 'https://other.example', token: 't' },
        existing,
        'http:',
      ),
    ).toMatchObject({ ok: false, error: 'name_duplicate' });

    expect(
      validateNodeDraft(
        { name: 'beta', url: 'https://gw.example.com/v1', token: 't' },
        existing,
        'http:',
      ),
    ).toMatchObject({ ok: false, error: 'url_invalid' });

    expect(
      validateNodeDraft(
        { name: 'beta', url: 'https://beta.example', token: '   ' },
        existing,
        'http:',
      ),
    ).toMatchObject({ ok: false, error: 'token_required' });

    expect(
      validateNodeDraft({ name: '  ', url: 'https://beta.example', token: 't' }, existing, 'http:'),
    ).toMatchObject({ ok: false, error: 'name_required' });

    expect(
      validateNodeDraft(
        { name: 'beta', url: 'https://beta.example', token: 'token-beta' },
        existing,
        'https:',
      ).ok,
    ).toBe(true);
  });
});
