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
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

const TOKEN_PRIORITY = 'config > VESSEL_GATEWAY_TOKEN > gateway 自动生成';

const LINK_FILES = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'docs/ARCHITECTURE.md',
  'docs/FILE-MANAGEMENT.md',
  'docs/ADR.md',
  'docs/adr/README.md',
  'docs/operations/CI-CD.md',
  'docs/operations/RELEASE.md',
  'docs/operations/CONFIG.md',
  'docs/operations/MIGRATION.md',
  'docs/operations/TRACE.md',
];

const ADR_DIR = 'docs/adr';
const ADR_FILE_PATTERN = /^ADR-(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const ADR_STATUS = new Set(['proposed', 'accepted', 'superseded']);
const ADR_LINK_DOCS = ['README.md', 'AGENTS.md', 'docs/ARCHITECTURE.md', 'docs/FILE-MANAGEMENT.md'];

export interface DocIssue {
  file: string;
  line: number;
  message: string;
}

export async function checkDocs(root: string): Promise<DocIssue[]> {
  const issues: DocIssue[] = [];

  await checkEnvExample(root, issues);
  await checkTokenDocs(root, issues);
  await checkAdrTree(root, issues);
  await checkOperationsIndex(root, issues);
  await checkNotImplementedMarkers(root, issues);
  await checkLegacyAdrLinks(root, issues);

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

  for (const name of ['VESSEL_FEISHU_APP_ID', 'VESSEL_FEISHU_APP_SECRET'] as const) {
    const lineIndex = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (lineIndex === -1) {
      issues.push({ file, line: 0, message: `缺少 ${name} 变量` });
    } else if ((lines[lineIndex] ?? '') !== `${name}=`) {
      issues.push({
        file,
        line: lineIndex + 1,
        message: `${name} 必须留空（不得写入真实值）`,
      });
    }
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

interface AdrEntry {
  file: string;
  number: string;
  text: string;
  frontmatter: Record<string, string>;
}

function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return null;

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      end = index;
      break;
    }
  }
  if (end === -1) return null;

  const frontmatter: Record<string, string> = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .replace(/\s+#.*$/, '')
      .trim();
    frontmatter[key] = value;
  }
  return frontmatter;
}

function parseIntegerArray(value: string): number[] | null {
  const match = /^\[(.*)\]$/.exec(value);
  if (!match) return null;
  const inner = (match[1] ?? '').trim();
  if (!inner) return [];
  const items = inner.split(',').map((item) => item.trim());
  if (items.some((item) => !/^\d+$/.test(item))) return null;
  return items.map(Number);
}

function parseStringArray(value: string): string[] | null {
  const match = /^\[(.*)\]$/.exec(value);
  if (!match) return null;
  const inner = (match[1] ?? '').trim();
  if (!inner) return [];
  return inner.split(',').map((item) => item.trim());
}

