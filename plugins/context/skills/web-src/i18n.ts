/**
 * Skills plugin copy. English is the fallback; host lang starting with `zh`
 * selects the Chinese table. Nav titles live in manifest contributes.i18n
 * (host surface); everything here is the plugin's own view copy.
 */

export type Lang = 'en' | 'zh-CN';

type Vars = Record<string, string | number>;

const EN = {
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.refresh': 'Refresh',
  'common.loadError': 'Could not load this view',
  'common.cancel': 'Cancel',
  'common.prev': 'Previous',
  'common.next': 'Next',

  'skills.title': 'Skill library',
  'skills.subtitle':
    'Managed skills from project skills/, user ~/.vessel/skills/ and the collected library. Files are the source of truth; the index is a derived cache.',
  'skills.searchPlaceholder': 'Search name / description / tags / id',
  'skills.searchAria': 'Search skills',
  'skills.sourceAll': 'All sources',
  'skills.tagAll': 'All tags',
  'skills.rescan': 'Rescan',
  'skills.rescanDone': 'Index rebuilt: {added} added, {removed} removed, {changed} changed',
  'skills.total': '{n} skill(s)',
  'skills.page': 'Showing {from}–{to} of {total}',
  'skills.empty.title': 'No skills indexed',
  'skills.empty.description':
    'Put markdown into <repo>/skills/ or ~/.vessel/skills/, or import skills into the collected library (<dataDir>/plugins/skills/library/). Then rescan.',
  'skills.noMatch': 'No skills match the current filters.',
  'skills.generatedAt': 'Index generated at {ts}',
  'skills.toolbar': 'Skill filters and actions',

  'detail.empty': 'Select a skill to see its content, trust state and session loads.',
  'detail.missing.title': 'Skill no longer available',
  'detail.missing.description':
    'It may have been deleted or renamed on disk. Rescan the index, or pick another skill from the list.',
  'detail.backToList': 'Back to list',
  'detail.source': 'Source',
  'detail.version': 'Version',
  'detail.tags': 'Tags',
  'detail.frontmatter': 'Frontmatter',
  'detail.warnings': 'Warnings',
  'detail.content': 'Content',
  'detail.contentTruncated':
    'Preview truncated to the load cap; the file on disk is the full truth.',
  'detail.contentError': 'Content unavailable',
  'detail.aux': 'Auxiliary files',
  'detail.auxHint': 'Listed only — the plugin never reads or executes them.',
  'detail.path': 'Path',
  'detail.bytes': '{n} bytes',

  'frontmatter.ok': 'ok',
  'frontmatter.partial': 'partial (unknown keys ignored)',
  'frontmatter.none': 'none',
  'frontmatter.invalid': 'invalid (raw content kept)',

  'trust.title': 'Trust',
  'trust.trusted': 'Trusted',
  'trust.stale': 'Changed',
  'trust.unknown': 'Untrusted',
  'trust.revoked': 'Revoked',
  'trust.staleBanner':
    'Content differs from the trusted version — re-confirm before the model loads it.',
  'trust.revokedBanner': 'Trust revoked — the model cannot load this skill until re-trusted.',
  'trust.unknownHint': 'No trust record yet. The first model load asks for confirmation (TOFU).',
  'trust.pinnedHash': 'Pinned hash',
  'trust.recordedAt': 'Recorded at',
  'trust.origin': 'Origin',
  'trust.trustButton': 'Trust this version',
  'trust.revokeButton': 'Revoke trust',
  'trust.saved': 'Trust updated.',

  'loads.title': 'Session loads',
  'loads.none': 'Not loaded in any session yet.',
  'loads.count': 'loaded ×{n}',
  'loads.session': 'Session',
  'loads.loadedAt': 'Loaded at',
  'loads.runId': 'Run',
};

export type MessageKey = keyof typeof EN;

