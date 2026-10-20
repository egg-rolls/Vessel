import { describe, expect, test } from 'bun:test';
import {
  describeGatewayError,
  describeGatewayErrorText,
  gatewayErrorCode,
} from '../src/gateway/errors';

describe('describeGatewayError', () => {
  test('maps common gateway codes to actionable hints', () => {
    expect(describeGatewayError('unauthorized')).toContain('token');
    expect(describeGatewayError('forbidden')).toContain('权限');
    expect(describeGatewayError('quota_exceeded')).toContain('配额');
    expect(describeGatewayError('tenant_locked')).toContain('tenant');
    expect(describeGatewayError('unsupported_protocol')).toContain('协议');
  });

  test('returns null for unknown or missing codes instead of inventing text', () => {
    expect(describeGatewayError('some_new_code')).toBeNull();
    expect(describeGatewayError(undefined)).toBeNull();
    expect(describeGatewayError('')).toBeNull();
  });
});

describe('gatewayErrorCode', () => {
  test('extracts a stable code prefix from server error text', () => {
    expect(gatewayErrorCode('forbidden: tenant b is not allowed')).toBe('forbidden');
    expect(gatewayErrorCode('  timeout: upstream\nsecond line')).toBe('timeout');
  });

  test('does not treat arbitrary sentences as codes', () => {
    expect(gatewayErrorCode('Something failed: because')).toBeNull();
    expect(gatewayErrorCode('UPPER: nope')).toBeNull();
    expect(gatewayErrorCode(null)).toBeNull();
  });
});

describe('describeGatewayErrorText', () => {
  test('combines code extraction with the shared mapping', () => {
    expect(describeGatewayErrorText('conflict: run is already running')).toContain('冲突');
    expect(describeGatewayErrorText('plain failure')).toBeNull();
  });
});
