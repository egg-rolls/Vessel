import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_OBSERVABILITY_OPTIONS,
  KNOWN_BLOCK_KEYS,
  type VesselConfig,
  validateConfig,
} from '../src/index';

describe('0.14 visibility config', () => {
  it('accepts all visibility values', () => {
    const config: VesselConfig = {
      ui: {
        verbosity: 'debug',
        showInternalEvents: true,
        errorLevel: 'all',
      },
      observability: { showProcessErrors: true },
    };
    const result = validateConfig(config);
    expect(result.errors).toEqual([]);
  });

  it('keeps defaults: fields absent, 0.13 behavior', () => {
    const config: VesselConfig = {};
    const result = validateConfig(config);
    expect(result.errors).toEqual([]);
    expect(config.ui).toBeUndefined();
    expect(config.observability).toBeUndefined();
    expect(DEFAULT_OBSERVABILITY_OPTIONS.showProcessErrors).toBe(false);
  });

  it('lists new keys as known', () => {
    expect(KNOWN_BLOCK_KEYS.ui).toContain('verbosity');
    expect(KNOWN_BLOCK_KEYS.ui).toContain('showInternalEvents');
    expect(KNOWN_BLOCK_KEYS.ui).toContain('errorLevel');
    expect(KNOWN_BLOCK_KEYS.observability).toContain('showProcessErrors');
  });

  it('rejects invalid enums and non-booleans', () => {
    const result = validateConfig({
      ui: {
        verbosity: 'verbose',
        showInternalEvents: 'yes',
        errorLevel: 'diagnostic',
      },
      observability: { showProcessErrors: 1 },
    } as unknown as VesselConfig);
    const paths = result.errors.map((error) => error.path);
    expect(paths).toContain('ui.verbosity');
    expect(paths).toContain('ui.showInternalEvents');
    expect(paths).toContain('ui.errorLevel');
    expect(paths).toContain('observability.showProcessErrors');
  });

  it('rejects unknown keys in ui / observability', () => {
    const result = validateConfig({
      ui: { verbosityLevel: 'debug' },
      observability: { showProcessError: true },
    } as unknown as VesselConfig);
    const paths = result.errors.map((error) => error.path);
    expect(paths).toContain('ui.verbosityLevel');
    expect(paths).toContain('observability.showProcessError');
  });

  it('accepts every enum value', () => {
    for (const verbosity of ['minimal', 'normal', 'debug'] as const) {
      expect(validateConfig({ ui: { verbosity } }).errors).toEqual([]);
    }
    for (const errorLevel of ['user', 'all'] as const) {
      expect(validateConfig({ ui: { errorLevel } }).errors).toEqual([]);
    }
  });
});
