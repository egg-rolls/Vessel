import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  initialEnabledIndex,
  nextEnabledIndex,
  Select,
  type SelectOptionItem,
  selectOptionsFromChildren,
} from '../src/components/ui/Field';

function item(value: string, disabled = false): SelectOptionItem {
  return { key: value, value, label: value, text: value, disabled };
}

describe('selectOptionsFromChildren', () => {
  test('reads option values, labels and disabled state, flattening arrays and false', () => {
    const options = selectOptionsFromChildren(
      <>
        <option value="a">Alpha</option>
        {false}
        {[
          <option key="b" value="b" disabled>
            Beta
          </option>,
        ]}
        <option>Gamma</option>
      </>,
    );
    expect(options.map((option) => [option.value, option.text, option.disabled])).toEqual([
      ['a', 'Alpha', false],
      ['b', 'Beta', true],
      ['Gamma', 'Gamma', false],
    ]);
  });

  test('ignores non-option children', () => {
    expect(selectOptionsFromChildren([<span key="x">nope</span>, null])).toEqual([]);
  });
});

describe('keyboard index helpers', () => {
  const options = [item('a'), item('b', true), item('c'), item('d', true)];

  test('moves in both directions and skips disabled options', () => {
    expect(nextEnabledIndex(options, -1, 1)).toBe(0);
    expect(nextEnabledIndex(options, 0, 1)).toBe(2);
    expect(nextEnabledIndex(options, 2, 1)).toBe(0);
    expect(nextEnabledIndex(options, 0, -1)).toBe(2);
    expect(nextEnabledIndex(options, 2, -1)).toBe(0);
  });

  test('returns -1 when every option is disabled', () => {
    expect(nextEnabledIndex([item('a', true)], 0, 1)).toBe(-1);
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
  });

  test('opens on the selected option, falling back to the first enabled one', () => {
    expect(initialEnabledIndex(options, 'c')).toBe(2);
    expect(initialEnabledIndex(options, 'b')).toBe(0);
    expect(initialEnabledIndex(options, 'missing')).toBe(0);
  });
});

describe('Select markup', () => {
  test('renders a combobox trigger with the selected label and no native listbox', () => {
    const markup = renderToStaticMarkup(
      <Select id="pick" value="b" aria-label="Pick one" onChange={() => undefined}>
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </Select>,
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="pick"');
    expect(markup).toContain('aria-label="Pick one"');
    expect(markup).toContain('>Beta</span>');
    expect(markup).not.toContain('Alpha');
    expect(markup).not.toContain('role="listbox"');
    expect(markup).not.toContain('<select');
  });

  test('keeps disabled and invalid state on the trigger', () => {
    const markup = renderToStaticMarkup(
      <Select value="a" disabled invalid>
        <option value="a">Alpha</option>
      </Select>,
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('bg-danger-soft');
  });
});
