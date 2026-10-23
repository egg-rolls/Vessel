import { afterEach, describe, expect, test } from 'bun:test';
import { setLocale, t } from '../src/i18n';
import { messages as en } from '../src/i18n/messages/en';
import { messages as zhCN } from '../src/i18n/messages/zh-CN';

const TEAM_KEYS = Object.keys(zhCN).filter(
  (key) =>
    key.startsWith('team.') || key === 'nav.domain.team' || key.startsWith('breadcrumb.team'),
);

const ERROR_CODES = [
  'agent_left',
  'resume_failed',
  'not_visible',
  'not_found',
  'invalid_params',
  'body_not_active',
];

afterEach(() => setLocale('zh-CN'));

describe('Team i18n catalog', () => {
  test('zh-CN and en expose the same Team key set', () => {
    const enTeamKeys = Object.keys(en).filter(
      (key) =>
        key.startsWith('team.') || key === 'nav.domain.team' || key.startsWith('breadcrumb.team'),
    );
    expect(TEAM_KEYS.length).toBeGreaterThan(0);
    expect(enTeamKeys.sort()).toEqual([...TEAM_KEYS].sort());
  });

  test('every Team message is a non-empty string in both catalogs', () => {
    for (const key of TEAM_KEYS) {
      const zh = zhCN[key as keyof typeof zhCN];
      const english = en[key as keyof typeof en];
      expect(typeof zh).toBe('string');
      expect(zh.trim().length).toBeGreaterThan(0);
      expect(typeof english).toBe('string');
      expect(english.trim().length).toBeGreaterThan(0);
    }
  });

  test('interpolates placeholders in both locales', () => {
    setLocale('zh-CN');
    expect(t('team.list.memberCount', { count: 3 })).toBe('3 成员');
    expect(t('team.chat.historyLimited', { count: 100, limit: 1000 })).toBe(
      '仅显示最近 100 条（上限 1000）',
    );
    expect(t('team.mention.remove', { name: 'Ada' })).toBe('移除 Ada');
    expect(t('team.member.startedAt', { time: '10:00' })).toBe('开始 10:00');

    setLocale('en');
    expect(t('team.list.memberCount', { count: 3 })).toBe('3 members');
    expect(t('team.chat.historyLimited', { count: 100, limit: 1000 })).toBe(
      'Showing the latest 100 messages (max 1000)',
    );
    expect(t('team.mention.remove', { name: 'Ada' })).toBe('Remove Ada');
    expect(t('team.member.startedAt', { time: '10:00' })).toBe('Started 10:00');
  });

  test('keeps technical terms and error codes untranslated', () => {
    expect(zhCN['team.message.agentTag']).toBe('agent');
    expect(en['team.message.agentTag']).toBe('agent');
    expect(zhCN['team.list.workspace']).toBe('workspace');
    expect(en['team.list.workspace']).toBe('workspace');
    expect(zhCN['team.member.currentBody']).toContain('Body');
    expect(en['team.member.currentBody']).toContain('Body');
    expect(zhCN['team.member.epoch']).toContain('epoch');
    expect(en['team.member.epoch']).toContain('epoch');
    expect(zhCN['team.member.session']).toContain('session');
    expect(en['team.member.session']).toContain('session');
    expect(zhCN['team.error.notEnabledReason']).toContain('gateway');
    expect(zhCN['team.error.notEnabledReason']).toContain('teams.*');
    expect(zhCN['team.mention.title']).toContain('@');
    expect(zhCN['team.composer.noMention']).toContain('@');
    expect(zhCN['team.composer.hint']).toContain('Enter');
  });

  test('does not add error codes as catalog entries', () => {
    const zhValues = Object.values(zhCN);
    const enValues = Object.values(en);
    for (const code of ERROR_CODES) {
      expect(zhValues).not.toContain(code);
      expect(enValues).not.toContain(code);
    }
  });
});
