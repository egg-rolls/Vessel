import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_EVALS_OPTIONS,
  DEFAULT_FEISHU_OPTIONS,
  DEFAULT_OBSERVABILITY_OPTIONS,
  DEFAULT_WORKFLOW_OPTIONS,
} from '../src/defaults';
import { loadConfig, loadConfigFromEnv, snakeToCamel } from '../src/loader';
import type { FeishuConfig, VesselConfig } from '../src/types';
import {
  findUnknownKeys,
  findUnknownNestedKeys,
  KNOWN_CONFIG_KEYS,
  validateConfig,
} from '../src/validator';

// 隔离 VESSEL_* 环境变量
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VESSEL_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpYaml(content: string): string {
  const dir = tmpDir('vessel-04-cfg-');
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function missingPath(): string {
  return path.join(tmpDir('vessel-04-missing-'), 'does-not-exist.yaml');
}

function pathsOf(config: VesselConfig): string[] {
  return validateConfig(config).errors.map((e) => e.path);
}

describe('0.4 defaults', () => {
  it('exports the frozen default values', () => {
    expect(DEFAULT_WORKFLOW_OPTIONS).toEqual({
      enabled: false,
      dir: './workflows',
      path: '~/.vessel/workflows',
      maxParallel: 2,
      stepTimeoutMs: 300000,
    });
    expect(DEFAULT_EVALS_OPTIONS).toEqual({
      enabled: false,
      dir: './evals',
      outDir: '~/.vessel/evals',
      allowNetwork: false,
    });
    expect(DEFAULT_FEISHU_OPTIONS).toEqual({
      enabled: false,
      appId: '',
      appSecret: '',
      appSecretEnv: '',
      domain: 'feishu',
      allowedChatIds: [],
      sessionPrefix: 'feishu',
      replyTimeoutMs: 300000,
      maxReplyChars: 4000,
      maxMembers: 8,
    });
    expect(DEFAULT_OBSERVABILITY_OPTIONS).toEqual({
      eventHistory: 1000,
      metrics: true,
    });
  });

  it('absent blocks keep 0.3 behavior (undefined, zero errors)', () => {
    const config: VesselConfig = {};
    expect(validateConfig(config).errors).toEqual([]);
    expect(config.workflow).toBeUndefined();
    expect(config.evals).toBeUndefined();
    expect(config.feishu).toBeUndefined();
    expect(config.observability).toBeUndefined();
  });
});

describe('0.4 snake_case to camelCase', () => {
  it('maps every new key', () => {
    const parsed = snakeToCamel<Record<string, unknown>>({
      workflow: { max_parallel: 3, step_timeout_ms: 1000 },
      evals: { out_dir: '/tmp/out', allow_network: true },
      feishu: {
        app_id: 'cli_xxx',
        app_secret: 'secret',
        allowed_chat_ids: ['oc_1'],
        session_prefix: 'feishu',
        reply_timeout_ms: 1000,
        max_reply_chars: 10,
        max_members: 4,
      },
      observability: { event_history: 5, metrics: false },
    });

    expect(parsed).toEqual({
      workflow: { maxParallel: 3, stepTimeoutMs: 1000 },
      evals: { outDir: '/tmp/out', allowNetwork: true },
      feishu: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        allowedChatIds: ['oc_1'],
        sessionPrefix: 'feishu',
        replyTimeoutMs: 1000,
        maxReplyChars: 10,
        maxMembers: 4,
      },
      observability: { eventHistory: 5, metrics: false },
    });
  });
});

describe('0.4 workflow validation', () => {
  it('accepts boundaries 1..8 and 1..86400000', () => {
    expect(
      pathsOf({
        workflow: { maxParallel: 1, stepTimeoutMs: 1 },
      }),
    ).toEqual([]);
    expect(
      pathsOf({
        workflow: { maxParallel: 8, stepTimeoutMs: 86400000 },
      }),
    ).toEqual([]);
  });

  it('rejects wrong types and out-of-range values', () => {
    const paths = pathsOf({
      workflow: {
        enabled: 'yes' as unknown as boolean,
        dir: '',
        path: '   ',
        maxParallel: 9,
        stepTimeoutMs: 0,
      },
    });
    expect(paths).toContain('workflow.enabled');
    expect(paths).toContain('workflow.dir');
    expect(paths).toContain('workflow.path');
    expect(paths).toContain('workflow.maxParallel');
    expect(paths).toContain('workflow.stepTimeoutMs');

    expect(pathsOf({ workflow: { maxParallel: 0 } })).toContain('workflow.maxParallel');
    expect(pathsOf({ workflow: { maxParallel: 1.5 } })).toContain('workflow.maxParallel');
    expect(pathsOf({ workflow: { stepTimeoutMs: 86400001 } })).toContain('workflow.stepTimeoutMs');
  });
});

