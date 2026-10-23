import { describe, expect, test } from 'bun:test';
import {
  applyPaneResize,
  chatWorkspaceWidth,
  clampPane,
  DEFAULT_PANE_LAYOUT,
  fitChatWidth,
  parsePaneLayout,
} from '../src/app/usePaneResize';

describe('applyPaneResize', () => {
  test('chat takes 2x delta because both edges move; nav and sessions take 1x', () => {
    expect(applyPaneResize('chat', 860, 100)).toBe(1060);
    expect(applyPaneResize('chat', 860, -100)).toBe(660);
    expect(applyPaneResize('nav', 256, 100)).toBe(356);
    expect(applyPaneResize('nav', 256, -50)).toBe(206);
    expect(applyPaneResize('sessions', 280, 40)).toBe(320);
    expect(applyPaneResize('sessions', 280, -40)).toBe(240);
  });

  test('clamps at the bounds instead of crossing them', () => {
    expect(applyPaneResize('chat', 860, 10_000)).toBe(1200);
    expect(applyPaneResize('chat', 860, -10_000)).toBe(560);
    expect(applyPaneResize('nav', 256, 10_000)).toBe(360);
    expect(applyPaneResize('nav', 256, -10_000)).toBe(200);
    expect(applyPaneResize('sessions', 280, 10_000)).toBe(420);
    expect(applyPaneResize('sessions', 280, -10_000)).toBe(220);
  });
});

describe('clampPane', () => {
  test('keeps in-range values and clamps out-of-range ones', () => {
    expect(clampPane('nav', 256)).toBe(256);
    expect(clampPane('sessions', 200)).toBe(220);
    expect(clampPane('chat', 2000)).toBe(1200);
  });
});

describe('fitChatWidth', () => {
  test('shrinks to the workspace left after nav/sessions and restores when the window widens', () => {
    // 900 - 256 - 280 - 48 = 316，低于下限时保持 560，避免手柄进入不可用区。
    expect(chatWorkspaceWidth(900, 256, 280)).toBe(560);
    expect(fitChatWidth(860, 900, 256, 280)).toBe(560);
    // 1400 - 256 - 280 - 48 = 816：持久化的 1200 只显示为 816。
    expect(chatWorkspaceWidth(1400, 256, 280)).toBe(816);
    expect(fitChatWidth(1200, 1400, 256, 280)).toBe(816);
    // 宽窗口恢复持久化值；超过上限仍受 1200 约束。
    expect(fitChatWidth(860, 1920, 256, 280)).toBe(860);
    expect(fitChatWidth(2000, 1920, 256, 280)).toBe(1200);
  });
});

describe('parsePaneLayout', () => {
  test('falls back to defaults for missing raw or invalid JSON', () => {
    expect(parsePaneLayout(null)).toEqual(DEFAULT_PANE_LAYOUT);
    expect(parsePaneLayout(undefined)).toEqual(DEFAULT_PANE_LAYOUT);
    expect(parsePaneLayout('')).toEqual(DEFAULT_PANE_LAYOUT);
    expect(parsePaneLayout('not json')).toEqual(DEFAULT_PANE_LAYOUT);
    expect(parsePaneLayout('null')).toEqual(DEFAULT_PANE_LAYOUT);
    expect(parsePaneLayout('[]')).toEqual(DEFAULT_PANE_LAYOUT);
  });

  test('falls back per field for missing, non-numeric or non-finite values', () => {
    expect(parsePaneLayout('{"chat":700}')).toEqual({ ...DEFAULT_PANE_LAYOUT, chat: 700 });
    expect(parsePaneLayout('{"nav":"260","sessions":null,"chat":700}')).toEqual({
      nav: DEFAULT_PANE_LAYOUT.nav,
      sessions: DEFAULT_PANE_LAYOUT.sessions,
      chat: 700,
    });
    // JSON.parse('1e999') === Infinity：必须按非有限数回退。
    expect(parsePaneLayout('{"nav":1e999,"chat":1e999}')).toEqual(DEFAULT_PANE_LAYOUT);
  });

  test('clamps stored out-of-range values per pane', () => {
    expect(parsePaneLayout('{"nav":9999,"sessions":1,"chat":-1}')).toEqual({
      nav: 360,
      sessions: 220,
      chat: 560,
    });
  });
});
