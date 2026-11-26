/**
 * Model-registry plugin copy (two-face refactor §9). English is the fallback;
 * host lang starting with `zh` selects the Chinese table. Strings live here,
 * not in plugin-ui. Nav titles live in manifest contributes.i18n (host surface).
 */

export type Lang = 'en' | 'zh-CN';

type Vars = Record<string, string | number>;

const EN = {
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.refresh': 'Refresh',
  'common.loadError': 'Could not load this view',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.confirmDelete': 'Confirm delete',
  'common.edit': 'Edit',
  'common.saved': 'Saved. Applies to the next body/run.',
  'common.actions': 'Actions',
  'common.optional': 'optional',
  'common.advanced': 'Advanced',

  'models.title': 'Models',
  'models.subtitle':
    'Register model entries referencing a credential. Saves apply to the next body/run.',
  'models.section': 'Model entries',
  'models.add': 'Add model',
  'models.empty.title': 'No registered models',
  'models.empty.description':
    'Create a credential first (Credentials page), then add a model entry referencing it. The legacy provider.* entry is synthesized automatically and shown read-only.',
  'models.th.id': 'Entry key',
  'models.th.name': 'Wire name',
  'models.th.alias': 'Alias',
  'models.th.provider': 'Provider',
  'models.th.mode': 'Mode',
  'models.th.credential': 'Credential',
  'models.th.pricing': 'Pricing (in/out per 1M)',
  'models.legacyHint': 'Legacy provider.* entry (read-only; edit it in the config file)',
  'models.inUse': 'default',
  'models.test': 'Test (real request · ~1 token)',
  'models.testRunning': 'Testing…',
  'models.testHint':
    'Testing sends a real request to the credential endpoint with the stored credential: openai-compatible protocols list models; anthropic (or an explicit model) sends a minimal max_tokens=1 chat (~1 token cost). Never triggered automatically.',
  'models.testResult': 'Connectivity test result',
  'models.testOk': 'OK',
  'models.testFailed': 'Failed',
  'models.latency': 'Latency: {ms} ms',
  'models.testModels': '{n} model(s) returned',
  'models.deleteConfirm': 'Delete model "{id}"?',
  'models.migration.title': 'One-shot migration report',
  'models.migration.split': 'Credential splits: {n}',
  'models.migration.reRecord': 'Credentials needing re-recording: {ids}',
  'models.migration.droppedAliases': 'Dropped aliases (single-value rule): {ids}',
  'models.migration.unmatchedPricing': 'Unmatched pricing keys (kept top-level): {ids}',
  'models.migration.pins': 'Agent pins rewritten: {n}',
  'models.migration.pinsFailed': 'Pin rewrite failed: {ids}',

  'models.form.addTitle': 'Add model',
  'models.form.editTitle': 'Edit model "{id}"',
  'models.form.id': 'Entry key',
  'models.form.idHint':
    'Unique ref key; a wire name may be used directly (a-z A-Z 0-9 . _ / -, up to 128 chars); cannot be renamed after save',
  'models.form.provider': 'Provider (protocol)',
  'models.form.providerHint':
    'Protocol adapter, not a brand: openai / openai-compatible / anthropic / gemini, or a custom provider plugin factory name. Defaults to openai.',
  'models.form.name': 'Model name (wire id)',
  'models.form.nameHint': 'The model field sent to the endpoint; defaults to the entry key',
  'models.form.alias': 'Alias',
  'models.form.aliasHint': 'Flat unique ref (no /); must not collide with any entry key',
  'models.form.mode': 'Request mode',
  'models.form.modeHint': 'Wire request shape within the protocol; defaults by provider',
  'models.form.credential': 'Credential',
  'models.form.credentialHint': 'The endpoint travels with the credential (baseUrl + API key)',
  'models.form.credentialNone': 'No credentials yet — create one first',
  'models.form.goCredentials': 'Go to Credentials',
  'models.form.pricing': 'Pricing (per 1M tokens)',
  'models.form.inputPrice': 'Input price',
  'models.form.outputPrice': 'Output price',
  'models.form.cacheReadPrice': 'Cache read price',
  'models.form.cacheWritePrice': 'Cache write price',
  'models.form.param': 'Default request params',
  'models.form.temperature': 'Temperature (0–2)',
  'models.form.maxTokens': 'Max tokens',
  'models.form.topP': 'Top P (0–1]',
  'models.form.promptCache': 'Prompt cache',
  'models.form.cacheAuto': 'auto (default)',
  'models.form.cacheOn': 'Force on',
  'models.form.cacheOff': 'Force off',
  'models.form.extra': 'Extra body params (JSON object)',
  'models.form.info': 'Metadata (display only)',
  'models.form.displayName': 'Display name',
  'models.form.description': 'Description',
  'models.form.contextWindow': 'Context window',
  'models.form.maxOutputTokens': 'Max output tokens',
  'models.form.capabilities': 'Capabilities',
  'models.form.capVision': 'vision',
  'models.form.capThinking': 'thinking',
  'models.form.capTools': 'tools',
  'models.form.infoJson': 'Additional metadata (JSON object)',
  'models.form.needId': 'Entry key is required',
  'models.form.needCredential': 'Credential is required',
  'models.form.badJson': '{field} must be a JSON object',
  'models.form.badNumber': '{field} must be a number',

  'default.title': 'Default model',
  'default.description':
    'models.default ref (alias or entry key); the VESSEL_MODEL environment variable takes precedence when set.',
  'default.current': 'Effective',
  'default.none': 'Unresolved (no default or invalid config)',
  'default.ref': 'Default ref',
  'default.choose': 'Choose a ref…',
  'default.save': 'Set default',
  'default.legacy': 'Legacy entry',

  'credentials.title': 'Credentials',
  'credentials.subtitle':
    'Authentication endpoints (name + baseUrl + API key). Values are write-only and never echoed; the list shows metadata only. Create credentials first, then reference them from model entries.',
  'credentials.add': 'Add credential',
  'credentials.rotate': 'Edit',
  'credentials.th.id': 'Name',
  'credentials.th.baseUrl': 'Base URL',
  'credentials.th.hasValue': 'Value',
  'credentials.th.updatedAt': 'Updated',
  'credentials.th.usedBy': 'Used by',
  'credentials.valueSet': 'recorded',
  'credentials.valueMissing': 'needs recording',
  'credentials.empty.title': 'No credentials yet',
  'credentials.empty.description':
    'Create a credential (name + request URL + API key), then add models on the Models page.',
  'credentials.unused': 'Not referenced',
  'credentials.form.addTitle': 'Add credential',
  'credentials.form.editTitle': 'Edit credential "{id}"',
  'credentials.form.id': 'Credential name',
  'credentials.form.idHint':
    'Letters, digits and hyphens (a-zA-Z0-9-, up to 64 chars); cannot be renamed after save',
  'credentials.form.baseUrl': 'Request URL (baseUrl)',
  'credentials.form.baseUrlHint':
    'Required http(s) endpoint; models referencing this credential use it',
  'credentials.form.value': 'API key',
  'credentials.form.valueHint':
    'Write-only input: never echoed or logged after submit; leave empty on edit to keep the current value.',
  'credentials.form.valuePlaceholderEdit': 'Leave empty to keep the current value',
  'credentials.form.apiKeyEnv': 'API key environment variable',
  'credentials.form.apiKeyEnvHint':
    'Optional alternative source; the stored value wins when both exist',
  'credentials.form.needId': 'Credential name is required',
  'credentials.form.needBaseUrl': 'Request URL is required',
  'credentials.form.needValue': 'API key is required for a new credential',
  'credentials.deleteConfirm': 'Delete credential "{id}"?',
} as const;

