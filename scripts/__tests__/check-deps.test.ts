import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkDependencies,
  KERNEL_ALLOWED_IMPORTS,
  namedSymbols,
  parseImports,
  splitKnownExceptions,
  type Violation,
} from '../check-deps';

async function withFixture(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'vessel-deps-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function rules(violations: Violation[]): string[] {
  return violations.map((violation) => violation.rule);
}

describe('parseImports', () => {
  it('finds static, side-effect, dynamic, and require imports', () => {
    const source = [
      "import { a } from './a.js';",
      "export { b } from '../b.js';",
      "import './side.js';",
      "const c = await import('./c.js');",
      "const d = require('./d.js');",
    ].join('\n');

    expect(parseImports(source).map((ref) => ref.specifier)).toEqual([
      './a.js',
      '../b.js',
      './side.js',
      './c.js',
      './d.js',
    ]);
  });

  it('extracts named symbols and ignores type markers', () => {
    // 白名单校验关心导出的源符号（B），不是本地别名（C）。
    expect([...(namedSymbols('{ type A, B as C }') ?? [])]).toEqual(['A', 'B']);
    expect(namedSymbols('* as ns')).toBeNull();
  });
});

describe('D1: types only depend on types', () => {
  it('fails when types import an implementation', async () => {
    await withFixture(
      {
        'packages/core/src/types/tool.ts': "import { x } from '../runtime/plugin-host.js';\n",
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D1');
      },
    );
  });

  it('passes for types importing types', async () => {
    await withFixture(
      {
        'packages/core/src/types/tool.ts': "import type { Message } from './provider.js';\n",
      },
      async (root) => {
        expect(await checkDependencies(root)).toEqual([]);
      },
    );
  });
});

describe('D2: modules only cross module boundaries via index/types', () => {
  it('fails when a module imports another module internal', async () => {
    await withFixture(
      {
        'packages/core/src/context/x.ts': "import { s } from '../session/sqlite-backend.js';\n",
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D2');
      },
    );
  });

  it('allows another module index and types', async () => {
    await withFixture(
      {
        'packages/core/src/context/x.ts': [
          "import { s } from '../session/index.js';",
          "import type { Message } from '../types/provider.js';",
        ].join('\n'),
      },
      async (root) => {
        expect(await checkDependencies(root)).toEqual([]);
      },
    );
  });
});

describe('D3: core stays inside core', () => {
  it('fails when core imports the assembly layer', async () => {
    await withFixture(
      {
        'packages/core/src/context/x.ts': "import { boot } from '../../../src/bootstrap.js';\n",
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D3');
      },
    );
  });

  it('fails when core imports another workspace package', async () => {
    await withFixture(
      {
        'packages/core/src/context/x.ts': "import { loadConfig } from '@vessel-agent/config';\n",
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D3');
      },
    );
  });
});

describe('D4: kernel whitelist', () => {
  it('allows the four documented default implementations', async () => {
    await withFixture(
      {
        'packages/core/src/kernel/runtime-host.ts': [
          "import { AgentRuntime } from '../runtime/agent-runtime.js';",
          "import { MemoryContextManager } from '../context/context-manager.js';",
          "import { MemoryEventStream } from '../events/event-stream.js';",
          "import { MemoryPluginHost } from '../runtime/plugin-host.js';",
          "import type { ContextManager } from '../types/context.js';",
          "import { InProcessScheduler } from './scheduler.js';",
        ].join('\n'),
      },
      async (root) => {
        expect(await checkDependencies(root)).toEqual([]);
      },
    );
  });

  it('fails for a non-whitelisted implementation', async () => {
    await withFixture(
      {
        'packages/core/src/kernel/runtime-host.ts':
          "import { SQLiteSessionBackend } from '../session/sqlite-backend.js';\n",
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D4');
      },
    );
  });

  it('fails for the wrong symbol from a whitelisted file', async () => {
    await withFixture(
      {
        'packages/core/src/kernel/runtime-host.ts':
          "import { MemoryLimitChecker } from '../runtime/agent-runtime.js';\n",
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D4');
      },
    );
  });

  it('whitelist maps paths to exact symbols', () => {
    expect([
      ...(KERNEL_ALLOWED_IMPORTS['packages/core/src/runtime/agent-runtime.ts'] ?? []),
    ]).toEqual(['AgentRuntime']);
  });
});

describe('D5: non-core packages do not reach into core internals', () => {
  it('fails for a relative import into core', async () => {
    await withFixture(
      {
        'packages/tui/src/x.ts': "import { run } from '../../core/src/index.js';\n",
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D5');
      },
    );
  });

  it('fails for @vessel-agent/core internal paths', async () => {
    await withFixture(
      {
        'plugins/tools/team/src/x.ts': "import { run } from '@vessel-agent/core/src/index.js';\n",
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D5');
      },
    );
  });

  it('allows the public package entry', async () => {
    await withFixture(
      {
        'plugins/tools/team/src/x.ts': "import { AgentRuntime } from '@vessel-agent/core';\n",
      },
      async (root) => {
        expect(await checkDependencies(root)).toEqual([]);
      },
    );
  });
});

describe('D6: subpath exports only expose index.ts', () => {
  it('fails when an export points at an internal file', async () => {
    await withFixture(
      {
        'packages/core/package.json': JSON.stringify({
          exports: {
            '.': './src/index.ts',
            './provider': './src/provider/providers.ts',
          },
        }),
      },
      async (root) => {
        expect(rules(await checkDependencies(root))).toContain('D6');
      },
    );
  });

  it('passes when exports point at index.ts', async () => {
    await withFixture(
      {
        'packages/core/package.json': JSON.stringify({
          exports: {
            '.': './src/index.ts',
            './provider': './src/provider/index.ts',
          },
        }),
      },
      async (root) => {
        expect(await checkDependencies(root)).toEqual([]);
      },
    );
  });
});

describe('known exceptions', () => {
  it('separates exact exceptions from real violations', () => {
    const known: Violation = {
      rule: 'D2',
      file: 'packages/core/src/runtime/agent-runtime.ts',
      line: 6,
      specifier: '../limits/limit-checker.js',
      message: 'x',
    };
    const unknown: Violation = {
      rule: 'D2',
      file: 'packages/core/src/context/x.ts',
      line: 1,
      specifier: '../session/sqlite-backend.js',
      message: 'x',
    };
    const exceptions = [
      {
        rule: 'D2' as const,
        file: 'packages/core/src/runtime/agent-runtime.ts',
        specifier: '../limits/limit-checker.js',
        reason: 'fixture',
      },
    ];

    const result = splitKnownExceptions([known, unknown], exceptions);
    expect(result.known).toHaveLength(1);
    expect(result.unknown).toEqual([unknown]);
  });
});
