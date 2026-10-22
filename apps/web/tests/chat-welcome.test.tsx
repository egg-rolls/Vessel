import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatWelcome } from '../src/domains/chat/ChatWelcome';
import { setLocale } from '../src/i18n';

beforeEach(() => {
  setLocale('zh-CN');
});

afterEach(() => {
  setLocale('zh-CN');
});

describe('ChatWelcome (SSR)', () => {
  test('draft welcome renders the brand hero without an empty-state card', () => {
    const markup = renderToStaticMarkup(<ChatWelcome />);

    expect(markup).toContain('chat-welcome');
    expect(markup).toContain('chat-welcome-brand');
    expect(markup).toContain('Vessel');
    expect(markup).toContain('今天想干啥？');
    // 背景式 hero：不是空态卡片，也不渲染示例 prompt 按钮。
    expect(markup).not.toContain('state-empty');
    expect(markup).not.toContain('example-prompt');
    expect(markup).not.toContain('解释这个仓库的结构');
  });

  test('welcome question follows the locale', () => {
    setLocale('en');
    const markup = renderToStaticMarkup(<ChatWelcome />);

    expect(markup).toContain('What do you want to do today?');
  });
});
