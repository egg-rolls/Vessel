/**
 * Model-registry plugin copy. English is the fallback; host lang starting with
 * `zh` selects the Chinese table. Strings live here, not in plugin-ui.
 * Nav titles live in manifest contributes.i18n (host surface).
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

  'vendors.title': 'Vendors & models',
  'vendors.subtitle':
    'Register vendors, model lists and aliases. Saves apply to the next body/run.',
  'vendors.section': 'Vendors',
  'vendors.add': 'Add vendor',
  'vendors.empty.title': 'No registered vendors',
  'vendors.empty.description':
    'Add a vendor with at least one model. The legacy provider.* entry is synthesized automatically and shown read-only.',
  'vendors.th.id': 'Vendor id',
  'vendors.th.protocol': 'Protocol',
  'vendors.th.baseUrl': 'Base URL',
  'vendors.th.credential': 'Credential',
  'vendors.th.models': 'Models',
  'vendors.legacyHint': 'Legacy provider.* entry (read-only; edit it in the config file)',
  'vendors.inUse': 'referenced',
  'vendors.modelCount': '{n} model(s)',
  'vendors.test': 'Test (real request · ~1 token)',
  'vendors.testRunning': 'Testing…',
  'vendors.testHint':
    'Testing sends a real request to the vendor endpoint with the stored credential: openai-compatible protocols list models; anthropic (or an explicit model) sends a minimal max_tokens=1 chat (~1 token cost). Never triggered automatically.',
  'vendors.testResult': 'Connectivity test result',
  'vendors.testOk': 'OK',
  'vendors.testFailed': 'Failed',
  'vendors.latency': 'Latency: {ms} ms',
  'vendors.testModels': '{n} model(s) returned',
  'vendors.importModels': 'Import model list into form',
  'vendors.deleteConfirm': 'Delete vendor "{id}"?',

  'vendors.form.addTitle': 'Add vendor',
  'vendors.form.editTitle': 'Edit vendor "{id}"',
  'vendors.form.id': 'Vendor id',
  'vendors.form.idHint': 'kebab-case (a-z0-9-, up to 64 chars); cannot be renamed after save',
  'vendors.form.protocol': 'Protocol',
  'vendors.form.protocolHint':
    'Registered provider factory name: openai / anthropic / google / mistral / ollama / cohere, or a custom provider plugin protocol',
  'vendors.form.baseUrl': 'Base URL (optional)',
  'vendors.form.baseUrlHint': 'Defaults to the protocol factory endpoint when empty',
  'vendors.form.credentialSource': 'Credential source',
  'vendors.form.credentialNone': 'None (vendor needs no key)',
  'vendors.form.credentialRef': 'Encrypted credential reference',
  'vendors.form.apiKeyEnv': 'Environment variable',
  'vendors.form.credentialId': 'Credential id',
  'vendors.form.credentialIdHint':
    'Add the value on the Credentials page; only the reference is stored here, never the value',
  'vendors.form.apiKeyEnvName': 'Environment variable name',
  'vendors.form.models': 'Models',
  'vendors.form.modelsHint':
    'At least one model; wire model ids may contain / (e.g. dashscope/qwen4-max)',
  'vendors.form.modelId': 'Wire model id',
  'vendors.form.promptCache': 'Prompt cache',
  'vendors.form.cacheAuto': 'auto (default)',
  'vendors.form.cacheOn': 'Force on',
  'vendors.form.cacheOff': 'Force off',
  'vendors.form.addModel': 'Add model',
  'vendors.form.removeModel': 'Remove',
  'vendors.form.needId': 'Vendor id is required',
  'vendors.form.needProtocol': 'Protocol is required',
  'vendors.form.needCredentialId': 'Credential id is required',
  'vendors.form.needEnvName': 'Environment variable name is required',
  'vendors.form.needModel': 'Register at least one model',
  'vendors.form.dupModel': 'Duplicate model id "{id}"',

  'default.title': 'Default model',
  'default.description':
    'models.default ref; the VESSEL_MODEL environment variable takes precedence when set.',
  'default.current': 'Effective',
  'default.none': 'Unresolved (no default or invalid config)',
  'default.ref': 'Default ref',
  'default.choose': 'Choose a ref…',
  'default.save': 'Set default',
  'default.legacy': 'Legacy entry',

  'aliases.title': 'Aliases',
  'aliases.description': 'Flat alias → vendor/model (alias-to-alias is rejected).',
  'aliases.add': 'Add alias',
  'aliases.th.alias': 'Alias',
  'aliases.th.ref': 'Target',
  'aliases.empty': 'No aliases yet',
  'aliases.form.addTitle': 'Add alias',
  'aliases.form.editTitle': 'Edit alias "{alias}"',
  'aliases.form.alias': 'Alias (no /)',
  'aliases.form.ref': 'Target ref',
  'aliases.needAlias': 'Alias is required',
  'aliases.needRef': 'Target ref is required',
  'aliases.noSlash': 'Alias must not contain /',
  'aliases.deleteConfirm': 'Delete alias "{alias}"?',

  'credentials.title': 'Credentials',
  'credentials.subtitle':
    'Encrypted credential store (AES-256-GCM). Values are write-only and never echoed; the list shows metadata only.',
  'credentials.add': 'Add credential',
  'credentials.rotate': 'Rotate',
  'credentials.th.id': 'Id',
  'credentials.th.createdAt': 'Created',
  'credentials.th.updatedAt': 'Updated',
  'credentials.th.usedBy': 'Used by',
  'credentials.empty.title': 'No credentials yet',
  'credentials.empty.description': 'Add a credential, then reference it from a vendor form.',
  'credentials.unused': 'Not referenced',
  'credentials.form.addTitle': 'Add credential',
  'credentials.form.rotateTitle': 'Rotate credential "{id}"',
  'credentials.form.id': 'Credential id',
  'credentials.form.value': 'Credential value',
  'credentials.form.valueHint':
    'Write-only input: never echoed or logged after submit; rotation overwrites the previous value.',
  'credentials.form.needId': 'Credential id is required',
  'credentials.form.needValue': 'Credential value is required',
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

  'vendors.title': '厂商与模型',
  'vendors.subtitle': '注册厂商、模型清单与别名；保存后下一具 body/run 生效。',
  'vendors.section': '厂商',
  'vendors.add': '添加厂商',
  'vendors.empty.title': '暂无注册厂商',
  'vendors.empty.description':
    '添加厂商并注册至少一个模型。legacy provider.* 条目会自动合成，只读显示。',
  'vendors.th.id': '厂商 ID',
  'vendors.th.protocol': '协议',
  'vendors.th.baseUrl': 'Base URL',
  'vendors.th.credential': '凭证',
  'vendors.th.models': '模型',
  'vendors.legacyHint': 'legacy provider.* 兼容条目（只读；请在配置文件中修改）',
  'vendors.inUse': '被引用',
  'vendors.modelCount': '{n} 个模型',
  'vendors.test': '测试（真实请求 · ~1 token）',
  'vendors.testRunning': '测试中…',
  'vendors.testHint':
    '测试会用已存凭证向厂商端点发真实请求：openai 系协议查询模型列表；anthropic（或指定模型）发 max_tokens=1 的最小请求（1 token 级成本）。绝不自动触发。',
  'vendors.testResult': '连通性测试结果',
  'vendors.testOk': '连通',
  'vendors.testFailed': '失败',
  'vendors.latency': '耗时：{ms} ms',
  'vendors.testModels': '返回 {n} 个模型',
  'vendors.importModels': '导入模型清单到表单',
  'vendors.deleteConfirm': '确认删除厂商「{id}」？',

  'vendors.form.addTitle': '添加厂商',
  'vendors.form.editTitle': '编辑厂商「{id}」',
  'vendors.form.id': '厂商 ID',
  'vendors.form.idHint': 'kebab-case（a-z0-9-，≤64 字符）；保存后不可改名',
  'vendors.form.protocol': '协议',
  'vendors.form.protocolHint':
    '已注册 provider 工厂名：openai / anthropic / google / mistral / ollama / cohere，或自定义 provider 插件协议',
  'vendors.form.baseUrl': 'Base URL（可选）',
  'vendors.form.baseUrlHint': '留空则用协议工厂的默认端点',
  'vendors.form.credentialSource': '凭证来源',
  'vendors.form.credentialNone': '无（厂商不需要密钥）',
  'vendors.form.credentialRef': '加密凭证引用',
  'vendors.form.apiKeyEnv': '环境变量',
  'vendors.form.credentialId': '凭证 ID',
  'vendors.form.credentialIdHint': '值在「凭证」页添加；这里只存引用，绝不存值',
  'vendors.form.apiKeyEnvName': '环境变量名',
  'vendors.form.models': '模型清单',
  'vendors.form.modelsHint': '至少 1 个模型；wire model id 可含 /（如 dashscope/qwen4-max）',
  'vendors.form.modelId': 'wire model id',
  'vendors.form.promptCache': 'Prompt 缓存',
  'vendors.form.cacheAuto': 'auto（默认）',
  'vendors.form.cacheOn': '强开',
  'vendors.form.cacheOff': '强关',
  'vendors.form.addModel': '添加模型',
  'vendors.form.removeModel': '移除',
  'vendors.form.needId': '厂商 ID 不能为空',
  'vendors.form.needProtocol': '协议不能为空',
  'vendors.form.needCredentialId': '凭证 ID 不能为空',
  'vendors.form.needEnvName': '环境变量名不能为空',
  'vendors.form.needModel': '至少注册一个模型',
  'vendors.form.dupModel': '模型 id 重复：「{id}」',

  'default.title': '默认模型',
  'default.description': 'models.default ref；VESSEL_MODEL 环境变量非空时优先。',
  'default.current': '当前生效',
  'default.none': '未解析（无默认或配置无效）',
  'default.ref': '默认 ref',
  'default.choose': '选择 ref…',
  'default.save': '设为默认',
  'default.legacy': 'legacy 条目',

  'aliases.title': '别名',
  'aliases.description': '扁平别名 → vendor/model（不允许别名指向别名）。',
  'aliases.add': '添加别名',
  'aliases.th.alias': '别名',
  'aliases.th.ref': '指向',
  'aliases.empty': '暂无别名',
  'aliases.form.addTitle': '添加别名',
  'aliases.form.editTitle': '编辑别名「{alias}」',
  'aliases.form.alias': '别名（不含 /）',
  'aliases.form.ref': '目标 ref',
  'aliases.needAlias': '别名不能为空',
  'aliases.needRef': '目标 ref 不能为空',
  'aliases.noSlash': '别名不能包含 /',
  'aliases.deleteConfirm': '确认删除别名「{alias}」？',

  'credentials.title': '凭证',
  'credentials.subtitle': '加密凭证库（AES-256-GCM）。值只写不回显；列表只有元数据，无值、无片段。',
  'credentials.add': '添加凭证',
  'credentials.rotate': '轮换',
  'credentials.th.id': 'ID',
  'credentials.th.createdAt': '创建时间',
  'credentials.th.updatedAt': '更新时间',
  'credentials.th.usedBy': '被引用',
  'credentials.empty.title': '暂无凭证',
  'credentials.empty.description': '添加凭证后，在厂商表单里引用它。',
  'credentials.unused': '未被引用',
  'credentials.form.addTitle': '添加凭证',
  'credentials.form.rotateTitle': '轮换凭证「{id}」',
  'credentials.form.id': '凭证 ID',
  'credentials.form.value': '凭证值',
  'credentials.form.valueHint': '只写输入：提交后不回显、不记录；轮换 = 覆盖旧值。',
  'credentials.form.needId': '凭证 ID 不能为空',
  'credentials.form.needValue': '凭证值不能为空',
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
