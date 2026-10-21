import { describe, expect, test } from 'bun:test';
import {
  DISPLAY_SETTINGS,
  displaySettingFor,
  isDisplaySettingKey,
  readDisplayValue,
  toConfigValue,
} from '../src/state/display-settings';

describe('display settings whitelist', () => {
  test('only exposes keys the server can write', () => {
    expect(isDisplaySettingKey('ui.verbosity')).toBe(true);
    expect(isDisplaySettingKey('ui.askUser')).toBe(true);
    expect(isDisplaySettingKey('provider.apiKey')).toBe(false);
    expect(DISPLAY_SETTINGS.some((setting) => setting.key === 'ui.errorLevel')).toBe(true);
  });

  test('reads camelCase and snake_case config values', () => {
    expect(readDisplayValue({ config: { ui: { verbosity: 'debug' } } }, 'ui.verbosity')).toBe(
      'debug',
    );
    expect(
      readDisplayValue({ config: { ui: { show_internal_events: true } } }, 'ui.showInternalEvents'),
    ).toBe('true');
    expect(
      readDisplayValue(
        { config: { observability: { show_process_errors: true } } },
        'observability.showProcessErrors',
      ),
    ).toBe('true');
    expect(readDisplayValue({ config: {} }, 'ui.verbosity')).toBe('');
  });

  test('converts typed values and rejects invalid options', () => {
    const verbosity = displaySettingFor('ui.verbosity');
    const askUser = displaySettingFor('ui.askUser');
    if (!verbosity || !askUser) throw new Error('missing settings');
    expect(toConfigValue(verbosity, 'minimal')).toBe('minimal');
    expect(toConfigValue(verbosity, 'loud')).toBeUndefined();
    expect(toConfigValue(askUser, 'false')).toBe(false);
    expect(toConfigValue(askUser, 'maybe')).toBeUndefined();
  });
});
