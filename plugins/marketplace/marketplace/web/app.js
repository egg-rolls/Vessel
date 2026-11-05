/**
 * Marketplace plugin UI.
 *
 * Static vanilla JS: no build, no direct network, no gateway token. Every read
 * and write goes through the host bridge:
 *   iframe -> host: {type:'vessel.plugin.rpc', id, method, params}
 *   host -> iframe: {type:'vessel.plugin.rpc.result', id, result|error}
 *
 * Install is never one click: the detail dialog discloses fs/net/process/
 * secrets/events/rpc and requires an explicit confirmation checkbox. A
 * non-default registry is called out in red.
 */
(() => {
  const PAGES = [
    { id: 'browse', label: 'Browse', file: 'browse.html' },
    { id: 'installed', label: 'Installed', file: 'installed.html' },
    { id: 'updates', label: 'Updates', file: 'updates.html' },
  ];
  const PAGE = document.body.dataset.page || 'browse';
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
        reject(new Error('The host did not answer this RPC in time.'));
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
          : data.error.message || data.error.code || 'RPC failed';
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

  function tabBar() {
    return node(
      'nav',
      { class: 'tabs', 'aria-label': 'Marketplace' },
      PAGES.map((page) =>
        node('a', {
          href: `./${page.file}`,
          text: page.label,
          ...(page.id === PAGE ? { 'aria-current': 'page' } : {}),
        }),
      ),
    );
  }

  function view() {
    return document.getElementById('view');
  }

  function pageHeader(title, subtitle, controls) {
    return node('header', { class: 'page-head' }, [
      node('div', {}, [node('h1', { text: title }), node('p', { class: 'sub', text: subtitle })]),
      controls && controls.length > 0 ? node('div', { class: 'controls' }, controls) : null,
    ]);
  }

  function loading(label) {
    return node('div', { class: 'loading', text: label || 'Loading…' });
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
      node('button', { class: 'primary', text: 'Retry', onclick: retry }),
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
        text: options.confirmLabel || 'Confirm',
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
              node('span', { text: options.confirmText || 'I understand and want to continue' }),
            ])
          : null,
        node('div', { class: 'dialog-actions' }, [
          node('button', { text: 'Cancel', onclick: () => close(false) }),
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
    const scopes = [
      ['fs', Array.isArray(perms.fs) && perms.fs.length > 0 ? perms.fs.join(', ') : 'none'],
      ['net', Array.isArray(perms.net) && perms.net.length > 0 ? perms.net.join(', ') : 'none'],
      ['process', perms.process === true ? 'allowed' : 'no'],
      ['secrets', perms.secrets === true ? 'allowed' : 'no'],
      [
        'events',
        Array.isArray(perms.events) && perms.events.length > 0 ? perms.events.join(', ') : 'none',
      ],
      ['rpc', Array.isArray(perms.rpc) && perms.rpc.length > 0 ? perms.rpc.join(', ') : 'none'],
    ];
    return node(
      'dl',
      { class: 'perms' },
      scopes.flatMap(([name, value]) => [
        node('dt', { text: name }),
        node('dd', { class: value === 'none' ? 'muted' : '', text: value }),
      ]),
    );
  }

  function disclosureBody(plugin, version, registry) {
    const children = [
      node('p', {
        text: `Installing ${plugin.name || plugin.id} ${version.version}. The plugin is not a security sandbox: it runs as a child process with your user permissions.`,
      }),
      node('h3', { text: 'Declared permissions' }),
      permissionRows(version.permissions),
      node('h3', { text: 'Package' }),
      node('dl', { class: 'perms' }, [
        node('dt', { text: 'sha256' }),
        node('dd', { class: 'mono', text: version.asset.sha256 }),
        node('dt', { text: 'size' }),
        node('dd', { text: `${version.asset.size.toLocaleString('en-US')} bytes` }),
      ]),
    ];
    if (registry && registry.trusted === false) {
      children.unshift(
        banner(
          'danger',
          `Custom registry: ${registry.url}. Only install plugins you trust; this registry is not the default.`,
        ),
      );
    }
    children.push(
      node('p', {
        class: 'muted',
        text: 'After installation the plugin stays inactive until the watcher reloads it; the first page or RPC activates it.',
      }),
    );
    return node('div', {}, children);
  }

  async function confirmInstall(plugin, version, registry) {
    const ok = await dialog({
      title: 'Install plugin?',
      body: disclosureBody(plugin, version, registry),
      confirmLabel: 'Install',
      requireConfirm: true,
      confirmText: 'I have reviewed the permissions and trust this plugin',
    });
    if (!ok) return;
    await runJob(
      `Installing ${plugin.name || plugin.id} ${version.version}`,
      () => rpc('install', { id: plugin.id, version: version.version }, MUTATION_TIMEOUT_MS),
      () => reload(),
    );
  }

  async function confirmRemove(item) {
    const ok = await dialog({
      title: 'Remove plugin?',
      danger: true,
      confirmLabel: 'Remove',
      requireConfirm: true,
      confirmText: `Remove ${item.name || item.id} and its config entry`,
      body: node('div', {}, [
        node('p', {
          text: `${item.name || item.id} ${item.version} is installed at ${item.path} (${item.scope} scope).`,
        }),
        node('p', {
          class: 'muted',
          text: 'Its directory and plugins[] config entry are removed. The watcher deactivates the process and removes its pages.',
        }),
      ]),
    });
    if (!ok) return;
    await runMutation(
      `Removing ${item.name || item.id}…`,
      () => rpc('remove', { id: item.id }, MUTATION_TIMEOUT_MS),
      () => reload(),
    );
  }

  async function runMutation(label, action, done) {
    const status = document.getElementById('status');
    if (status) status.replaceChildren(loading(label));
    try {
      await action();
      if (status) status.replaceChildren(banner('ok', 'Done.'));
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
    const status = document.getElementById('status');
    const started = Date.now();
    for (;;) {
      const job = await rpc('job', { job_id: jobId });
      if (status) status.replaceChildren(...jobNode(label, job));
      if (job.status === 'done') return job;
      if (job.status === 'failed') {
        const message = job.error?.message ? job.error.message : 'Job failed';
        throw new Error(message);
      }
      if (Date.now() - started > JOB_MAX_MS) throw new Error('The job did not finish in time.');
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    }
  }

  async function runJob(label, action, done) {
    const status = document.getElementById('status');
    if (status) status.replaceChildren(loading(`${label}…`));
    try {
      const started = await action();
      if (!started?.job_id) throw new Error('The host did not return a job id.');
      await pollJob(started.job_id, label);
      if (status) status.replaceChildren(banner('ok', 'Done.'));
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
      children.push(
        banner('danger', `Custom registry: ${data.registry.url}. Treat it as untrusted content.`),
      );
    }
    if (data?.registry?.stale) {
      children.push(banner('warn', 'Showing a cached registry index (refresh failed).'));
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
          ? badge(`installed ${installed}`, plugin.update_available ? 'warn' : 'ok')
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
        node('button', { text: 'Details', onclick: () => onDetail(plugin.id) }),
        node('button', {
          class: 'primary',
          text: installed ? 'Reinstall latest' : 'Install',
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
      if (!target) throw new Error('This plugin has no installable version.');
      await confirmInstall(detail.plugin, target, detail.registry || registry);
    } catch (error) {
      const status = document.getElementById('status');
      if (status) status.replaceChildren(banner('danger', error.message || String(error)));
    }
  }

  function renderBrowse(root) {
    const content = node('div');
    const status = node('div', { id: 'status' });
    const search = node('input', {
      type: 'search',
      placeholder: 'Search plugins',
      'aria-label': 'Search plugins',
    });
    const category = node('select', { 'aria-label': 'Category' }, [
      node('option', { value: '', text: 'All categories' }),
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
    const refresh = node('button', { text: 'Refresh', onclick: () => load() });

    root.replaceChildren(
      pageHeader(
        'Browse plugins',
        'Install from a static registry. Every package is checksum-verified.',
        [search, category, refresh],
      ),
      status,
      content,
    );

    function fillCategories(categories) {
      const selected = category.value;
      category.replaceChildren(
        node('option', { value: '', text: 'All categories' }),
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
            current.query || current.category ? 'No matching plugins' : 'The registry is empty',
            current.query || current.category
              ? 'Try a different search term or category.'
              : 'No plugins have been published to this registry yet.',
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
          content.replaceChildren(
            ...registryBanners(data),
            node('div', { class: 'detail-head' }, [
              node('button', { text: '← Back', onclick: () => load() }),
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
                    text: 'repository',
                  })
                : null,
              plugin.homepage
                ? node('a', {
                    class: 'chip link',
                    href: plugin.homepage,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: 'homepage',
                  })
                : null,
            ]),
            data.installed
              ? banner(
                  data.installed.enabled ? 'ok' : 'warn',
                  `Installed ${data.installed.version} (${data.installed.scope} scope${
                    data.installed.enabled ? '' : ', disabled'
                  })`,
                )
              : null,
            section(
              'Versions',
              node(
                'div',
                { class: 'versions' },
                versions.map((version) =>
                  node('div', { class: 'version-row' }, [
                    node('div', {}, [
                      node('div', { class: 'version-line' }, [
                        node('strong', { text: version.version }),
                        version.version === plugin.latest ? badge('latest', 'ok') : null,
                        version.version === data.installed?.version
                          ? badge('installed', 'muted')
                          : null,
                      ]),
                      node('div', {
                        class: 'mono muted small',
                        text: `sha256 ${version.asset.sha256.slice(0, 16)}… · ${version.asset.size.toLocaleString(
                          'en-US',
                        )} bytes`,
                      }),
                      node('details', {}, [
                        node('summary', { text: 'Permissions' }),
                        permissionRows(version.permissions),
                      ]),
                    ]),
                    node('button', {
                      class: 'primary',
                      text: 'Install',
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
        ['Plugin', 'Version', 'Scope', 'Enabled', 'Latest', ''].map((label) =>
          node('th', { text: label }),
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
              text: 'Update',
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
          node('td', {}, [item.enabled ? badge('enabled', 'ok') : badge('disabled', 'warn')]),
          node('td', { class: 'mono', text: item.latest || '—' }),
          node('td', { class: 'row-actions' }, [
            update,
            node('button', {
              class: 'danger small',
              text: 'Remove',
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
      children.push(banner('warn', `Registry unavailable: ${data.registry_error}`));
    }
    if (data.registry && data.registry.trusted === false) {
      children.push(banner('danger', `Custom registry: ${data.registry.url}`));
    }
    return children;
  }

  function renderInstalled(root) {
    const content = node('div');
    const status = node('div', { id: 'status' });

    root.replaceChildren(
      pageHeader('Installed plugins', 'Versions, scopes and updates for plugins on this machine.', [
        node('button', { text: 'Refresh', onclick: () => load() }),
      ]),
      status,
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
              emptyState(
                'No plugins installed',
                'Plugins installed from the registry appear here. Built-in plugins are not listed.',
              ),
            );
            return;
          }
          content.replaceChildren(
            ...registryNote(data),
            installedTable(items, {
              update: (item) =>
                runJob(
                  `Updating ${item.name || item.id}`,
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
    const status = node('div', { id: 'status' });

    root.replaceChildren(
      pageHeader('Plugin updates', 'Checks the configured registry for newer versions.', [
        node('button', {
          text: 'Check now',
          onclick: () => load(true),
        }),
      ]),
      status,
      content,
    );

    function load(force) {
      content.replaceChildren(loading(force ? 'Checking the registry…' : 'Loading…'));
      rpc('installed', { force: force === true })
        .then((data) => {
          const items = (data.items || []).filter((item) => item.update_available);
          if (items.length === 0) {
            content.replaceChildren(
              ...registryNote(data),
              emptyState(
                data.registry_error ? 'Could not check for updates' : 'Everything is up to date',
                data.registry_error
                  ? 'The installed plugins are listed, but the registry could not be read.'
                  : 'No installed plugin has a newer version in the registry.',
              ),
            );
            return;
          }
          content.replaceChildren(
            ...registryNote(data),
            banner('warn', `${items.length} update${items.length === 1 ? '' : 's'} available`),
            installedTable(items, {
              update: (item) =>
                runJob(
                  `Updating ${item.name || item.id}`,
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

  // ------------------------------------------------------------------ mount

  const app = document.getElementById('app');
  app.replaceChildren(node('div', { class: 'shell' }, [tabBar(), node('main', { id: 'view' })]));

  if (PAGE === 'installed') renderInstalled(view());
  else if (PAGE === 'updates') renderUpdates(view());
  else renderBrowse(view());
})();
