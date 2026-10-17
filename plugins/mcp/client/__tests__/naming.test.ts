/**
 * 工具名规则与权限规则（纯函数）。
 */

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { MemoryEventStream, MemoryPluginHost } from '@vessel/core';
import { exposedToolName, hashSuffix, sanitizeSegment } from '../src/naming';
import { createMcpPlugin } from '../src/plugin';
import type { McpServerConfig } from '../src/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-stdio-server.ts', import.meta.url));

function stdioServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'mock',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    ...overrides,
  };
}

describe('sanitizeSegment', () => {
  it('replaces illegal characters with underscores', () => {
    expect(sanitizeSegment('my server')).toBe('my_server');
    expect(sanitizeSegment('a.b/c:d')).toBe('a_b_c_d');
  });

  it('keeps letters, digits, underscore and dash', () => {
    expect(sanitizeSegment('Read_File-2')).toBe('Read_File-2');
  });
});

describe('exposedToolName', () => {
  it('prefixes with mcp__<server>__<tool> by default', () => {
    expect(exposedToolName('my server', 'read file', true)).toBe('mcp__my_server__read_file');
  });

  it('uses the sanitized raw name when toolPrefix is false', () => {
    expect(exposedToolName('mock', 'read file', false)).toBe('read_file');
  });

  it('does not truncate names of exactly 64 characters', () => {
    const raw = `mcp__s__${'x'.repeat(56)}`;
    expect(raw.length).toBe(64);
    expect(exposedToolName('s', 'x'.repeat(56), true)).toBe(raw);
  });

  it('truncates longer names to 64 + underscore + 8-char hash', () => {
    const tool = 'x'.repeat(100);
    const raw = `mcp__s__${tool}`;
    const name = exposedToolName('s', tool, true);
    expect(name).toBe(`${raw.slice(0, 64)}_${hashSuffix(raw)}`);
    expect(name.length).toBe(64 + 1 + 8);
    expect(hashSuffix(raw)).toHaveLength(8);
  });

  it('is deterministic', () => {
    const tool = 'y'.repeat(100);
    expect(exposedToolName('s', tool, true)).toBe(exposedToolName('s', tool, true));
  });
});

describe('autoApproveTools permission rule', () => {
  async function permissionOf(
    autoApproveTools: string[],
    toolName: string,
  ): Promise<'allow' | 'deny' | 'ask' | undefined> {
    const plugin = createMcpPlugin({
      servers: [stdioServer({ autoApproveTools })],
    });
    const host = new MemoryPluginHost();
    try {
      await plugin.install(host);
      const tool = host.getTool(toolName);
      if (!tool?.checkPermission) return undefined;
      const ctx = { run_id: 'naming-test', messages: [], events: new MemoryEventStream() };
      return await tool.checkPermission({}, ctx);
    } finally {
      await plugin.close();
    }
  }

  it('returns allow for the exact raw tool name', async () => {
    expect(await permissionOf(['echo'], 'mcp__mock__echo')).toBe('allow');
  });

  it('returns ask for tools not listed', async () => {
    expect(await permissionOf(['echo'], 'mcp__mock__add')).toBe('ask');
  });

  it('is case-sensitive and exact', async () => {
    expect(await permissionOf(['Echo'], 'mcp__mock__echo')).toBe('ask');
    expect(await permissionOf(['ech'], 'mcp__mock__echo')).toBe('ask');
    expect(await permissionOf([], 'mcp__mock__echo')).toBe('ask');
  });
});
