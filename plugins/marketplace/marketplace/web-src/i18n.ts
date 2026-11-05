/**
 * Marketplace copy. English is the fallback; `?lang=zh-CN` (or `zh`) selects
 * the Chinese table. Strings live here, not in `@vessel-agent/plugin-ui`.
 *
 * `EN` is the key source of truth (CONTRACT-0.46 §7): every other language is
 * `Record<MessageKey, string>`, so a missing or extra key is a typecheck error.
 */

import type { PluginScope } from './types';

export type Lang = 'en' | 'zh-CN';

type Vars = Record<string, string | number>;
export type Translator = (key: MessageKey, vars?: Vars) => string;

const EN = {
  'app.title': 'Plugins',
  'tabs.label': 'Plugin sections',
  'tab.marketplace': 'Marketplace',
  'tab.installed': 'My plugins',
  'tab.updates': 'Updates',
  'browse.title': 'Marketplace',
  'browse.subtitle': 'Install from a static registry. Every package is checksum-verified.',
  'browse.toolbar': 'Marketplace controls',
  'installed.title': 'My plugins',
  'installed.subtitle': 'Versions, scopes and updates for plugins on this machine.',
  'installed.toolbar': 'Installed plugin controls',
  'updates.title': 'Updates',
  'updates.subtitle': 'Checks the configured registry for newer versions.',
  'updates.toolbar': 'Update controls',
  'search.placeholder': 'Search plugins',
  'search.aria': 'Search plugins',
  'search.submit': 'Search',
  'category.label': 'Category',
  'category.all': 'All categories',
  'button.refresh': 'Refresh',
  'button.check': 'Check now',
  'button.retry': 'Retry',
  'button.details': 'Details',
  'button.install': 'Install',
  'button.reinstall': 'Reinstall latest',
  'button.update': 'Update',
  'button.remove': 'Remove',
  'button.back': '← Back',
  'button.cancel': 'Cancel',
  'state.loading': 'Loading…',
  'state.checking': 'Checking the registry…',
  'state.done': 'Done.',
  'state.noMatch': 'No matching plugins',
  'state.tryDifferent': 'Try a different search term or category.',
  'state.registryEmpty': 'The registry is empty',
  'state.registryEmptyDetail': 'No plugins have been published to this registry yet.',
  'installed.empty': 'No plugins installed',
  'installed.emptyDetail': 'Registry-installed and built-in plugins are both listed here.',
  'scope.builtin': 'Built-in',
  'scope.user': 'User',
  'scope.project': 'Project',
  'updates.none': 'Everything is up to date',
  'updates.noneDetail': 'No installed plugin has a newer version in the registry.',
  'updates.error': 'Could not check for updates',
  'updates.errorDetail': 'The installed plugins are listed, but the registry could not be read.',
  'updates.available.one': '{count} update available',
  'updates.available.other': '{count} updates available',
  'th.plugin': 'Plugin',
  'th.version': 'Version',
  'th.scope': 'Scope',
  'th.enabled': 'Enabled',
  'th.latest': 'Latest',
  'th.actions': 'Actions',
  'badge.enabled': 'enabled',
  'badge.disabled': 'disabled',
  'badge.installed': 'installed',
  'badge.latest': 'latest',
  'section.versions': 'Versions',
  'section.permissions': 'Permissions',
  'link.repository': 'repository',
  'link.homepage': 'homepage',
  'dialog.install.title': 'Install plugin?',
  'dialog.install.confirm': 'Install',
  'dialog.install.check': 'I have reviewed the permissions and trust this plugin',
  'dialog.remove.title': 'Remove plugin?',
  'dialog.remove.confirm': 'Remove',
  'dialog.remove.check': 'Remove {name} and its config entry',
  'permissions.declared': 'Declared permissions',
  'permissions.package': 'Package',
  'permissions.none': 'none',
  'permissions.allowed': 'allowed',
  'permissions.no': 'no',
  'package.size': 'Size',
  'package.bytes': '{size} bytes',
  'disclosure.install':
    'Installing {name} {version}. The plugin is not a security sandbox: it runs as a child process with your user permissions.',
  'disclosure.inactive':
    'After installation the plugin stays inactive until the watcher reloads it; the first page or RPC activates it.',
  'disclosure.installed': 'Installed {version} ({scope} scope)',
  'disclosure.installedDisabled': 'Installed {version} ({scope} scope, disabled)',
  'registry.custom.install':
    'Custom registry: {url}. Only install plugins you trust; this registry is not the default.',
  'registry.custom.banner': 'Custom registry: {url}. Treat it as untrusted content.',
  'registry.stale': 'Showing a cached registry index (refresh failed).',
  'registry.unavailable': 'Registry unavailable: {message}',
  'setup.title': 'Connect a registry',
  'setup.missing': 'registry_url is not set for this plugin.',
  'setup.hint':
    'Add this under plugins[].config in {path}, then save. The gateway hot-reloads plugins; restart if it does not.',
  'setup.unreachable': 'Could not reach the registry',
  'setup.url': 'Configured registry: {url}',
  'setup.defaultNote':
    'Default registry: {url}. Set registry_url in plugins[].config to use it or your own index.',
  'setup.customHint':
    'Set a custom registry under plugins[].config (registry_url), then save and retry.',
  'job.running': '{label} — {phase}',
  'job.failed': 'Job failed',
  'job.timeout': 'The job did not finish in time.',
  'job.noId': 'The host did not return a job id.',
  'job.phase.queued': 'queued',
  'job.phase.resolving': 'resolving',
  'job.phase.downloading': 'downloading',
  'job.phase.verifying': 'verifying',
  'job.phase.extracting': 'extracting',
  'job.phase.installing': 'installing',
  'job.phase.configuring': 'configuring',
  'job.phase.done': 'done',
  'job.phase.failed': 'failed',
  'rpc.timeout': 'The host did not answer this RPC in time.',
  'error.noVersion': 'This plugin has no installable version.',
  'remove.body':
    '{name} {version} is installed at {path} ({scope} scope). Its directory and plugins[] config entry are removed. The watcher deactivates the process and removes its pages.',
} as const;

