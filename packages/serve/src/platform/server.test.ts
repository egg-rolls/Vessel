/**
 * `session_required` 文案的测试。
 *
 * 这不是「文案好不好看」的测试，而是把两个**排障事实**钉住：
 * 1. 401 必须指到**当前这个来源**的 `/login`（会话 cookie 按 host 区分，
 *    在 127.0.0.1 与公网域名之间切换会丢会话）；
 * 2. 文案**不得**再承诺「本机直连可以免登录」—— 没配反代密钥时 `localDirect`
 *    恒为 false（`resolveRequestEdge` 的 `viaProxy`），承诺一个不成立的放行条件
 *    只会把排障带偏。
 *
 * @module @vessel-agent/serve/platform/server.test
 */

import { describe, expect, test } from 'bun:test';
import { sessionRequiredMessage } from './server.js';

describe('sessionRequiredMessage', () => {
  test('指到当前来源的 /login（可点击入口）', () => {
    const message = sessionRequiredMessage('http://127.0.0.1:8642');
    expect(message.startsWith('session_required: ')).toBe(true);
    expect(message).toContain('http://127.0.0.1:8642/login');
  });

  test('不知道来源时退回「本站根路径」，不编造 origin', () => {
    const message = sessionRequiredMessage(null);
    expect(message).toContain('本站根路径');
    expect(message).not.toContain('://');
  });

  test('说清「换 origin 就换会话」（今天那种「登录过却全部 401」）', () => {
    const message = sessionRequiredMessage('https://egg-rolls.top');
    expect(message).toContain('按 host 区分');
    expect(message).toContain('127.0.0.1');
  });

  test('不再承诺本机直连免登录（localDirect 在未配反代密钥时恒假）', () => {
    for (const origin of [null, 'http://127.0.0.1:8642']) {
      const message = sessionRequiredMessage(origin);
      expect(message).not.toContain('仍可用');
      expect(message).not.toContain('回环匿名');
    }
  });

  test('浏览器不会被带去 node 自己的端口（数据面只有平台代理这一条路）', () => {
    const message = sessionRequiredMessage('http://127.0.0.1:8642');
    expect(message).toContain('node 自己的端口');
    // 不给命令行。
    expect(message).not.toContain('curl');
    expect(message).not.toContain('$ ');
  });
});
