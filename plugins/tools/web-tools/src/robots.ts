/**
 * robots.txt：M1 只做「同源一次、过期缓存」的最小实现。
 *
 * 取 RFC 9309 的核心语义：
 * - 按 User-agent 分组，取最长匹配的 product token，否则用 `*`；
 * - 规则是最长路径前缀匹配（支持 `*` 通配与 `$` 结尾锚），同长度时 allow 优先；
 * - 没有命中任何规则 = 允许。
 *
 * 取不到 robots.txt 时的态度（研究稿 §6）：
 * - 2xx → 解析；
 * - 4xx/其它 → 视为没有规则（全部允许）；
 * - 5xx / 网络错误 → 保守视为「全部禁止」，避免借 502 绕过。
 */

export interface RobotsRules {
  isAllowed(path: string): boolean;
}

const ALLOW_ALL: RobotsRules = { isAllowed: () => true };
const DISALLOW_ALL: RobotsRules = { isAllowed: () => false };

export function allowAllRules(): RobotsRules {
  return ALLOW_ALL;
}

export function disallowAllRules(): RobotsRules {
  return DISALLOW_ALL;
}

interface Rule {
  allow: boolean;
  pattern: string;
  matcher: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

function compilePattern(pattern: string): RegExp {
  let body = pattern;
  let anchored = false;
  if (body.endsWith('$')) {
    anchored = true;
    body = body.slice(0, -1);
  }
  // 先整体转义，再把 \* 还原成通配
  const escaped = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

function normalizePath(path: string): string {
  if (path === '') return '';
  return path.startsWith('/') ? path : `/${path}`;
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let acceptingAgents = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = (rawLine.split('#')[0] ?? '').trim();
    if (line === '') continue;
    const colonAt = line.indexOf(':');
    if (colonAt === -1) continue;
    const field = line.slice(0, colonAt).trim().toLowerCase();
    const value = line.slice(colonAt + 1).trim();

    if (field === 'user-agent') {
      if (!current || !acceptingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        acceptingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      if (!current) continue;
      acceptingAgents = false;
      // 空 Disallow 表示不限制任何路径
      if (value === '') continue;
      current.rules.push({
        allow: field === 'allow',
        pattern: normalizePath(value),
        matcher: compilePattern(normalizePath(value)),
      });
    }
    // sitemap / crawl-delay 等与抓取许可无关，忽略
  }
  return groups;
}

function selectGroup(groups: Group[], userAgent: string): Group | undefined {
  const ua = userAgent.toLowerCase();
  let best: { group: Group; length: number } | undefined;
  let wildcard: Group | undefined;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        wildcard ??= group;
        continue;
      }
      if (
        agent !== '' &&
        ua.includes(agent) &&
        (best === undefined || agent.length > best.length)
      ) {
        best = { group, length: agent.length };
      }
    }
  }
  return best?.group ?? wildcard;
}

export function parseRobotsTxt(text: string, userAgent: string): RobotsRules {
  const selected = selectGroup(parseGroups(text), userAgent);
  if (!selected || selected.rules.length === 0) return ALLOW_ALL;

  const rules = selected.rules;
  return {
    isAllowed(path: string): boolean {
      const target = normalizePath(path.split('#')[0] ?? '/');
      let winner: Rule | undefined;
      for (const rule of rules) {
        if (!rule.matcher.test(target)) continue;
        if (winner === undefined) {
          winner = rule;
          continue;
        }
        if (rule.pattern.length > winner.pattern.length) {
          winner = rule;
          continue;
        }
        // 同长度：allow 优先
        if (rule.pattern.length === winner.pattern.length && rule.allow && !winner.allow)
          winner = rule;
      }
      return winner ? winner.allow : true;
    },
  };
}

/**
 * 同源只拉一次，TTL 过期后重拉；并发请求共用同一个 in-flight promise，
 * 免得一次抓取把同一个站点的 /robots.txt 打成 N 次。
 */
export class RobotsCache {
  private readonly entries = new Map<string, { rules: RobotsRules; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<RobotsRules>>();

  constructor(private readonly ttlMs: number) {}

  async get(origin: string, load: () => Promise<RobotsRules>): Promise<RobotsRules> {
    const now = Date.now();
    const cached = this.entries.get(origin);
    if (cached && cached.expiresAt > now) return cached.rules;

    const running = this.pending.get(origin);
    if (running) return running;

    const task = load().then(
      (rules) => {
        this.entries.set(origin, { rules, expiresAt: now + this.ttlMs });
        this.pending.delete(origin);
        return rules;
      },
      (error: unknown) => {
        this.pending.delete(origin);
        throw error;
      },
    );
    this.pending.set(origin, task);
    return task;
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