export type MessageKey = keyof typeof EN;

const ZH: Record<MessageKey, string> = {
  'common.loading': '加载中…',
  'common.retry': '重试',
  'common.refresh': '刷新',
  'common.loadError': '无法加载此视图',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.confirmDelete': '确认删除',
  'common.edit': '编辑',
  'common.saved': '已保存，下一具 body/run 生效',
  'common.actions': '操作',
  'common.optional': '可选',
  'common.advanced': '高级',

  'models.title': '模型',
  'models.subtitle': '注册引用凭证的模型条目；保存后下一具 body/run 生效。',
  'models.section': '模型条目',
  'models.add': '添加模型',
  'models.empty.title': '暂无注册模型',
  'models.empty.description':
    '先在「凭证」页创建凭证，再添加引用它的模型条目。legacy provider.* 条目会自动合成，只读显示。',
  'models.th.id': '条目键',
  'models.th.name': 'wire 名',
  'models.th.alias': '别称',
  'models.th.provider': '协议',
  'models.th.mode': '模式',
  'models.th.credential': '凭证',
  'models.th.pricing': '价格（输入/输出 每百万）',
  'models.legacyHint': 'legacy provider.* 兼容条目（只读；请在配置文件中修改）',
  'models.inUse': '默认',
  'models.test': '测试（真实请求 · ~1 token）',
  'models.testRunning': '测试中…',
  'models.testHint':
    '测试会用已存凭证向凭证端点发真实请求：openai 系协议查询模型列表；anthropic（或指定模型）发 max_tokens=1 的最小请求（1 token 级成本）。绝不自动触发。',
  'models.testResult': '连通性测试结果',
  'models.testOk': '连通',
  'models.testFailed': '失败',
  'models.latency': '耗时：{ms} ms',
  'models.testModels': '返回 {n} 个模型',
  'models.deleteConfirm': '确认删除模型「{id}」？',
  'models.migration.title': '一次性迁移报告',
  'models.migration.split': '凭证拆分：{n}',
  'models.migration.reRecord': '需重录的凭证：{ids}',
  'models.migration.droppedAliases': '被丢弃的别称（单值规则）：{ids}',
  'models.migration.unmatchedPricing': '未匹配的价格键（留顶层兜底）：{ids}',
  'models.migration.pins': '已改写的 agent pin：{n}',
  'models.migration.pinsFailed': 'pin 改写失败：{ids}',

  'models.form.addTitle': '添加模型',
  'models.form.editTitle': '编辑模型「{id}」',
  'models.form.id': '条目键',
  'models.form.idHint':
    '唯一 ref 键；可直接用 wire 名（a-z A-Z 0-9 . _ / -，≤128 字符）；保存后不可改名',
  'models.form.provider': '协议类型（provider）',
  'models.form.providerHint':
    '协议适配器，非品牌：openai / openai-compatible / anthropic / gemini，或自定义 provider 插件工厂名。缺省 openai。',
  'models.form.name': '模型名称（wire id）',
  'models.form.nameHint': '发给端点的 model 字段；缺省 = 条目键',
  'models.form.alias': '模型别称',
  'models.form.aliasHint': '扁平唯一 ref（不含 /）；不得与任何条目键重合',
  'models.form.mode': '请求模式',
  'models.form.modeHint': '协议内的 wire 请求形状；缺省按协议推导',
  'models.form.credential': '访问凭证',
  'models.form.credentialHint': '端点随凭证走（baseUrl + API key）',
  'models.form.credentialNone': '暂无凭证——请先创建',
  'models.form.goCredentials': '去创建凭证',
  'models.form.pricing': '价格（每百万 token）',
  'models.form.inputPrice': '输入价格',
  'models.form.outputPrice': '输出价格',
  'models.form.cacheReadPrice': '缓存读取价格',
  'models.form.cacheWritePrice': '缓存写入价格',
  'models.form.param': '缺省请求参数',
  'models.form.temperature': 'Temperature（0–2）',
  'models.form.maxTokens': 'Max tokens',
  'models.form.topP': 'Top P（0–1]',
  'models.form.promptCache': 'Prompt 缓存',
  'models.form.cacheAuto': 'auto（默认）',
  'models.form.cacheOn': '强开',
  'models.form.cacheOff': '强关',
  'models.form.extra': '额外请求体参数（JSON 对象）',
  'models.form.info': '元数据（仅展示）',
  'models.form.displayName': '展示名',
  'models.form.description': '描述',
  'models.form.contextWindow': '上下文窗口',
  'models.form.maxOutputTokens': '最大输出 token',
  'models.form.capabilities': '能力',
  'models.form.capVision': '视觉',
  'models.form.capThinking': '思考',
  'models.form.capTools': '工具',
  'models.form.infoJson': '附加元数据（JSON 对象）',
  'models.form.needId': '条目键不能为空',
  'models.form.needCredential': '访问凭证不能为空',
  'models.form.badJson': '{field} 必须是 JSON 对象',
  'models.form.badNumber': '{field} 必须是数字',

  'default.title': '默认模型',
  'default.description': 'models.default ref（别称或条目键）；VESSEL_MODEL 环境变量非空时优先。',
  'default.current': '当前生效',
  'default.none': '未解析（无默认或配置无效）',
  'default.ref': '默认 ref',
  'default.choose': '选择 ref…',
  'default.save': '设为默认',
  'default.legacy': 'legacy 条目',

  'credentials.title': '凭证',
  'credentials.subtitle':
    '认证端点（名称 + baseUrl + API key）。值只写不回显；列表只有元数据。先创建凭证，再在模型条目里引用。',
  'credentials.add': '添加凭证',
  'credentials.rotate': '编辑',
  'credentials.th.id': '名称',
  'credentials.th.baseUrl': '请求地址',
  'credentials.th.hasValue': '值',
  'credentials.th.updatedAt': '更新时间',
  'credentials.th.usedBy': '被引用',
  'credentials.valueSet': '已录',
  'credentials.valueMissing': '需录值',
  'credentials.empty.title': '暂无凭证',
  'credentials.empty.description':
    '创建凭证（名称 + 请求地址 + API key），再到「模型」页添加模型。',
  'credentials.unused': '未被引用',
  'credentials.form.addTitle': '添加凭证',
  'credentials.form.editTitle': '编辑凭证「{id}」',
  'credentials.form.id': '凭证名称',
  'credentials.form.idHint': '字母、数字、连字符（a-zA-Z0-9-，≤64 字符）；保存后不可改名',
  'credentials.form.baseUrl': '请求地址（baseUrl）',
  'credentials.form.baseUrlHint': '必填 http(s) 端点；引用此凭证的模型都用它',
  'credentials.form.value': 'API key',
  'credentials.form.valueHint': '只写输入：提交后不回显、不记录；编辑时留空 = 不改值。',
  'credentials.form.valuePlaceholderEdit': '留空 = 不改当前值',
  'credentials.form.apiKeyEnv': 'API key 环境变量',
  'credentials.form.apiKeyEnvHint': '可选替代来源；两者并存时库值优先',
  'credentials.form.needId': '凭证名称不能为空',
  'credentials.form.needBaseUrl': '请求地址不能为空',
  'credentials.form.needValue': '新建凭证必须填 API key',
  'credentials.deleteConfirm': '确认删除凭证「{id}」？',
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
