import { describe, expect, test } from 'bun:test';
import { gatewayNodeName, uptimeParts } from '../src/domains/gateway/gateway-state';

describe('gatewayNodeName', () => {
  test('prefers the additive display name, then falls back to node_id', () => {
    expect(gatewayNodeName({ name: ' office-gw ', node_id: 'node-1' })).toBe('office-gw');
    expect(gatewayNodeName({ name: '   ', node_id: 'node-1' })).toBe('node-1');
    expect(gatewayNodeName({ node_id: ' node-1 ' })).toBe('node-1');
    expect(gatewayNodeName({})).toBe('—');
    expect(gatewayNodeName(undefined)).toBe('—');
  });
});

describe('uptimeParts', () => {
  const now = 1_700_000_000_000;

  test('picks a coarse unit and reports the remainder', () => {
    expect(uptimeParts(undefined, now)).toBeNull();
    expect(uptimeParts(now + 1_000, now)).toBeNull();
    expect(uptimeParts(now - 5_000, now)).toEqual({
      key: 'duration.seconds',
      params: { seconds: 5 },
    });
    expect(uptimeParts(now - 90_000, now)).toEqual({
      key: 'duration.minutes',
      params: { minutes: 1 },
    });
    expect(uptimeParts(now - 3 * 3_600_000, now)).toEqual({
      key: 'duration.hours',
      params: { hours: 3 },
    });
    expect(uptimeParts(now - (3 * 3_600_000 + 5 * 60_000), now)).toEqual({
      key: 'duration.hoursMinutes',
      params: { hours: 3, minutes: 5 },
    });
    expect(uptimeParts(now - (2 * 86_400_000 + 4 * 3_600_000), now)).toEqual({
      key: 'duration.daysHours',
      params: { days: 2, hours: 4 },
    });
  });
});
