/**
 * Teams 路由扩展（纯函数）。
 *
 * `app/router.ts` 的输出形状由壳层维护；Teams 域只额外识别 path 末尾的
 * `/edit` 与列表的 `?node=` 过滤，不改变 `parseRoute` 的契约。
 */

function withoutHash(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

function pathAndQuery(hash: string): { segments: string[]; query: URLSearchParams } {
  const [pathPart = '', queryPart = ''] = withoutHash(hash).split('?', 2);
  return { segments: pathPart.split('/').filter(Boolean), query: new URLSearchParams(queryPart) };
}

/** 安全解码：非法百分号编码时保留原值。 */
function decodeSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Team 编辑页 hash：`#/teams/<nodeKey>/<teamId>/edit`。 */
export function teamEditHash(nodeKey: string, teamId: string): string {
  return `#/teams/${encodeURIComponent(nodeKey)}/${encodeURIComponent(teamId)}/edit`;
}

/** 判断当前 hash 是否为某个 Team 的编辑页（可只校验 domain）。 */
export function isTeamEditHash(hash: string, nodeKey?: string, teamId?: string): boolean {
  const { segments } = pathAndQuery(hash);
  if (segments[0] !== 'teams' || segments[3] !== 'edit') return false;
  if (nodeKey !== undefined && decodeSegment(segments[1]) !== nodeKey) return false;
  if (teamId !== undefined && decodeSegment(segments[2]) !== teamId) return false;
  return true;
}

/** Teams 列表的节点过滤深链：`#/teams?node=<nodeKey>`。 */
export function teamsForNodeHash(nodeKey: string): string {
  return `#/teams?${new URLSearchParams({ node: nodeKey }).toString()}`;
}

/** 从 Teams 列表 hash 读取 `?node=`；缺失或空串返回 undefined。 */
export function teamNodeFilterFromHash(hash: string): string | undefined {
  const { query } = pathAndQuery(hash);
  const value = query.get('node');
  if (value === null || value === '') return undefined;
  return decodeSegment(value);
}