describe('0.4 evals validation', () => {
  it('rejects wrong types and empty paths', () => {
    const paths = pathsOf({
      evals: {
        enabled: 'yes' as unknown as boolean,
        dir: '',
        outDir: ' ',
        allowNetwork: 'yes' as unknown as boolean,
      },
    });
    expect(paths).toContain('evals.enabled');
    expect(paths).toContain('evals.dir');
    expect(paths).toContain('evals.outDir');
    expect(paths).toContain('evals.allowNetwork');
  });

  it('accepts a valid block', () => {
    expect(
      pathsOf({
        evals: { enabled: true, dir: './evals', outDir: '~/.vessel/evals', allowNetwork: true },
      }),
    ).toEqual([]);
  });
});

describe('0.4 feishu validation', () => {
  it('rejects wrong types and out-of-range values', () => {
    const paths = pathsOf({
      feishu: {
        enabled: 'yes' as unknown as boolean,
        appId: 1 as unknown as string,
        appSecret: 2 as unknown as string,
        domain: 'wechat' as unknown as 'feishu',
        allowedChatIds: ['ok', ''] as string[],
        sessionPrefix: 'a:b',
        replyTimeoutMs: 0,
        maxReplyChars: 100001,
        maxMembers: 65,
      },
    });
    expect(paths).toContain('feishu.enabled');
    expect(paths).toContain('feishu.appId');
    expect(paths).toContain('feishu.appSecret');
    expect(paths).toContain('feishu.domain');
    expect(paths).toContain('feishu.allowedChatIds');
    expect(paths).toContain('feishu.sessionPrefix');
    expect(paths).toContain('feishu.replyTimeoutMs');
    expect(paths).toContain('feishu.maxReplyChars');
    expect(paths).toContain('feishu.maxMembers');
  });

  it('rejects path separators and whitespace in session_prefix', () => {
    for (const sessionPrefix of ['', ' ', 'a b', 'a/b', 'a\\b', 'a:b']) {
      expect(pathsOf({ feishu: { sessionPrefix } })).toContain('feishu.sessionPrefix');
    }
  });

  it('max_members default range is 1..64', () => {
    expect(pathsOf({ feishu: { maxMembers: 1 } })).toEqual([]);
    expect(pathsOf({ feishu: { maxMembers: 64 } })).toEqual([]);
    expect(pathsOf({ feishu: { maxMembers: 0 } })).toContain('feishu.maxMembers');
    expect(pathsOf({ feishu: { maxMembers: 1.5 } })).toContain('feishu.maxMembers');
  });

  it('enabled requires app id and secret after env merge', () => {
    const result = validateConfig({
      feishu: { enabled: true, appId: '', appSecret: '' },
    });
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain('feishu.appId');
    expect(paths).toContain('feishu.appSecret');
  });

  it('never puts the secret value into validation errors', () => {
    const secret = 'super-secret-value';
    const result = validateConfig({
      feishu: {
        enabled: true,
        appId: 'cli_xxx',
        appSecret: 123 as unknown as string,
      },
    });
    const secretError = result.errors.find((e) => e.path === 'feishu.appSecret');
    expect(secretError).toBeDefined();
    expect(secretError?.value).toBeUndefined();
    expect(JSON.stringify(result.errors)).not.toContain(secret);

    const missing = validateConfig({ feishu: { enabled: true, appId: 'cli_xxx' } });
    const missingError = missing.errors.find((e) => e.path === 'feishu.appSecret');
    expect(missingError?.value).toBeUndefined();
  });

  it('accepts enabled with both credentials', () => {
    expect(
      pathsOf({
        feishu: {
          enabled: true,
          appId: 'cli_xxx',
          appSecret: 'secret',
          domain: 'lark',
          allowedChatIds: ['oc_1'],
          sessionPrefix: 'feishu',
          replyTimeoutMs: 86400000,
          maxReplyChars: 100000,
          maxMembers: 8,
        },
      }),
    ).toEqual([]);
  });

  it('rejects the removed agent_id key as unknown', () => {
    const unknown = findUnknownNestedKeys({
      feishu: { agentId: 'owner' },
    });
    expect(unknown.map((u) => u.path)).toEqual(['feishu.agentId']);
    expect(unknown.map((u) => u.block)).toEqual(['feishu']);
  });
});

