/**
 * 0.16 agent 工具配置：YAML 映射与非法值拒绝。
 *
 * 故障形态：`default_visibility` / `follow_replies` / `legacy_tools` 拼写错误或
 * 非法值被静默忽略，装配层按默认值注册了错误的工具面。
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/index';

function tmpYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-agent-cfg-'));
  const file = path.join(dir, 'vessel.yaml');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function missingPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-agent-missing-'));
  return path.join(dir, 'does-not-exist.yaml');
}

describe('agent tool config', () => {
  it('maps snake_case keys and accepts valid values', async () => {
    const { config, validation } = await loadConfig({
      configPath: tmpYaml(
        [
          'agent:',
          '  enabled: true',
          '  default_visibility: team',
          '  follow_replies: true',
          'team:',
          '  legacy_tools: false',
        ].join('\n'),
      ),
      userConfigPath: missingPath(),
      env: {},
    });
    expect(config.agent?.enabled).toBe(true);
    expect(config.agent?.defaultVisibility).toBe('team');
    expect(config.agent?.followReplies).toBe(true);
    expect(config.team?.legacyTools).toBe(false);
    expect(validation.errors).toEqual([]);
  });

  it('rejects an unknown visibility instead of falling back to private', async () => {
    const { validation } = await loadConfig({
      configPath: tmpYaml('agent:\n  default_visibility: public\n'),
      userConfigPath: missingPath(),
      env: {},
    });
    expect(validation.errors.some((error) => error.path === 'agent.defaultVisibility')).toBe(true);
  });

  it('rejects non-boolean enabled / follow_replies / legacy_tools', async () => {
    for (const [yaml, expected] of [
      ['agent:\n  enabled: maybe\n', 'agent.enabled'],
      ['agent:\n  follow_replies: always\n', 'agent.followReplies'],
      ['team:\n  legacy_tools: sometimes\n', 'team.legacyTools'],
    ] as const) {
      const { validation } = await loadConfig({
        configPath: tmpYaml(yaml),
        userConfigPath: missingPath(),
        env: {},
      });
      expect(validation.errors.some((error) => error.path === expected)).toBe(true);
    }
  });

  it('rejects a misspelled agent sub-key', async () => {
    const { validation } = await loadConfig({
      configPath: tmpYaml('agent:\n  follow_reply: true\n'),
      userConfigPath: missingPath(),
      env: {},
    });
    expect(validation.errors.some((error) => error.path === 'agent.followReply')).toBe(true);
  });
});
