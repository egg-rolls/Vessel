import { afterAll, describe, expect, test } from 'bun:test';
import { DOMAINS, domainLabel, NAV_GROUPS, navGroupLabel } from '../src/app/nav';
import { gatewayNavStatus, hubNavStatus } from '../src/app/nav-status';
import { hubInfoFromConfig } from '../src/domains/hub/hub-state';
import { setLocale } from '../src/i18n';

afterAll(() => setLocale('zh-CN'));

function group(id: string) {
  return NAV_GROUPS.find((entry) => entry.id === id);
}

describe('0.25 navigation IA', () => {
  test('orchestration group runs Agents, Teams, Nodes in that order', () => {
    expect(group('network')?.domains).toEqual(['agents', 'teams', 'nodes']);
  });

  test('Status is the last group and holds Hub + Gateway', () => {
    expect(NAV_GROUPS.at(-1)?.id).toBe('status');
    expect(group('status')?.domains).toEqual(['hub', 'gateway']);
  });

  test('every primary domain is listed exactly once', () => {
    const listed = NAV_GROUPS.flatMap((entry) => entry.domains);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(listed)).toEqual(new Set(DOMAINS.map((entry) => entry.id)));
  });

  test('status group label follows the locale', () => {
    setLocale('zh-CN');
    expect(navGroupLabel('status')).toBe('状态');
    expect(navGroupLabel('network')).toBe('智能体编排');
    expect(domainLabel('hub')).toBe('面板核心');
    expect(domainLabel('gateway')).toBe('网关');
    setLocale('en');
    expect(navGroupLabel('status')).toBe('STATUS');
    expect(navGroupLabel('network')).toBe('ORCHESTRATION');
    expect(domainLabel('hub')).toBe('Hub');
    expect(domainLabel('gateway')).toBe('Gateway');
    setLocale('zh-CN');
  });
});

describe('Status group meta', () => {
  test('gateway tone follows the live connection state', () => {
    expect(gatewayNavStatus('open', true)).toMatchObject({ tone: 'ok' });
    expect(gatewayNavStatus('reconnecting', true)).toMatchObject({ tone: 'warn' });
    expect(gatewayNavStatus('error', true)).toMatchObject({ tone: 'danger' });
    expect(gatewayNavStatus('closed', false)).toMatchObject({ tone: 'muted' });
  });

  test('hub stays muted until the gateway is open and hub is enabled', () => {
    const open = gatewayNavStatus('open', true);
    const hub = hubInfoFromConfig({ hub: { listen: { hostname: '127.0.0.1', port: 0 } } });
    const connected = hubNavStatus(hub, open, true, '0.25.0');
    expect(connected).toEqual({
      tone: 'ok',
      labelKey: 'nav.status.hubLocal',
      version: '0.25.0',
    });

    const joined = hubNavStatus(
      hubInfoFromConfig({ hub: { direction: 'node', url: 'https://hub.example' } }),
      open,
      true,
    );
    expect(joined).toMatchObject({ tone: 'ok', labelKey: 'nav.status.hubJoined' });

    const disabled = hubNavStatus(hubInfoFromConfig({ hub: { autoStart: false } }), open, true);
    expect(disabled).toMatchObject({ tone: 'muted', labelKey: 'nav.status.hubNotConfigured' });

    const reconnecting = hubNavStatus(hub, gatewayNavStatus('reconnecting', true), true);
    expect(reconnecting).toMatchObject({ tone: 'warn', labelKey: 'nav.status.connecting' });

    // config 尚未返回时 hub 不能提前报绿。
    expect(hubNavStatus(undefined, open, true)).toMatchObject({
      tone: 'muted',
      labelKey: 'nav.status.unknown',
    });
  });
});
