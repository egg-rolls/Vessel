import { describe, expect, it } from 'bun:test';
import { sanitizeTerminalText } from '../src/utils/sanitize-terminal-text.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);

describe('sanitizeTerminalText', () => {
  it('去除 CSI 颜色/光标序列', () => {
    expect(sanitizeTerminalText(`${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(sanitizeTerminalText(`${ESC}[2Kcontent`)).toBe('content');
    expect(sanitizeTerminalText(`${C1_CSI}31mred`)).toBe('red');
    expect(sanitizeTerminalText(`a${ESC}[1;2Hb`)).toBe('ab');
  });

  it('去除 OSC（BEL 与 ST 两种终结符）', () => {
    expect(sanitizeTerminalText(`${ESC}]0;title${BEL}content`)).toBe('content');
    expect(sanitizeTerminalText(`${ESC}]8;;https://example.com${ESC}\\link`)).toBe('link');
  });

  it('去除其它 ESC 转义序列', () => {
    expect(sanitizeTerminalText(`${ESC}(Btext`)).toBe('text');
    expect(sanitizeTerminalText(`${ESC}=text`)).toBe('text');
  });

  it('保留换行与制表符，丢弃其它 C0 / DEL / C1', () => {
    expect(sanitizeTerminalText('a\n\tb')).toBe('a\n\tb');
    expect(sanitizeTerminalText(`a${String.fromCharCode(0)}b`)).toBe('ab');
    expect(sanitizeTerminalText(`a${String.fromCharCode(0x7f)}b`)).toBe('ab');
    expect(sanitizeTerminalText(`a${String.fromCharCode(0x85)}b`)).toBe('ab');
  });

  it('归一化 CRLF 与单独 CR', () => {
    expect(sanitizeTerminalText('a\r\nb')).toBe('a\nb');
    expect(sanitizeTerminalText('a\rb')).toBe('a\nb');
    expect(sanitizeTerminalText('a\r\n\r\nb')).toBe('a\n\nb');
  });

  it('纯文本与空串保持不变', () => {
    expect(sanitizeTerminalText('')).toBe('');
    expect(sanitizeTerminalText('plain 中文 🚀')).toBe('plain 中文 🚀');
  });
});
