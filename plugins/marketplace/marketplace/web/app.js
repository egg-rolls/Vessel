/**
 * Marketplace plugin UI — one page, three client-side tabs.
 *
 * Static vanilla JS: no build, no direct network, no gateway token. Every read
 * and write goes through the host bridge:
 *   iframe -> host: {type:'vessel.plugin.rpc', id, method, params}
 *   host -> iframe: {type:'vessel.plugin.rpc.result', id, result|error}
 *
 * `?lang=zh-CN` (or `en`) selects tab/button strings; English is the fallback.
 * Install is never one click: the detail dialog discloses fs/net/process/
 * secrets/events/rpc and requires an explicit confirmation checkbox.
 */
(() => {
  const LANGUAGE = (() => {
    const requested = new URLSearchParams(window.location.search).get('lang');
    return requested === 'zh-CN' || requested === 'zh' ? 'zh-CN' : 'en';
  })();

  const I18N = {
    en: {
      'tab.marketplace': 'Marketplace',
      'tab.installed': 'My plugins',
      'tab.updates': 'Updates',
      'browse.title': 'Marketplace',
      'browse.subtitle': 'Install from a static registry. Every package is checksum-verified.',
      'installed.title': 'My plugins',
      'installed.subtitle': 'Versions, scopes and updates for plugins on this machine.',
      'updates.title': 'Updates',
      'updates.subtitle': 'Checks the configured registry for newer versions.',
      'search.placeholder': 'Search plugins',
      'search.aria': 'Search plugins',
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
      'installed.emptyDetail':
        'Plugins installed from the registry appear here. Built-in plugins are not listed.',
      'updates.none': 'Everything is up to date',
      'updates.noneDetail': 'No installed plugin has a newer version in the registry.',
      'updates.error': 'Could not check for updates',
      'updates.errorDetail':
        'The installed plugins are listed, but the registry could not be read.',
      'updates.available.one': '{count} update available',
      'updates.available.other': '{count} updates available',
      'th.plugin': 'Plugin',
      'th.version': 'Version',
      'th.scope': 'Scope',
      'th.enabled': 'Enabled',
      'th.latest': 'Latest',
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
      'job.failed': 'Job failed',
      'job.timeout': 'The job did not finish in time.',
      'job.noId': 'The host did not return a job id.',
      'rpc.timeout': 'The host did not answer this RPC in time.',
      'error.noVersion': 'This plugin has no installable version.',
      'remove.body':
        '{name} {version} is installed at {path} ({scope} scope). Its directory and plugins[] config entry are removed. The watcher deactivates the process and removes its pages.',
    },
    'zh-CN': {
      'tab.marketplace': '插件市场',
      'tab.installed': '我的插件',
      'tab.updates': '更新',
      'browse.title': '插件市场',
      'browse.subtitle': '从静态 registry 安装插件，每个包都会校验校验和。',
      'installed.title': '我的插件',
      'installed.subtitle': '本机插件的版本、作用域与更新状态。',
      'updates.title': '更新',
      'updates.subtitle': '检查配置的 registry 是否有新版本。',
      'search.placeholder': '搜索插件',
      'search.aria': '搜索插件',
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
      'state.checking': '正在检查 registry…',
      'state.done': '已完成。',
      'state.noMatch': '没有匹配的插件',
      'state.tryDifferent': '试试其它搜索词或分类。',
      'state.registryEmpty': 'Registry 为空',
      'state.registryEmptyDetail': '该 registry 还没有发布任何插件。',
      'installed.empty': '尚未安装插件',
      'installed.emptyDetail': '从 registry 安装的插件会出现在这里；内置插件不列出。',
      'updates.none': '全部为最新',
      'updates.noneDetail': 'registry 中没有已安装插件的新版本。',
      'updates.error': '无法检查更新',
      'updates.errorDetail': '已安装插件仍会列出，但无法读取 registry。',
      'updates.available.one': '有 {count} 个可用更新',
      'updates.available.other': '有 {count} 个可用更新',
      'th.plugin': '插件',
      'th.version': '版本',
      'th.scope': '作用域',
      'th.enabled': '启用',
      'th.latest': '最新',
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
      'disclosure.install':
        '正在安装 {name} {version}。插件不是安全沙箱：它以你的用户权限在子进程中运行。',
      'disclosure.inactive':
        '安装后插件在 watcher 重载前保持未激活；首次打开页面或调用 RPC 时激活。',
      'disclosure.installed': '已安装 {version}（{scope} 作用域）',
      'disclosure.installedDisabled': '已安装 {version}（{scope} 作用域，已停用）',
      'registry.custom.install':
        '自定义 registry：{url}。只安装你信任的插件；这不是默认 registry。',
      'registry.custom.banner': '自定义 registry：{url}。请视为不可信内容。',
      'registry.stale': '显示缓存的 registry 索引（刷新失败）。',
      'registry.unavailable': 'Registry 不可用：{message}',
      'job.failed': '任务失败',
      'job.timeout': '任务未能及时完成。',
      'job.noId': '宿主未返回任务 id。',
      'rpc.timeout': '宿主未及时响应此 RPC。',
      'error.noVersion': '该插件没有可安装的版本。',
      'remove.body':
        '{name} {version} 安装在 {path}（{scope} 作用域）。其目录和 plugins[] 配置项将被移除；watcher 会停用进程并移除页面。',
    },
  };

  function t(key, vars) {
    const table = I18N[LANGUAGE] || I18N.en;
    let text = table[key] ?? I18N.en[key] ?? key;
    for (const [name, value] of Object.entries(vars || {})) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }

  const RPC_TIMEOUT_MS = 15000;
  const MUTATION_TIMEOUT_MS = 120000;
  const JOB_POLL_MS = 500;
  const JOB_MAX_MS = 30 * 60 * 1000;

  const pending = new Map();
  let nextRpcId = 1;
  let refreshTimer;
  let reload = () => {};

  // ---------------------------------------------------------------- bridge

  function rpc(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextRpcId;
      nextRpcId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(t('rpc.timeout')));
      }, timeoutMs || RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage(
        { type: 'vessel.plugin.rpc', id, method, params: params || {} },
        '*',
      );
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    // Sandboxed iframes report the opaque origin "null"; a non-sandboxed mount
    // reports the gateway origin. Anything else is not our host.
    if (event.origin !== 'null' && event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'vessel.plugin.refresh') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => reload(), 250);
      return;
    }
    if (data.type !== 'vessel.plugin.rpc.result') return;

    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) {
      const message =
        typeof data.error === 'string'
          ? data.error
          : data.error.message || data.error.code || t('job.failed');
      entry.reject(new Error(message));
    } else {
      entry.resolve(data.result);
    }
  });

  // ------------------------------------------------------------------- dom

  function node(tag, attrs, children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') element.textContent = String(value);
      else if (key === 'class') element.className = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        element.setAttribute(key, String(value));
      }
    }
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === undefined || child === null || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  }

  function statusBar() {
    return document.getElementById('status');
  }

  function pageHeader(title, subtitle, controls) {
    return node('header', { class: 'page-head' }, [
      node('div', {}, [node('h1', { text: title }), node('p', { class: 'sub', text: subtitle })]),
      controls && controls.length > 0 ? node('div', { class: 'controls' }, controls) : null,
    ]);
  }

  function loading(label) {
    return node('div', { class: 'loading', text: label || t('state.loading') });
  }

  function emptyState(title, detail) {
    return node('div', { class: 'empty' }, [
      node('div', { class: 'empty-title', text: title }),
      node('p', { text: detail }),
    ]);
  }

  function errorState(error, retry) {
    const message = error?.message ? error.message : String(error);
    return node('div', { class: 'error' }, [
      node('p', { text: message }),
      node('button', { class: 'primary', text: t('button.retry'), onclick: retry }),
    ]);
  }

  function banner(kind, text) {
    return node('div', { class: `banner ${kind}`, text });
  }

  function badge(text, kind) {
    return node('span', { class: `badge ${kind || 'ok'}`, text });
  }

  function section(title, content) {
    return node('section', { class: 'section' }, [
      node('h2', { class: 'section-title', text: title }),
      content,
    ]);
  }

  // ------------------------------------------------------------- dialogs

  function dialog(options) {
    return new Promise((resolve) => {
      const overlay = node('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
      let settled = false;
      const close = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') close(false);
      };
      document.addEventListener('keydown', onKey);

      const checkbox = options.requireConfirm
        ? node('input', { type: 'checkbox', id: 'confirm-check' })
        : null;
      const confirm = node('button', {
        class: options.danger ? 'danger' : 'primary',
        text: options.confirmLabel,
        ...(checkbox ? { disabled: 'disabled' } : {}),
        onclick: () => close(true),
      });
      if (checkbox) {
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) confirm.removeAttribute('disabled');
          else confirm.setAttribute('disabled', 'disabled');
        });
      }

      const card = node('div', { class: 'dialog' }, [
        node('h2', { text: options.title }),
        options.body,
        checkbox
          ? node('label', { class: 'check', for: 'confirm-check' }, [
              checkbox,
              node('span', { text: options.confirmText }),
            ])
          : null,
        node('div', { class: 'dialog-actions' }, [
          node('button', { text: t('button.cancel'), onclick: () => close(false) }),
          confirm,
        ]),
      ]);
      overlay.append(card);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close(false);
      });
      document.body.append(overlay);
      if (checkbox) checkbox.focus();
      else confirm.focus();
    });
  }

  function permissionRows(permissions) {
    const perms = permissions || {};
    const none = t('permissions.none');
    const scopes = [
      ['fs', Array.isArray(perms.fs) && perms.fs.length > 0 ? perms.fs.join(', ') : none],
      ['net', Array.isArray(perms.net) && perms.net.length > 0 ? perms.net.join(', ') : none],
      ['process', perms.process === true ? t('permissions.allowed') : t('permissions.no')],
      ['secrets', perms.secrets === true ? t('permissions.allowed') : t('permissions.no')],
      [
        'events',
        Array.isArray(perms.events) && perms.events.length > 0 ? perms.events.join(', ') : none,
      ],
      ['rpc', Array.isArray(perms.rpc) && perms.rpc.length > 0 ? perms.rpc.join(', ') : none],
    ];
    return node(
      'dl',
      { class: 'perms' },
      scopes.flatMap(([name, value]) => [
        node('dt', { text: name }),
        node('dd', { class: value === none ? 'muted' : '', text: value }),
      ]),
    );
  }

  function disclosureBody(plugin, version, registry) {
    const children = [
      node('p', {
        text: t('disclosure.install', {
          name: plugin.name || plugin.id,
          version: version.version,
        }),
      }),
      node('h3', { text: t('permissions.declared') }),
      permissionRows(version.permissions),
      node('h3', { text: t('permissions.package') }),
      node('dl', { class: 'perms' }, [
        node('dt', { text: 'sha256' }),
        node('dd', { class: 'mono', text: version.asset.sha256 }),
        node('dt', { text: 'size' }),
        node('dd', { text: `${version.asset.size.toLocaleString('en-US')} bytes` }),
      ]),
    ];
    if (registry && registry.trusted === false) {
      children.unshift(banner('danger', t('registry.custom.install', { url: registry.url })));
    }
    children.push(node('p', { class: 'muted', text: t('disclosure.inactive') }));
    return node('div', {}, children);
  }

  async function confirmInstall(plugin, version, registry) {
    const ok = await dialog({
      title: t('dialog.install.title'),
      body: disclosureBody(plugin, version, registry),
      confirmLabel: t('dialog.install.confirm'),
      requireConfirm: true,
      confirmText: t('dialog.install.check'),
    });
    if (!ok) return;
    await runJob(
      `${t('button.install')} ${plugin.name || plugin.id} ${version.version}`,
      () => rpc('install', { id: plugin.id, version: version.version }, MUTATION_TIMEOUT_MS),
      () => reload(),
    );
  }

  async function confirmRemove(item) {
    const ok = await dialog({
      title: t('dialog.remove.title'),
      danger: true,
      confirmLabel: t('dialog.remove.confirm'),
      requireConfirm: true,
      confirmText: t('dialog.remove.check', { name: item.name || item.id }),
      body: node('p', {
        text: t('remove.body', {
          name: item.name || item.id,
          version: item.version,
          path: item.path,
          scope: item.scope,
        }),
      }),
    });
    if (!ok) return;
    await runMutation(
      `${t('button.remove')} ${item.name || item.id}…`,
      () => rpc('remove', { id: item.id }, MUTATION_TIMEOUT_MS),
      () => reload(),
    );
  }

  async function runMutation(label, action, done) {
    const status = statusBar();
    if (status) status.replaceChildren(loading(label));
    try {
      await action();
      if (status) status.replaceChildren(banner('ok', t('state.done')));
      done();
    } catch (error) {
      if (status) {
        status.replaceChildren(banner('danger', error.message ? error.message : String(error)));
      }
    }
  }

  function fmtBytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function jobNode(label, job) {
    const total = typeof job.bytes_total === 'number' ? job.bytes_total : 0;
    const done = typeof job.bytes_done === 'number' ? job.bytes_done : 0;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const head = node('div', { class: 'job-head' }, [
      node('span', { text: `${label} — ${job.phase || job.status}` }),
      node('span', {
        class: 'mono small',
        text: total > 0 ? `${fmtBytes(done)} / ${fmtBytes(total)}` : '',
      }),
    ]);
    const bar =
      total > 0
        ? node('div', { class: 'progress' }, [
            node('div', { class: 'progress-fill', style: `width:${percent}%` }),
          ])
        : null;
    return [node('div', { class: 'job' }, [head, bar])];
  }

  /**
   * install/update return `{job_id}` immediately; poll `job` until it finishes
   * so a large download never sits on the host's 10s RPC timeout.
   */
  async function pollJob(jobId, label) {
    const status = statusBar();
    const started = Date.now();
    for (;;) {
      const job = await rpc('job', { job_id: jobId });
      if (status) status.replaceChildren(...jobNode(label, job));
      if (job.status === 'done') return job;
      if (job.status === 'failed') {
        const message = job.error?.message ? job.error.message : t('job.failed');
        throw new Error(message);
      }
      if (Date.now() - started > JOB_MAX_MS) throw new Error(t('job.timeout'));
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    }
  }

  async function runJob(label, action, done) {
    const status = statusBar();
    if (status) status.replaceChildren(loading(`${label}…`));
    try {
      const started = await action();
      if (!started?.job_id) throw new Error(t('job.noId'));
      await pollJob(started.job_id, label);
      if (status) status.replaceChildren(banner('ok', t('state.done')));
      done();
    } catch (error) {
      if (status) {
        status.replaceChildren(banner('danger', error.message ? error.message : String(error)));
      }
    }
  }

  // ------------------------------------------------------------------ browse

  function registryBanners(data) {
    const children = [];
    if (data?.registry?.trusted === false) {
      children.push(banner('danger', t('registry.custom.banner', { url: data.registry.url })));
    }
    if (data?.registry?.stale) {
      children.push(banner('warn', t('registry.stale')));
    }
    return children;
  }

  function pluginCard(plugin, registry, onDetail) {
    const installed = plugin.installed_version;
    return node('article', { class: 'card plugin-card' }, [
      node('div', { class: 'card-top' }, [
        node('div', {}, [
          node('h3', { text: plugin.name || plugin.id }),
          node('div', { class: 'mono muted', text: plugin.id }),
        ]),
        installed
          ? badge(`${t('badge.installed')} ${installed}`, plugin.update_available ? 'warn' : 'ok')
          : badge(plugin.latest, 'muted'),
      ]),
      node('p', { class: 'summary', text: plugin.summary || plugin.description || '' }),
      node(
        'div',
        { class: 'chips' },
        [
          plugin.category ? node('span', { class: 'chip', text: plugin.category }) : null,
          ...(plugin.tags || [])
            .slice(0, 5)
            .map((tag) => node('span', { class: 'chip', text: tag })),
        ].filter(Boolean),
      ),
      node('div', { class: 'card-actions' }, [
        node('button', { text: t('button.details'), onclick: () => onDetail(plugin.id) }),
        node('button', {
          class: 'primary',
          text: installed ? t('button.reinstall') : t('button.install'),
          onclick: () => quickInstall(plugin, registry),
        }),
      ]),
    ]);
  }

  async function quickInstall(plugin, registry) {
    try {
      const detail = await rpc('detail', { id: plugin.id });
      const versions = detail.plugin.versions || [];
      const target =
        versions.find((version) => version.version === plugin.latest) ||
        versions[versions.length - 1];
      if (!target) throw new Error(t('error.noVersion'));
      await confirmInstall(detail.plugin, target, detail.registry || registry);
    } catch (error) {
      const status = statusBar();
      if (status) status.replaceChildren(banner('danger', error.message || String(error)));
    }
  }

  function renderBrowse(root) {
    const content = node('div');
    const search = node('input', {
      type: 'search',
      placeholder: t('search.placeholder'),
      'aria-label': t('search.aria'),
    });
    const category = node('select', { 'aria-label': t('category.all') }, [
      node('option', { value: '', text: t('category.all') }),
    ]);
    const current = { query: '', category: '' };

    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        current.query = search.value.trim();
        load();
      }
    });
    category.addEventListener('change', () => {
      current.category = category.value;
      load();
    });
    const refresh = node('button', { text: t('button.refresh'), onclick: () => load() });

    root.replaceChildren(
      pageHeader(t('browse.title'), t('browse.subtitle'), [search, category, refresh]),
      content,
    );

    function fillCategories(categories) {
      const selected = category.value;
      category.replaceChildren(
        node('option', { value: '', text: t('category.all') }),
        ...(categories || []).map((item) => node('option', { value: item, text: item })),
      );
      category.value = selected;
    }

    function load() {
      content.replaceChildren(loading());
      rpc('search', current)
        .then((data) => {
          fillCategories(data.categories);
          render(data);
        })
        .catch((error) => content.replaceChildren(errorState(error, load)));
    }

    function render(data) {
      const items = data.items || [];
      if (items.length === 0) {
        content.replaceChildren(
          ...registryBanners(data),
          emptyState(
            current.query || current.category ? t('state.noMatch') : t('state.registryEmpty'),
            current.query || current.category
              ? t('state.tryDifferent')
              : t('state.registryEmptyDetail'),
          ),
        );
        return;
      }
      content.replaceChildren(
        ...registryBanners(data),
        node(
          'div',
          { class: 'grid' },
          items.map((plugin) => pluginCard(plugin, data.registry, (id) => showDetail(id))),
        ),
      );
    }

    function showDetail(id) {
      content.replaceChildren(loading());
      rpc('detail', { id })
        .then((data) => {
          const plugin = data.plugin;
          const versions = (plugin.versions || []).slice().reverse();
          const installedBanner = data.installed
            ? banner(
                data.installed.enabled ? 'ok' : 'warn',
                t(
                  data.installed.enabled ? 'disclosure.installed' : 'disclosure.installedDisabled',
                  { version: data.installed.version, scope: data.installed.scope },
                ),
              )
            : null;
          content.replaceChildren(
            ...registryBanners(data),
            node('div', { class: 'detail-head' }, [
              node('button', { text: t('button.back'), onclick: () => load() }),
              node('div', {}, [
                node('h2', { text: plugin.name || plugin.id }),
                node('div', { class: 'mono muted', text: plugin.id }),
              ]),
            ]),
            node('p', { class: 'summary', text: plugin.description || plugin.summary || '' }),
            node('div', { class: 'chips' }, [
              plugin.category ? node('span', { class: 'chip', text: plugin.category }) : null,
              ...(plugin.tags || []).map((tag) => node('span', { class: 'chip', text: tag })),
              plugin.repo
                ? node('a', {
                    class: 'chip link',
                    href: plugin.repo,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: t('link.repository'),
                  })
                : null,
              plugin.homepage
                ? node('a', {
                    class: 'chip link',
                    href: plugin.homepage,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: t('link.homepage'),
                  })
                : null,
            ]),
            installedBanner,
            section(
              t('section.versions'),
              node(
                'div',
                { class: 'versions' },
                versions.map((version) =>
                  node('div', { class: 'version-row' }, [
                    node('div', {}, [
                      node('div', { class: 'version-line' }, [
                        node('strong', { text: version.version }),
                        version.version === plugin.latest ? badge(t('badge.latest'), 'ok') : null,
                        version.version === data.installed?.version
                          ? badge(t('badge.installed'), 'muted')
                          : null,
                      ]),
                      node('div', {
                        class: 'mono muted small',
                        text: `sha256 ${version.asset.sha256.slice(0, 16)}… · ${version.asset.size.toLocaleString(
                          'en-US',
                        )} bytes`,
                      }),
                      node('details', {}, [
                        node('summary', { text: t('section.permissions') }),
                        permissionRows(version.permissions),
                      ]),
                    ]),
                    node('button', {
                      class: 'primary',
                      text: t('button.install'),
                      onclick: () => confirmInstall(plugin, version, data.registry),
                    }),
                  ]),
                ),
              ),
            ),
          );
        })
        .catch((error) => content.replaceChildren(errorState(error, load)));
    }

    reload = load;
    load();
  }

  // --------------------------------------------------------------- installed

  function installedTable(items, actions) {
    const head = node('thead', {}, [
      node(
        'tr',
        {},
        [t('th.plugin'), t('th.version'), t('th.scope'), t('th.enabled'), t('th.latest'), ''].map(
          (label) => node('th', { text: label }),
        ),
      ),
    ]);
    const body = node(
      'tbody',
      {},
      items.map((item) => {
        const update = item.update_available
          ? node('button', {
              class: 'primary small',
              text: t('button.update'),
              onclick: () => actions.update(item),
            })
          : null;
        return node('tr', {}, [
          node('td', {}, [
            node('div', { text: item.name || item.id }),
            node('div', { class: 'mono muted small', text: item.id }),
          ]),
          node('td', { class: 'mono', text: item.version }),
          node('td', { text: item.scope }),
          node('td', {}, [
            item.enabled ? badge(t('badge.enabled'), 'ok') : badge(t('badge.disabled'), 'warn'),
          ]),
          node('td', { class: 'mono', text: item.latest || '—' }),
          node('td', { class: 'row-actions' }, [
            update,
            node('button', {
              class: 'danger small',
              text: t('button.remove'),
              onclick: () => actions.remove(item),
            }),
          ]),
        ]);
      }),
    );
    return node('div', { class: 'table-wrap' }, [node('table', {}, [head, body])]);
  }

  function registryNote(data) {
    const children = [];
    if (data.registry_error) {
      children.push(banner('warn', t('registry.unavailable', { message: data.registry_error })));
    }
    if (data.registry && data.registry.trusted === false) {
      children.push(banner('danger', t('registry.custom.banner', { url: data.registry.url })));
    }
    return children;
  }

  function renderInstalled(root) {
    const content = node('div');

    root.replaceChildren(
      pageHeader(t('installed.title'), t('installed.subtitle'), [
        node('button', { text: t('button.refresh'), onclick: () => load() }),
      ]),
      content,
    );

    function load() {
      content.replaceChildren(loading());
      rpc('installed', {})
        .then((data) => {
          const items = data.items || [];
          if (items.length === 0) {
            content.replaceChildren(
              ...registryNote(data),
              emptyState(t('installed.empty'), t('installed.emptyDetail')),
            );
            return;
          }
          content.replaceChildren(
            ...registryNote(data),
            installedTable(items, {
              update: (item) =>
                runJob(
                  `${t('button.update')} ${item.name || item.id}`,
                  () => rpc('update', { id: item.id }, MUTATION_TIMEOUT_MS),
                  () => load(),
                ),
              remove: (item) => confirmRemove(item),
            }),
          );
        })
        .catch((error) => content.replaceChildren(errorState(error, load)));
    }

    reload = load;
    load();
  }

  // ----------------------------------------------------------------- updates

  function renderUpdates(root) {
    const content = node('div');

    root.replaceChildren(
      pageHeader(t('updates.title'), t('updates.subtitle'), [
        node('button', { text: t('button.check'), onclick: () => load(true) }),
      ]),
      content,
    );

    function load(force) {
      content.replaceChildren(loading(force ? t('state.checking') : t('state.loading')));
      rpc('installed', { force: force === true })
        .then((data) => {
          const items = (data.items || []).filter((item) => item.update_available);
          if (items.length === 0) {
            content.replaceChildren(
              ...registryNote(data),
              emptyState(
                data.registry_error ? t('updates.error') : t('updates.none'),
                data.registry_error ? t('updates.errorDetail') : t('updates.noneDetail'),
              ),
            );
            return;
          }
          content.replaceChildren(
            ...registryNote(data),
            banner(
              'warn',
              t(items.length === 1 ? 'updates.available.one' : 'updates.available.other', {
                count: items.length,
              }),
            ),
            installedTable(items, {
              update: (item) =>
                runJob(
                  `${t('button.update')} ${item.name || item.id}`,
                  () => rpc('update', { id: item.id }, MUTATION_TIMEOUT_MS),
                  () => load(true),
                ),
              remove: (item) => confirmRemove(item),
            }),
          );
        })
        .catch((error) => content.replaceChildren(errorState(error, () => load(force))));
    }

    reload = () => load(false);
    load(false);
  }

  // ------------------------------------------------------------------- tabs

  const RENDERERS = {
    browse: renderBrowse,
    installed: renderInstalled,
    updates: renderUpdates,
  };

  function selectTab(tab) {
    if (!RENDERERS[tab]) tab = 'browse';
    for (const button of document.querySelectorAll('#tabs [data-tab]')) {
      button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    }
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== tab;
    }
    const status = statusBar();
    if (status) status.replaceChildren();
    RENDERERS[tab](document.getElementById(`panel-${tab}`));
  }

  function applyLanguage() {
    document.documentElement.lang = LANGUAGE;
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.dataset.i18n || '');
    }
  }

  applyLanguage();
  for (const button of document.querySelectorAll('#tabs [data-tab]')) {
    button.addEventListener('click', () => selectTab(button.dataset.tab));
  }
  selectTab('browse');
})();