describe('0.4 observability validation', () => {
  it('accepts event_history >= 0', () => {
    expect(pathsOf({ observability: { eventHistory: 0 } })).toEqual([]);
    expect(pathsOf({ observability: { eventHistory: 1000 } })).toEqual([]);
  });

  it('rejects negative / fractional / non-boolean values', () => {
    expect(pathsOf({ observability: { eventHistory: -1 } })).toContain(
      'observability.eventHistory',
    );
    expect(pathsOf({ observability: { eventHistory: 1.5 } })).toContain(
      'observability.eventHistory',
    );
    expect(pathsOf({ observability: { eventHistory: 'x' as unknown as number } })).toContain(
      'observability.eventHistory',
    );
    expect(pathsOf({ observability: { metrics: 'yes' as unknown as boolean } })).toContain(
      'observability.metrics',
    );
  });
});

describe('0.4 unknown keys', () => {
  it('suggests the block name for a top-level typo', () => {
    const unknown = findUnknownKeys({ workfloww: {} }, KNOWN_CONFIG_KEYS);
    expect(unknown).toEqual(['workfloww']);
  });

  it('reports a nested typo with a full path', () => {
    const unknown = findUnknownNestedKeys({
      workflow: { maxParallels: 2 },
      evals: { outDirr: '/tmp' },
      feishu: { maxMemberss: 2 },
      observability: { eventHistoryy: 1 },
    });
    expect(unknown.map((u) => u.path)).toEqual([
      'workflow.maxParallels',
      'evals.outDirr',
      'feishu.maxMemberss',
      'observability.eventHistoryy',
    ]);
  });
});

describe('0.4 feishu env credentials', () => {
  it('loadConfigFromEnv maps FEISHU_APP_ID / FEISHU_APP_SECRET', () => {
    process.env.VESSEL_FEISHU_APP_ID = 'env-id';
    process.env.VESSEL_FEISHU_APP_SECRET = 'env-secret';

    const env = loadConfigFromEnv();
    expect(env.feishu).toEqual({ appId: 'env-id', appSecret: 'env-secret' });
  });

  it('empty env vars do not override file values', () => {
    process.env.VESSEL_FEISHU_APP_ID = '';
    process.env.VESSEL_FEISHU_APP_SECRET = '';

    const env = loadConfigFromEnv();
    expect(env.feishu).toBeUndefined();
  });

  it('env wins over file config and only one field set preserves the other', async () => {
    const configPath = tmpYaml(`
feishu:
  enabled: true
  app_id: file-id
  app_secret_env: FEISHU_FILE_SECRET
`);

    const { config, validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
      env: { VESSEL_FEISHU_APP_ID: 'env-id', FEISHU_FILE_SECRET: 'file-secret' },
    });

    expect(config.feishu?.appId).toBe('env-id');
    expect(config.feishu?.appSecret).toBe('file-secret');
    expect(validation.errors).toEqual([]);
  });

  it('project _env secret allows enabled=true without VESSEL_* env', async () => {
    const configPath = tmpYaml(`
feishu:
  enabled: true
  app_id: file-id
  app_secret_env: FEISHU_FILE_SECRET
`);
    const { config, validation } = await loadConfig({
      configPath,
      userConfigPath: missingPath(),
      env: { FEISHU_FILE_SECRET: 'file-secret' },
    });

    expect(config.feishu?.enabled).toBe(true);
    expect(validation.errors).toEqual([]);
  });
});

describe('0.4 FeishuConfig type has no agentId', () => {
  it('agentId is not part of the public config type', () => {
    const feishu: FeishuConfig = {
      enabled: false,
      appId: '',
      appSecret: '',
      appSecretEnv: '',
      domain: 'feishu',
      allowedChatIds: [],
      sessionPrefix: 'feishu',
      replyTimeoutMs: 300000,
      maxReplyChars: 4000,
      maxMembers: 8,
    };
    expect(Object.keys(feishu)).not.toContain('agentId');
  });
});
