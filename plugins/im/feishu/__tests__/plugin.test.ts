import { describe, expect, it } from 'bun:test';
import defaultExport, { createFeishuPlugin } from '../src/index.js';

describe('feishu plugin factory', () => {
  it('default export is the factory', () => {
    expect(typeof defaultExport).toBe('function');
    expect(defaultExport).toBe(createFeishuPlugin);
  });
});
