#!/usr/bin/env bun

/**
 * 配置来源与优先级矩阵检查（0.5；0.49 T4 更新）。
 *
 * 通过真实 CLI 运行 `vessel config show --sources --json`，在临时 HOME /
 * 项目目录中验证：
 *   env > project > user > default
 *   `_env` 三态：显式值 / env 可用 / env 缺失报错
 *   项目 YAML 出现密钥 -> exit 1
 *   0.49 T4（R4）：旧 tenant 块 / token tenantId / adminToken 启动 fail-fast，
 *   错误逐项列出键与修复提示（不自动降级）
 *
 * 用法：bun run scripts/check-config-sources.ts
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Snapshot {
  config: Record<string, unknown>;
  sources: Record<string, string>;
}

interface CaseOptions {
  user?: string;
  project?: string;
  env?: Record<string, string>;
  args?: string[];
}

interface CaseResult {
  exitCode: number;
  snapshot?: Snapshot;
  stderr: string;
}

function cleanEnv(home: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('VESSEL_')) continue;
    if (key === 'HOME' || key === 'USERPROFILE') continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  Object.assign(env, extra);
  return env;
}

async function runShow(root: string, options: CaseOptions): Promise<CaseResult> {
  const base = await mkdtemp(join(tmpdir(), 'vessel-config-'));
  const home = join(base, 'home');
  const project = join(base, 'project');
  await mkdir(join(home, '.vessel'), { recursive: true });
  await mkdir(project, { recursive: true });

  if (options.user !== undefined) {
    await writeFile(join(home, '.vessel', 'config.yaml'), options.user);
  }
  if (options.project !== undefined) {
    await writeFile(join(project, 'vessel.yaml'), options.project);
  }

  try {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        join(root, 'src/cli.ts'),
        'config',
        'show',
        '--sources',
        '--json',
        ...(options.args ?? []),
      ],
      cwd: project,
      env: cleanEnv(home, options.env ?? {}),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return { exitCode, stderr };
    try {
      return { exitCode, snapshot: JSON.parse(stdout) as Snapshot, stderr };
    } catch {
      return { exitCode, stderr: `invalid JSON: ${stdout.slice(0, 200)}` };
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function sourceOf(snapshot: Snapshot, path: string): string | undefined {
  return snapshot.sources[path];
}

function nested(config: Record<string, unknown>, path: string): unknown {
  let current: unknown = config;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function expectEqual(issues: string[], label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    issues.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function checkConfigSources(root: string): Promise<string[]> {
  const issues: string[] = [];

  const user = await runShow(root, {
    user: 'data_dir: /tmp/user-data\nprovider:\n  model: user-model\n',
  });
  if (user.snapshot === undefined) {
    issues.push(`user case failed: ${user.stderr}`);
  } else {
    expectEqual(issues, 'user data_dir source', sourceOf(user.snapshot, 'dataDir'), 'user');
    expectEqual(
      issues,
      'user provider.model source',
      sourceOf(user.snapshot, 'provider.model'),
      'user',
    );
    expectEqual(
      issues,
      'user data_dir value',
      nested(user.snapshot.config, 'dataDir'),
      '/tmp/user-data',
    );
  }

  const project = await runShow(root, {
    user: 'data_dir: /tmp/user-data\nprovider:\n  model: user-model\n',
    project: 'data_dir: /tmp/project-data\nprovider:\n  model: project-model\n',
  });
  if (project.snapshot === undefined) {
    issues.push(`project case failed: ${project.stderr}`);
  } else {
    expectEqual(
      issues,
      'project data_dir source',
      sourceOf(project.snapshot, 'dataDir'),
      'project',
    );
    expectEqual(
      issues,
      'project provider.model source',
      sourceOf(project.snapshot, 'provider.model'),
      'project',
    );
    expectEqual(
      issues,
      'project data_dir value',
      nested(project.snapshot.config, 'dataDir'),
      '/tmp/project-data',
    );
  }

  const env = await runShow(root, {
    user: 'data_dir: /tmp/user-data\nprovider:\n  model: user-model\n',
    project: 'data_dir: /tmp/project-data\nprovider:\n  model: project-model\n',
    env: { VESSEL_DATA_DIR: '/tmp/env-data', VESSEL_MODEL: 'env-model' },
  });
  if (env.snapshot === undefined) {
    issues.push(`env case failed: ${env.stderr}`);
  } else {
    expectEqual(issues, 'env data_dir source', sourceOf(env.snapshot, 'dataDir'), 'env');
    expectEqual(
      issues,
      'env provider.model source',
      sourceOf(env.snapshot, 'provider.model'),
      'env',
    );
    expectEqual(
      issues,
      'env data_dir value',
      nested(env.snapshot.config, 'dataDir'),
      '/tmp/env-data',
    );
  }

  // 0.49 T4：serve.tokens 仍接受，但条目只允许 role。
  const tokenEntry = await runShow(root, {
    user: 'serve:\n  tokens:\n    client-token:\n      role: admin\n',
  });
  if (tokenEntry.snapshot === undefined) {
    issues.push(`serve.tokens role case failed: ${tokenEntry.stderr}`);
  } else {
    expectEqual(
      issues,
      'serve.tokens role value',
      nested(tokenEntry.snapshot.config, 'serve.tokens.<set>.role'),
      'admin',
    );
  }

  const envSet = await runShow(root, {
    user: 'provider:\n  api_key_env: MY_KEY\n',
    env: { MY_KEY: 'sk-test-secret' },
  });
  if (envSet.snapshot === undefined) {
    issues.push(`_env set case failed: ${envSet.stderr}`);
  } else {
    expectEqual(
      issues,
      '_env set provider.apiKey',
      nested(envSet.snapshot.config, 'provider.apiKey'),
      '<set>',
    );
  }

  const envMissing = await runShow(root, {
    user: 'provider:\n  api_key_env: MISSING_KEY\n',
  });
  if (envMissing.exitCode === 0) {
    issues.push('_env missing case should exit 1');
  } else if (!envMissing.stderr.includes('MISSING_KEY')) {
    issues.push(`_env missing case stderr should mention MISSING_KEY: ${envMissing.stderr}`);
  }

  const explicitWins = await runShow(root, {
    user: 'provider:\n  apiKey: explicit-key\n  api_key_env: MY_KEY\n',
    env: { MY_KEY: 'sk-test-secret' },
  });
  if (explicitWins.snapshot === undefined) {
    issues.push(`explicit over _env case failed: ${explicitWins.stderr}`);
  } else {
    expectEqual(
      issues,
      'explicit provider.apiKey source',
      sourceOf(explicitWins.snapshot, 'provider.apiKey'),
      // 0.10 sources 脱敏：`*.apiKey` 的来源值也显示 `<set>`，不再暴露来源层。
      '<set>',
    );
    expectEqual(
      issues,
      'explicit provider.apiKey value',
      nested(explicitWins.snapshot.config, 'provider.apiKey'),
      '<set>',
    );
  }

  const projectSecret = await runShow(root, {
    project: 'provider:\n  apiKey: should-not-be-here\n',
  });
  if (projectSecret.exitCode === 0) {
    issues.push('project secret case should exit 1');
  }

  // 0.49 T4（R4）：旧 `tenant:` 块启动 fail-fast，逐项给修复提示。
  const oldTenantBlock = await runShow(root, {
    user: 'tenant:\n  default: acme\n',
  });
  if (oldTenantBlock.exitCode === 0) {
    issues.push('tenant block case should exit 1 (R4 fail-fast)');
  } else {
    for (const expected of ['tenant', 'removed in 0.49', 'Fix: delete']) {
      if (!oldTenantBlock.stderr.includes(expected)) {
        issues.push(
          `tenant block stderr should include ${JSON.stringify(expected)}: ${oldTenantBlock.stderr}`,
        );
      }
    }
  }

  // 0.49 T4（R4）：serve.tokens[*].tenantId 启动 fail-fast，错误不回显 token。
  const oldTokenTenant = await runShow(root, {
    user: [
      'serve:',
      '  tokens:',
      '    client-token:',
      '      role: admin',
      '      tenant_id: acme',
      '',
    ].join('\n'),
  });
  if (oldTokenTenant.exitCode === 0) {
    issues.push('serve.tokens tenantId case should exit 1 (R4 fail-fast)');
  } else {
    for (const expected of ['serve.tokens.<entry#1>.tenantId', 'Fix: delete the tenantId']) {
      if (!oldTokenTenant.stderr.includes(expected)) {
        issues.push(
          `serve.tokens tenantId stderr should include ${JSON.stringify(expected)}: ${oldTokenTenant.stderr}`,
        );
      }
    }
    if (oldTokenTenant.stderr.includes('client-token')) {
      issues.push('serve.tokens tenantId error must not echo the token key');
    }
  }

  // 0.49 T4（R4）：adminToken / adminTokenEnv 启动 fail-fast。
  const oldAdminToken = await runShow(root, {
    user: 'serve:\n  admin_token: legacy-admin\n',
  });
  if (oldAdminToken.exitCode === 0) {
    issues.push('serve.adminToken case should exit 1 (R4 fail-fast)');
  } else if (!oldAdminToken.stderr.includes('serve.adminToken')) {
    issues.push(`serve.adminToken stderr should mention the key: ${oldAdminToken.stderr}`);
  }

  // VESSEL_TENANT 不再参与解析：设置它不会改变解析结果或触发 tenant 警告。
  const envTenant = await runShow(root, {
    env: { VESSEL_TENANT: 'env-tenant' },
  });
  if (envTenant.snapshot === undefined) {
    issues.push(`VESSEL_TENANT ignored case failed: ${envTenant.stderr}`);
  } else if (envTenant.stderr.includes('env-tenant')) {
    issues.push(`VESSEL_TENANT should not be parsed anymore: ${envTenant.stderr}`);
  }

  return issues;
}

async function main(): Promise<void> {
  const issues = await checkConfigSources(process.cwd());
  if (issues.length === 0) {
    console.log('config sources check passed');
    return;
  }

  console.error(`config sources check failed: ${issues.length} issue(s)`);
  for (const issue of issues) console.error(`  ${issue}`);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