const ZH: Record<MessageKey, string> = {
  'common.loading': '加载中…',
  'common.retry': '重试',
  'common.refresh': '刷新',
  'common.loadError': '无法加载此视图',
  'common.cancel': '取消',
  'common.prev': '上一页',
  'common.next': '下一页',

  'skills.title': '技能库',
  'skills.subtitle':
    '管理三个来源的技能：项目 skills/、用户 ~/.vessel/skills/ 与收集库。文件是真相源，索引只是派生缓存。',
  'skills.searchPlaceholder': '检索名称 / 描述 / 标签 / id',
  'skills.searchAria': '检索技能',
  'skills.sourceAll': '全部来源',
  'skills.tagAll': '全部标签',
  'skills.rescan': '重新扫描',
  'skills.rescanDone': '索引已重建：新增 {added}、移除 {removed}、变更 {changed}',
  'skills.total': '共 {n} 个技能',
  'skills.page': '显示 {from}–{to} / {total}',
  'skills.empty.title': '索引为空',
  'skills.empty.description':
    '把 markdown 放进 <仓库>/skills/ 或 ~/.vessel/skills/，或把技能导入收集库（<dataDir>/plugins/skills/library/），然后重新扫描。',
  'skills.noMatch': '没有符合当前过滤条件的技能。',
  'skills.generatedAt': '索引生成于 {ts}',
  'skills.toolbar': '技能筛选与操作',

  'detail.empty': '选择一个技能，查看正文、信任状态与会话加载记录。',
  'detail.missing.title': '技能不存在或已移除',
  'detail.missing.description': '它可能已在磁盘上被删除或重命名。重新扫描索引，或从列表中选择其它技能。',
  'detail.backToList': '返回列表',
  'detail.source': '来源',
  'detail.version': '版本',
  'detail.tags': '标签',
  'detail.frontmatter': 'Frontmatter',
  'detail.warnings': '告警',
  'detail.content': '正文',
  'detail.contentTruncated': '预览按加载上限截断；磁盘上的文件才是完整真相。',
  'detail.contentError': '正文不可用',
  'detail.aux': '附件清单',
  'detail.auxHint': '只列清单——插件不代读、不执行。',
  'detail.path': '路径',
  'detail.bytes': '{n} 字节',

  'frontmatter.ok': '合法',
  'frontmatter.partial': '部分（未知键已忽略）',
  'frontmatter.none': '无',
  'frontmatter.invalid': '非法（保留原文）',

  'trust.title': '信任',
  'trust.trusted': '已信任',
  'trust.stale': '已变更',
  'trust.unknown': '未信任',
  'trust.revoked': '已撤销',
  'trust.staleBanner': '内容与已信任版本不一致——模型加载前需重新确认。',
  'trust.revokedBanner': '信任已撤销——重新信任前模型无法加载此技能。',
  'trust.unknownHint': '尚无信任记录。模型首次加载会请求确认（TOFU）。',
  'trust.pinnedHash': '钉住哈希',
  'trust.recordedAt': '记录时间',
  'trust.origin': '来源',
  'trust.trustButton': '信任此版本',
  'trust.revokeButton': '撤销信任',
  'trust.saved': '信任已更新。',

  'loads.title': '会话加载',
  'loads.none': '尚未在任何会话加载。',
  'loads.count': '已加载 ×{n}',
  'loads.session': '会话',
  'loads.loadedAt': '加载时间',
  'loads.runId': 'Run',
};

export function normalizeLang(raw: string | undefined): Lang {
  return raw?.trim().toLowerCase().startsWith('zh') === true ? 'zh-CN' : 'en';
}

function interpolate(template: string, vars?: Vars): string {
  if (vars === undefined) return template;
  let text = template;
  for (const [name, value] of Object.entries(vars)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

export type Translator = (key: MessageKey, vars?: Vars) => string;

/** Translate `key` for `lang`; falls back to English, then to the key. */
export function translator(lang: string | undefined): Translator {
  const table = I18N[normalizeLang(lang)];
  return (key, vars) => interpolate(table[key] ?? EN[key] ?? key, vars);
}

export const I18N: Record<Lang, Record<MessageKey, string>> = {
  en: EN,
  'zh-CN': ZH,
};