export type MessageKey = keyof typeof EN;

const ZH: Record<MessageKey, string> = {
  'app.title': '插件',
  'tabs.label': '插件分区',
  'tab.marketplace': '插件市场',
  'tab.installed': '我的插件',
  'tab.updates': '更新',
  'browse.title': '插件市场',
  'browse.subtitle': '从静态插件源安装插件，每个包都会进行校验和校验。',
  'browse.toolbar': '插件市场控件',
  'installed.title': '我的插件',
  'installed.subtitle': '本机插件的版本、作用域与更新状态。',
  'installed.toolbar': '已安装插件控件',
  'updates.title': '更新',
  'updates.subtitle': '检查已配置的插件源是否有新版本。',
  'updates.toolbar': '更新控件',
  'search.placeholder': '搜索插件',
  'search.aria': '搜索插件',
  'search.submit': '搜索',
  'category.label': '分类',
  'category.all': '全部分类',
  'button.refresh': '刷新',
  'button.check': '立即检查',
  'button.retry': '重试',
  'button.details': '详情',
  'button.install': '安装',
  'button.reinstall': '重新安装最新版',
  'button.update': '更新',
  'button.remove': '移除',
  'button.back': '← 返回',
  'button.cancel': '取消',
  'state.loading': '加载中…',
  'state.checking': '正在检查插件源…',
  'state.done': '已完成。',
  'state.noMatch': '没有匹配的插件',
  'state.tryDifferent': '试试其它搜索词或分类。',
  'state.registryEmpty': '插件源为空',
  'state.registryEmptyDetail': '该插件源还没有发布任何插件。',
  'installed.empty': '尚未安装插件',
  'installed.emptyDetail': '从插件源安装的插件和内置插件都会列在这里。',
  'scope.builtin': '内置',
  'scope.user': '用户',
  'scope.project': '项目',
  'updates.none': '全部为最新',
  'updates.noneDetail': '插件源中没有已安装插件的新版本。',
  'updates.error': '无法检查更新',
  'updates.errorDetail': '已安装插件仍会列出，但无法读取插件源。',
  'updates.available.one': '有 {count} 个可用更新',
  'updates.available.other': '有 {count} 个可用更新',
  'th.plugin': '插件',
  'th.version': '版本',
  'th.scope': '作用域',
  'th.enabled': '启用',
  'th.latest': '最新',
  'th.actions': '操作',
  'badge.enabled': '已启用',
  'badge.disabled': '已停用',
  'badge.installed': '已安装',
  'badge.latest': '最新',
  'section.versions': '版本',
  'section.permissions': '权限',
  'link.repository': '仓库',
  'link.homepage': '主页',
  'dialog.install.title': '安装插件？',
  'dialog.install.confirm': '安装',
  'dialog.install.check': '我已查看权限并信任该插件',
  'dialog.remove.title': '移除插件？',
  'dialog.remove.confirm': '移除',
  'dialog.remove.check': '移除 {name} 及其配置项',
  'permissions.declared': '声明的权限',
  'permissions.package': '安装包',
  'permissions.none': '无',
  'permissions.allowed': '允许',
  'permissions.no': '否',
  'package.size': '大小',
  'package.bytes': '{size} 字节',
  'disclosure.install':
    '正在安装 {name} {version}。插件不是安全沙箱：它以你的用户权限在子进程中运行。',
  'disclosure.inactive': '安装后插件在 watcher 重载前保持未激活；首次打开页面或调用 RPC 时激活。',
  'disclosure.installed': '已安装 {version}（{scope}作用域）',
  'disclosure.installedDisabled': '已安装 {version}（{scope}作用域，已停用）',
  'registry.custom.install': '自定义插件源：{url}。只安装你信任的插件；这不是默认插件源。',
  'registry.custom.banner': '自定义插件源：{url}。请视为不可信内容。',
  'registry.stale': '显示缓存的插件源索引（刷新失败）。',
  'registry.unavailable': '插件源不可用：{message}',
  'setup.title': '连接插件源',
  'setup.missing': '该插件尚未设置 registry_url。',
  'setup.hint':
    '把上面的配置加到 {path} 的 plugins[].config 后保存；gateway 会热重载插件，未生效时请重启。',
  'setup.unreachable': '无法访问插件源',
  'setup.url': '已配置的插件源：{url}',
  'setup.defaultNote':
    '默认插件源：{url}。在 plugins[].config 设置 registry_url 可使用它或你自己的索引。',
  'setup.customHint': '在 plugins[].config（registry_url）设置自定义插件源，保存后重试。',
  'job.running': '{label} — {phase}',
  'job.failed': '任务失败',
  'job.timeout': '任务未能及时完成。',
  'job.noId': '宿主未返回任务 id。',
  'job.phase.queued': '排队中',
  'job.phase.resolving': '解析中',
  'job.phase.downloading': '下载中',
  'job.phase.verifying': '校验中',
  'job.phase.extracting': '解压中',
  'job.phase.installing': '安装中',
  'job.phase.configuring': '配置中',
  'job.phase.done': '完成',
  'job.phase.failed': '失败',
  'rpc.timeout': '宿主未及时响应此 RPC。',
  'error.noVersion': '该插件没有可安装的版本。',
  'remove.body':
    '{name} {version} 安装在 {path}（{scope}作用域）。其目录和 plugins[] 配置项将被移除；watcher 会停用进程并移除页面。',
};

