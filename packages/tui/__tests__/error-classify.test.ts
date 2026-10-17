import { describe, expect, it } from 'bun:test';
import { classifyError, formatClassifiedError } from '../src/error-classifier.js';

describe('classifyError', () => {
  it('分类网络错误', () => {
    const c = classifyError(new Error('fetch failed: ENOTFOUND api.openai.com'));
    expect(c.category).toBe('network');
    expect(c.hint).toBeTruthy();
  });

  it('分类鉴权错误（401）', () => {
    const c = classifyError(new Error('OpenAI API error: 401 - Unauthorized'));
    expect(c.category).toBe('auth');
  });

  it('分类限流（429）', () => {
    const c = classifyError(new Error('OpenAI API error: 429 - Rate limit exceeded'));
    expect(c.category).toBe('quota');
  });

  it('分类用量限额（Usage limits exceeded）', () => {
    const c = classifyError(new Error('Usage limits exceeded'));
    expect(c.category).toBe('quota');
  });

  it('分类终止策略', () => {
    const c = classifyError(new Error('Termination policy triggered: max iterations'));
    expect(c.category).toBe('quota');
  });

  it('分类 API 错误（500）', () => {
    const c = classifyError(new Error('OpenAI API error: 500 - Internal Server Error'));
    expect(c.category).toBe('api');
  });

  it('分类未知错误', () => {
    const c = classifyError(new Error('something weird'));
    expect(c.category).toBe('unknown');
    expect(c.hint).toBeUndefined();
  });

  it('非 Error 对象也能处理', () => {
    const c = classifyError('plain string error');
    expect(c.category).toBe('unknown');
    expect(c.message).toBe('plain string error');
  });

  it('取消：AbortError / Run cancelled 不落入 network', () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    expect(classifyError(abortError).category).toBe('cancelled');
    expect(classifyError(new Error('Run cancelled')).category).toBe('cancelled');
    expect(classifyError(new Error('Request aborted')).category).toBe('cancelled');
  });

  it('超时：TimeoutError 与 timed out 优先于取消', () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    expect(classifyError(timeoutError).category).toBe('timeout');
    expect(
      classifyError(
        new Error('Timed out after 120000ms waiting for event "tool.permission.response"'),
      ).category,
    ).toBe('timeout');
    expect(classifyError(new Error('The operation timed out')).category).toBe('timeout');
  });

  it('权限拒绝单独分类', () => {
    expect(classifyError(new Error('Tool "bash" execution denied by user')).category).toBe(
      'permission',
    );
    expect(
      classifyError(new Error('Tool "bash" execution denied by permission policy')).category,
    ).toBe('permission');
  });

  it('formatClassifiedError：取消不显示为错误，其它带分类与 hint', () => {
    expect(formatClassifiedError(classifyError(new Error('Run cancelled')))).toBe('⏹ Cancelled.');
    const formatted = formatClassifiedError(classifyError(new Error('fetch failed: ECONNRESET')));
    expect(formatted.startsWith('✗ [network]')).toBe(true);
    expect(formatted).toContain('网络不可达');
  });
});

describe('0.3 durable / MCP 稳定错误码', () => {
  it('Error.code 优先于 message', () => {
    const error = Object.assign(new Error('resume failed'), { code: 'run_not_found' });
    expect(classifyError(error).category).toBe('not_found');
  });

  it('message 里的稳定 code 也能识别', () => {
    expect(classifyError(new Error('run_not_resumable: completed')).category).toBe('not_resumable');
    expect(classifyError(new Error('run_already_running')).category).toBe('conflict');
    expect(classifyError(new Error('durable_disabled')).category).toBe('disabled');
    expect(classifyError(new Error('run_store_required')).category).toBe('disabled');
    expect(classifyError(new Error('mcp_server_not_found')).category).toBe('not_found');
    expect(classifyError(new Error('mcp_server_disabled')).category).toBe('disabled');
  });

  it('formatClassifiedError 使用新分类标签', () => {
    expect(formatClassifiedError(classifyError(new Error('run_already_running')))).toContain(
      '[conflict]',
    );
  });

  it('既有网络/超时/取消分类不被稳定 code 影响', () => {
    expect(classifyError(new Error('fetch failed: ECONNREFUSED')).category).toBe('network');
    expect(classifyError(new Error('Request aborted')).category).toBe('cancelled');
  });
});
