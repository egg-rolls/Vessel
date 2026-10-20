import { describe, expect, test } from 'bun:test';
import {
  isEditableTarget,
  isEscape,
  isPaletteShortcut,
  isSlashPaletteShortcut,
} from '../src/app/shortcuts';

describe('isPaletteShortcut', () => {
  test('matches Ctrl+K and Cmd+K', () => {
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: 'K', metaKey: true })).toBe(true);
  });

  test('does not match plain k, Alt+K, or other keys', () => {
    expect(isPaletteShortcut({ key: 'k' })).toBe(false);
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, altKey: true })).toBe(false);
    expect(isPaletteShortcut({ key: 'j', ctrlKey: true })).toBe(false);
  });
});

describe('isSlashPaletteShortcut', () => {
  test('opens outside editable fields', () => {
    expect(isSlashPaletteShortcut({ key: '/', target: { tagName: 'DIV' } })).toBe(true);
    expect(isSlashPaletteShortcut({ key: '/' })).toBe(true);
  });

  test('does not steal "/" from inputs, textareas, selects, or contenteditable', () => {
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'textarea' },
      { tagName: 'SELECT' },
      { isContentEditable: true },
    ]) {
      expect(isSlashPaletteShortcut({ key: '/', target })).toBe(false);
    }
  });

  test('ignores modifier combinations', () => {
    expect(isSlashPaletteShortcut({ key: '/', ctrlKey: true })).toBe(false);
    expect(isSlashPaletteShortcut({ key: '/', metaKey: true })).toBe(false);
  });
});

describe('isEditableTarget / isEscape', () => {
  test('classifies editable targets', () => {
    expect(isEditableTarget({ tagName: 'input' })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget('input')).toBe(false);
  });

  test('detects Escape', () => {
    expect(isEscape({ key: 'Escape' })).toBe(true);
    expect(isEscape({ key: 'Esc' })).toBe(false);
  });
});