export const I18N: Record<Lang, Record<MessageKey, string>> = {
  en: EN,
  'zh-CN': ZH,
};

/** The `scope` DTO values are wire identifiers; map them to message keys. */
export const SCOPE_MESSAGE_KEY = {
  builtin: 'scope.builtin',
  user: 'scope.user',
  project: 'scope.project',
} as const satisfies Record<PluginScope, MessageKey>;

/** Child job phases are wire strings; unknown phases fall back to the raw value. */
export const PHASE_MESSAGE_KEY: Record<string, MessageKey> = {
  queued: 'job.phase.queued',
  resolving: 'job.phase.resolving',
  downloading: 'job.phase.downloading',
  verifying: 'job.phase.verifying',
  extracting: 'job.phase.extracting',
  installing: 'job.phase.installing',
  configuring: 'job.phase.configuring',
  done: 'job.phase.done',
  failed: 'job.phase.failed',
};

export function normalizeLang(raw: string | undefined): Lang {
  return raw?.trim().toLowerCase().startsWith('zh') === true ? 'zh-CN' : 'en';
}

export function translator(lang: string): Translator {
  const table = I18N[normalizeLang(lang)];
  return (key, vars) => {
    let text = table[key] ?? EN[key];
    for (const [name, value] of Object.entries(vars ?? {})) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  };
}