async function checkAdrTree(root: string, issues: DocIssue[]): Promise<void> {
  const dir = join(root, ADR_DIR);
  if (!existsSync(dir)) return;

  const files = (await readdir(dir))
    .filter((file) => file.startsWith('ADR-') && file.endsWith('.md'))
    .sort();
  const byNumber = new Map<string, string>();
  const entries: AdrEntry[] = [];

  for (const file of files) {
    const match = ADR_FILE_PATTERN.exec(file);
    if (!match) {
      issues.push({
        file: `${ADR_DIR}/${file}`,
        line: 0,
        message: 'ADR 文件名必须匹配 ADR-<NNN>-<kebab-slug>.md（ASCII）',
      });
      continue;
    }
    const number = match[1] ?? '';
    if (byNumber.has(number)) {
      issues.push({
        file: `${ADR_DIR}/${file}`,
        line: 0,
        message: `ADR 编号重复：${number}（已有 ${byNumber.get(number)}）`,
      });
      continue;
    }
    byNumber.set(number, file);

    const text = await readFile(join(dir, file), 'utf8');
    const frontmatter = parseFrontmatter(text);
    if (!frontmatter) {
      issues.push({
        file: `${ADR_DIR}/${file}`,
        line: 0,
        message: '缺少合法的 YAML frontmatter',
      });
      continue;
    }
    entries.push({ file, number, text, frontmatter });
  }

  for (const entry of entries) {
    const location = `${ADR_DIR}/${entry.file}`;
    const { frontmatter, number } = entry;

    if (!/^\d+$/.test(frontmatter.adr ?? '') || Number(frontmatter.adr) !== Number(number)) {
      issues.push({
        file: location,
        line: 0,
        message: `frontmatter.adr 必须等于文件名编号 ${Number(number)}`,
      });
    }
    if (!frontmatter.title) {
      issues.push({ file: location, line: 0, message: 'frontmatter.title 不能为空' });
    }
    if (frontmatter.status === undefined || !ADR_STATUS.has(frontmatter.status)) {
      issues.push({
        file: location,
        line: 0,
        message: 'frontmatter.status 必须是 proposed|accepted|superseded',
      });
    }
    if (frontmatter.date !== 'null' && !/^\d{4}-\d{2}-\d{2}$/.test(frontmatter.date ?? '')) {
      issues.push({
        file: location,
        line: 0,
        message: 'frontmatter.date 必须是 YYYY-MM-DD 或 null',
      });
    }

    for (const key of ['supersedes', 'related'] as const) {
      const raw = frontmatter[key];
      if (raw === undefined) continue;
      const refs = parseIntegerArray(raw);
      if (refs === null) {
        issues.push({ file: location, line: 0, message: `frontmatter.${key} 必须是整数数组` });
        continue;
      }
      for (const ref of refs) {
        if (ref === Number(number)) {
          issues.push({ file: location, line: 0, message: `frontmatter.${key} 不能引用自身` });
        } else if (!byNumber.has(String(ref).padStart(3, '0'))) {
          issues.push({
            file: location,
            line: 0,
            message: `frontmatter.${key} 引用了不存在的 ADR-${String(ref).padStart(3, '0')}`,
          });
        }
      }
    }

    if (frontmatter.tags !== undefined) {
      const tags = parseStringArray(frontmatter.tags);
      if (tags === null || tags.some((tag) => !/^[a-z0-9-]+$/.test(tag))) {
        issues.push({
          file: location,
          line: 0,
          message: 'frontmatter.tags 必须是小写 ASCII kebab 数组',
        });
      }
    }

    for (const match of entry.text.matchAll(/\]\((ADR-[^)]+\.md)\)/g)) {
      const target = match[1] ?? '';
      if (!existsSync(join(dir, target))) {
        issues.push({ file: location, line: 0, message: `ADR 间链接不存在：${target}` });
      }
    }
  }

  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) {
    issues.push({ file: `${ADR_DIR}/README.md`, line: 0, message: '缺少 ADR 索引 README.md' });
    return;
  }
  const readme = await readFile(readmePath, 'utf8');
  const linked = new Map<string, number>();
  for (const line of readme.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const match of line.matchAll(/\]\((ADR-[^)]+\.md)\)/g)) {
      const target = match[1] ?? '';
      linked.set(target, (linked.get(target) ?? 0) + 1);
    }
  }
  for (const file of files) {
    const count = linked.get(file) ?? 0;
    if (count === 0) {
      issues.push({
        file: `${ADR_DIR}/README.md`,
        line: 0,
        message: `ADR 索引缺少 ${file}`,
      });
    } else if (count > 1) {
      issues.push({
        file: `${ADR_DIR}/README.md`,
        line: 0,
        message: `ADR 索引重复 ${file}`,
      });
    }
  }
  for (const target of linked.keys()) {
    if (!files.includes(target)) {
      issues.push({
        file: `${ADR_DIR}/README.md`,
        line: 0,
        message: `ADR 索引指向不存在的文件 ${target}`,
      });
    }
  }

  const stubPath = join(root, 'docs/ADR.md');
  if (!existsSync(stubPath)) {
    issues.push({ file: 'docs/ADR.md', line: 0, message: '缺少兼容 stub docs/ADR.md' });
    return;
  }
  const stub = await readFile(stubPath, 'utf8');
  if (!stub.includes('adr/README.md')) {
    issues.push({ file: 'docs/ADR.md', line: 0, message: 'stub 必须指向 adr/README.md' });
  }
  if (/^## ADR-/m.test(stub)) {
    issues.push({ file: 'docs/ADR.md', line: 0, message: 'stub 不能包含 ADR 正文标题' });
  }
  if (stub.split('\n').length > 20) {
    issues.push({ file: 'docs/ADR.md', line: 0, message: 'stub 不得超过 20 行' });
  }
}

async function checkOperationsIndex(root: string, issues: DocIssue[]): Promise<void> {
  const dir = join(root, 'docs/operations');
  const readmePath = join(root, 'README.md');
  if (!existsSync(dir) || !existsSync(readmePath)) return;

  const readme = await readFile(readmePath, 'utf8');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md'));
  for (const file of files) {
    if (!readme.includes(`](docs/operations/${file})`)) {
      issues.push({
        file: 'README.md',
        line: 0,
        message: `文档索引缺少 docs/operations/${file}`,
      });
    }
  }
}

async function checkNotImplementedMarkers(root: string, issues: DocIssue[]): Promise<void> {
  const readmePath = join(root, 'README.md');
  if (!existsSync(readmePath)) return;
  const readme = await readFile(readmePath, 'utf8');

  for (const [feature, marker] of [
    ['跨机器远程', '0.6'],
    ['微信', '不做'],
  ] as const) {
    if (!readme.includes(feature) || !readme.includes(marker)) {
      issues.push({
        file: 'README.md',
        line: 0,
        message: `未实现能力标注缺少：${feature} / ${marker}`,
      });
    }
  }

  const changelogPath = join(root, 'CHANGELOG.md');
  if (existsSync(changelogPath)) {
    const changelog = await readFile(changelogPath, 'utf8');
    const hasReleaseSection = /^## \[(?:Unreleased|0\.5\.0)\]/m.test(changelog);
    if (hasReleaseSection && !changelog.includes('Known limitations')) {
      issues.push({
        file: 'CHANGELOG.md',
        line: 0,
        message: '0.5 / Unreleased 段落必须包含 Known limitations',
      });
    }
  }
}

async function checkLegacyAdrLinks(root: string, issues: DocIssue[]): Promise<void> {
  for (const file of ADR_LINK_DOCS) {
    const full = join(root, file);
    if (!existsSync(full)) continue;
    const text = await readFile(full, 'utf8');
    for (const match of text.matchAll(/\]\((?:docs\/)?ADR\.md\)/g)) {
      issues.push({
        file,
        line: lineOfText(text, match.index ?? 0),
        message: '新文档不得链接 docs/ADR.md，请指向 docs/adr/ 具体文件或索引',
      });
    }
  }
}

function lineOfText(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
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
