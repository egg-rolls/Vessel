import { describe, expect, test } from 'bun:test';
import {
  resolveUiVisibility,
  showsInternalEvents,
  showsSuccessfulTools,
  showsTimeMetadata,
} from '../src/state/visibility';

describe('resolveUiVisibility', () => {
  test('reads ui.verbosity / showInternalEvents / errorLevel from the config payload', () => {
    const visibility = resolveUiVisibility({
      config: {
        ui: { verbosity: 'debug', showInternalEvents: true, errorLevel: 'all' },
      },
    });
    expect(visibility).toEqual({
      verbosity: 'debug',
      showInternalEvents: true,
      errorLevel: 'all',
    });
  });

  test('falls back to normal / hidden / user for missing or invalid values', () => {
    expect(resolveUiVisibility(null)).toEqual({
      verbosity: 'normal',
      showInternalEvents: false,
      errorLevel: 'user',
    });
    expect(resolveUiVisibility({ config: { ui: { verbosity: 'loud', errorLevel: 'x' } } })).toEqual(
      {
        verbosity: 'normal',
        showInternalEvents: false,
        errorLevel: 'user',
      },
    );
  });
});

describe('visibility derivation', () => {
  test('debug implies internal events even when the explicit flag is off', () => {
    expect(
      showsInternalEvents({ verbosity: 'debug', showInternalEvents: false, errorLevel: 'user' }),
    ).toBe(true);
    expect(
      showsInternalEvents({ verbosity: 'normal', showInternalEvents: true, errorLevel: 'user' }),
    ).toBe(true);
    expect(
      showsInternalEvents({ verbosity: 'normal', showInternalEvents: false, errorLevel: 'user' }),
    ).toBe(false);
  });

  test('minimal hides successful tools and time metadata; normal keeps them', () => {
    const minimal = resolveUiVisibility({ config: { ui: { verbosity: 'minimal' } } });
    expect(showsSuccessfulTools(minimal)).toBe(false);
    expect(showsTimeMetadata(minimal)).toBe(false);
    const normal = resolveUiVisibility(null);
    expect(showsSuccessfulTools(normal)).toBe(true);
    expect(showsTimeMetadata(normal)).toBe(true);
  });
});
