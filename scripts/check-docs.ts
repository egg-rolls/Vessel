#!/usr/bin/env bun

/**
 * 文档一致性检查（R8c）。
 *
 * 1. 环境变量：`.env.example` 的 VESSEL_GATEWAY_TOKEN 值必须为空；README /
 *    ARCHITECTURE 必须写明优先级；禁止 VESSEL_NODE_ID。
 * 2. 相对链接：README / AGENTS / CONTRIBUTING / docs（ADR 历史段除外）中的相对链接必须存在。
 *
 * 用法：bun run scripts/check-docs.ts
 * 退出码：0 = 通过；1 = 有 issue。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

const TOKEN_PRIORITY = 'config > VESSEL_GATEWAY_TOKEN > gateway 自动生成';

const LINK_FILES = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'docs/ARCHITECTURE.md',
  'docs/FILE-MANAGEMENT.md',
  'docs/operations/CI-CD.md',
  'docs/operations/RELEASE.md',
];

export interface DocIssue {
  file: string;
  line: number;
  message: string;
}

export async function checkDocs(root: string): Promise<DocIssue[]> {
  const issues: DocIssue[] = [];

  await checkEnvExample(root, issues);
  await checkTokenDocs(root, issues);

  for (const file of LINK_FILES) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    await checkLinks(root, file, issues);
  }

  return issues;
}

async function checkEnvExample(root: string, issues: DocIssue[]): Promise<void> {
  const file = '.env.example';
  const text = await readFile(join(root, file), 'utf8');
  const lines = text.split('\n');

  const tokenLine = lines.findIndex((line) => line.startsWith('VESSEL_GATEWAY_TOKEN='));
  if (tokenLine === -1) {
    issues.push({ file, line: 0, message: '缺少 VESSEL_GATEWAY_TOKEN 变量' });
  } else if ((lines[tokenLine] ?? '') !== 'VESSEL_GATEWAY_TOKEN=') {
    issues.push({
      file,
      line: tokenLine + 1,
      message: 'VESSEL_GATEWAY_TOKEN 必须留空（不得写入真实值）',
    });
  }

  if (!text.includes(TOKEN_PRIORITY)) {
    issues.push({ file, line: 0, message: `缺少优先级说明：${TOKEN_PRIORITY}` });
  }

  const nodeIdLine = lines.findIndex((line) => line.startsWith('VESSEL_NODE_ID'));
  if (nodeIdLine !== -1) {
    issues.push({
      file,
      line: nodeIdLine + 1,
      message: '禁止新增 VESSEL_NODE_ID（DECISION-006 R9）',
    });
  }
}

async function checkTokenDocs(root: string, issues: DocIssue[]): Promise<void> {
  for (const file of ['README.md', 'docs/ARCHITECTURE.md']) {
    const text = await readFile(join(root, file), 'utf8');
    if (!text.includes('VESSEL_GATEWAY_TOKEN')) {
      issues.push({ file, line: 0, message: '缺少 VESSEL_GATEWAY_TOKEN 说明' });
    }
    if (!text.includes(TOKEN_PRIORITY)) {
      issues.push({ file, line: 0, message: `缺少优先级说明：${TOKEN_PRIORITY}` });
    }
  }
}

async function checkLinks(root: string, file: string, issues: DocIssue[]): Promise<void> {
  const text = await readFile(join(root, file), 'utf8');
  const lines = text.split('\n');
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = (match[1] ?? '').trim().replace(/^<|>$/g, '').split(/\s+/)[0] ?? '';
      if (!raw || /^(https?:|mailto:|#)/.test(raw)) continue;

      const target = raw.split('#')[0]?.split('?')[0] ?? '';
      if (!target) continue;

      const resolved = posix.resolve('/', posix.dirname(file), target).replace(/^\/+/, '');
      if (!existsSync(join(root, resolved))) {
        issues.push({
          file,
          line: index + 1,
          message: `相对链接不存在：${raw} -> ${resolved}`,
        });
      }
    }
  }
}

async function main(): Promise<void> {
  const issues = await checkDocs(process.cwd());

  if (issues.length === 0) {
    console.log('docs check passed');
    return;
  }

  console.error(`docs check failed: ${issues.length} issue(s)`);
  for (const issue of issues) {
    const location = issue.line > 0 ? `${issue.file}:${issue.line}` : issue.file;
    console.error(`  ${location}: ${issue.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
