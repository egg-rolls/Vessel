/**
 * Usage plugin UI.
 *
 * Static vanilla JS: no build, no network, no gateway token. Every read goes
 * through the host bridge:
 *   iframe -> host: {type:'vessel.plugin.rpc', id, method, params}
 *   host -> iframe: {type:'vessel.plugin.rpc.result', id, result|error}
 *
 * Missing counters are rendered as an em dash, never as 0. An unavailable
 * ratio is also an em dash with a reason in the hint, never "0%".
 */
(() => {
  const PAGES = [
    { id: 'usage', label: 'Usage', file: 'usage.html' },
    { id: 'logs', label: 'Logs', file: 'logs.html' },
    { id: 'leaderboard', label: 'Leaderboard', file: 'leaderboard.html' },
  ];
  const PAGE = document.body.dataset.page || 'usage';
  const RPC_TIMEOUT_MS = 12000;
  const RANGES = [
    { value: 7, label: '7 days' },
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
    { value: 0, label: 'All time' },
  ];
  const LOG_LIMIT = 50;
  const MISSING = '—';

  const pending = new Map();
  let nextRpcId = 1;
  let refreshTimer;
  let reload = () => {};

  // ---------------------------------------------------------------- bridge

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextRpcId;
      nextRpcId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The host did not answer this RPC in time.'));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage(
        { type: 'vessel.plugin.rpc', id, method, params: params || {} },
        '*',
      );
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    // Sandboxed iframes report the opaque origin "null"; a non-sandboxed
    // mount reports the gateway origin. Anything else is not our host.
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
      { class: 'tabs', 'aria-label': 'Usage plugin' },
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

  function rangeSelect(initial, onChange) {
    const select = node('select', { 'aria-label': 'Time range' });
    for (const range of RANGES) {
      select.append(node('option', { value: String(range.value), text: range.label }));
    }
    select.value = String(initial);
    select.addEventListener('change', () => onChange(Number(select.value)));
    return select;
  }

  function loading() {
    return node('div', { class: 'loading', text: 'Loading…' });
  }

  function emptyState(title, detail) {
    return node('div', { class: 'empty' }, [
      node('div', { class: 'empty-title', text: title }),
      node('p', { text: detail }),
    ]);
  }

  function errorState(error, retry) {
    return node('div', { class: 'error' }, [
      node('p', { text: error?.message ? error.message : String(error) }),
      node('button', { class: 'primary', text: 'Retry', onclick: retry }),
    ]);
  }

  function tableWrap(table) {
    return node('div', { class: 'table-wrap' }, [table]);
  }

  function table(columns, rows) {
    const head = node('thead', {}, [
      node(
        'tr',
        {},
        columns.map((column) => node('th', { text: column })),
      ),
    ]);
    const body = node(
      'tbody',
      {},
      rows.map((cells) =>
        node(
          'tr',
          {},
          cells.map((cell) => node('td', {}, [cell])),
        ),
      ),
    );
    return node('table', {}, [head, body]);
  }

  function section(title, content) {
    return node('section', { class: 'section' }, [
      node('h2', { class: 'section-title', text: title }),
      content,
    ]);
  }

  function badge(status) {
    return node('span', {
      class: `badge ${status === 'failed' ? 'failed' : 'ok'}`,
      text: status,
    });
  }

  function statCard(label, value, hint) {
    return node('div', { class: 'card' }, [
      node('div', { class: 'label', text: label }),
      node('div', { class: 'value', text: value }),
      node('div', { class: 'hint', text: hint || '' }),
    ]);
  }

  // -------------------------------------------------------------- formatting

  function fmtInt(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString('en-US')
      : MISSING;
  }

  function fmtPct(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return MISSING;
    let percent = value * 100;
    if (percent >= 99.95) percent = 100;
    return `${(Math.round(percent * 10) / 10).toFixed(1).replace(/\.0$/, '')}%`;
  }

  function fmtCost(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return MISSING;
    if (value === 0) return '$0';
    const digits = value < 0.01 ? 6 : 4;
    return `$${value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;
  }

  function fmtDuration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return MISSING;
    if (value < 1000) return `${Math.round(value)} ms`;
    return `${(value / 1000).toFixed(2)} s`;
  }

  function fmtTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return MISSING;
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function ratioHint(reason, fallback) {
    switch (reason) {
      case 'no-requests':
        return 'No requests in range';
      case 'no-cache-fields':
        return 'Provider did not report cache';
      case 'zero-denominator':
        return 'No cache activity in range';
      case 'prompt-not-inclusive':
        return 'Cache counters exceed prompt tokens';
      case 'write-not-reported':
        return 'Cache writes were not reported';
      default:
        return fallback;
    }
  }

  function daysParam(days) {
    return days > 0 ? { days } : {};
  }

  // ------------------------------------------------------------------ usage

  function renderUsage() {
    const root = view();
    const content = node('div');
    let days = 30;

    const select = rangeSelect(days, (value) => {
      days = value;
      load();
    });

    root.replaceChildren(
      pageHeader('Usage', 'Requests, tokens, cache and cost from persisted run history.', [select]),
      content,
    );

    function load() {
      content.replaceChildren(loading());
      rpc('summary', daysParam(days))
        .then((data) => render(data))
        .catch((error) => content.replaceChildren(errorState(error, load)));
    }

    function render(data) {
      if (data?.has_data !== true) {
        content.replaceChildren(
          emptyState(
            'No usage data yet',
            'Run a request through Vessel. Usage appears here once the event log has records in the selected range.',
          ),
        );
        return;
      }

      const totals = data.totals || {};
      const cards = [
        statCard(
          'Requests',
          fmtInt(totals.requests),
          totals.failed_runs > 0 ? `${fmtInt(totals.failed_runs)} failed run(s)` : '',
        ),
        statCard('Prompt tokens', fmtInt(totals.prompt_tokens), 'Includes cache counters'),
        statCard('Completion tokens', fmtInt(totals.completion_tokens), ''),
        statCard(
          'Cache read',
          fmtInt(totals.cache_read_tokens),
          totals.cache_read_tokens === undefined
            ? 'Not reported by provider'
            : 'Read from the prompt cache',
        ),
        statCard(
          'Input share',
          fmtPct(data.input_share),
          ratioHint(data.input_share_unavailable, 'Cache read / prompt tokens'),
        ),
        statCard(
          'Prefix health',
          fmtPct(data.prefix_health),
          ratioHint(data.prefix_health_unavailable, 'Cache read / (read + write)'),
        ),
        statCard(
          'Cost',
          fmtCost(data.cost),
          data.cost === undefined
            ? 'A used model has no configured price'
            : 'USD, from configured prices',
        ),
      ];

      const rows = (data.by_day || []).map((row) => [
        row.date,
        fmtInt(row.requests),
        fmtInt(row.prompt_tokens),
        fmtInt(row.completion_tokens),
        fmtInt(row.cache_read_tokens),
        fmtInt(row.failed_runs),
        fmtCost(row.cost),
      ]);

      content.replaceChildren(
        node('div', { class: 'cards' }, cards),
        section(
          'By day',
          tableWrap(
            table(
              ['Day', 'Requests', 'Prompt', 'Completion', 'Cache read', 'Failed', 'Cost'],
              rows,
            ),
          ),
        ),
      );
    }

    reload = load;
    load();
  }

  // ------------------------------------------------------------------- logs

  function renderLogs() {
    const root = view();
    const content = node('div');
    const state = {
      items: [],
      cursor: null,
      session: '',
      model: '',
      status: '',
      loading: false,
      error: null,
    };

    const sessionInput = node('input', {
      type: 'search',
      placeholder: 'Session id',
      'aria-label': 'Session id',
    });
    const modelInput = node('input', {
      type: 'search',
      placeholder: 'Model',
      'aria-label': 'Model',
    });
    const statusSelect = node('select', { 'aria-label': 'Status' }, [
      node('option', { value: '', text: 'All statuses' }),
      node('option', { value: 'ok', text: 'OK' }),
      node('option', { value: 'failed', text: 'Failed' }),
    ]);
    const apply = node('button', { class: 'primary', text: 'Apply', onclick: () => load(true) });
    const refresh = node('button', { text: 'Refresh', onclick: () => load(true) });

    for (const input of [sessionInput, modelInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') load(true);
      });
    }

    root.replaceChildren(
      pageHeader('Logs', 'One row per LLM response, plus failed runs.', [
        sessionInput,
        modelInput,
        statusSelect,
        apply,
        refresh,
      ]),
      content,
    );

    function load(reset) {
      if (reset) {
        state.items = [];
        state.cursor = null;
        state.session = sessionInput.value.trim();
        state.model = modelInput.value.trim();
        state.status = statusSelect.value;
      } else if (state.cursor === null) {
        return;
      }

      state.loading = true;
      state.error = null;
      render();

      const params = { limit: LOG_LIMIT };
      if (state.session) params.session_id = state.session;
      if (state.model) params.model = state.model;
      if (state.status) params.status = state.status;
      if (!reset && state.cursor) {
        params.before_ts = state.cursor.before_ts;
        params.before_id = state.cursor.before_id;
      }

      rpc('logs', params)
        .then((data) => {
          if (reset) state.items = [];
          state.items.push(...(data?.items || []));
          state.cursor = data?.next_cursor || null;
          state.loading = false;
          render();
        })
        .catch((error) => {
          state.loading = false;
          state.error = error;
          render();
        });
    }

    function render() {
      if (state.loading && state.items.length === 0) {
        content.replaceChildren(loading());
        return;
      }
      if (state.error && state.items.length === 0) {
        content.replaceChildren(errorState(state.error, () => load(true)));
        return;
      }
      if (state.items.length === 0) {
        content.replaceChildren(
          emptyState(
            state.session || state.model || state.status
              ? 'No matching requests'
              : 'No request logs yet',
            'Logs are read from the persisted tenant event files.',
          ),
        );
        return;
      }

      const rows = state.items.map((item) => [
        node('span', { text: fmtTime(item.ts) }),
        badge(item.status),
        node('span', { text: item.model, title: item.model }),
        node('span', { class: 'mono', text: item.session_id || MISSING }),
        fmtInt(item.prompt_tokens),
        fmtInt(item.completion_tokens),
        fmtInt(item.cache_read_input_tokens),
        fmtDuration(item.duration_ms),
        fmtCost(item.cost),
      ]);

      const children = [
        tableWrap(
          table(
            [
              'Time',
              'Status',
              'Model',
              'Session',
              'Prompt',
              'Completion',
              'Cache read',
              'Duration',
              'Cost',
            ],
            rows,
          ),
        ),
      ];

      if (state.error) {
        children.push(errorState(state.error, () => load(false)));
      } else if (state.cursor) {
        children.push(
          node('div', { class: 'footer-actions' }, [
            node('button', {
              class: 'primary',
              text: state.loading ? 'Loading…' : 'Load more',
              onclick: () => load(false),
            }),
          ]),
        );
      }

      content.replaceChildren(...children);
    }

    reload = () => load(true);
    load(true);
  }

  // ------------------------------------------------------------ leaderboard

  function renderLeaderboard() {
    const root = view();
    const content = node('div');
    let days = 30;
    let items = [];
    let sortKey = 'tokens';
    let sortDir = 'desc';

    const select = rangeSelect(days, (value) => {
      days = value;
      load();
    });

    root.replaceChildren(
      pageHeader('Leaderboard', 'Models ranked by token volume in the selected range.', [select]),
      content,
    );

    function load() {
      content.replaceChildren(loading());
      rpc('leaderboard', daysParam(days))
        .then((data) => {
          items = data?.items || [];
          render();
        })
        .catch((error) => content.replaceChildren(errorState(error, load)));
    }

    function sortValue(item, key) {
      if (key === 'tokens') {
        return (item.prompt_tokens || 0) + (item.completion_tokens || 0);
      }
      return item[key];
    }

    function sorted() {
      const copy = items.slice();
      copy.sort((a, b) => {
        const left = sortValue(a, sortKey);
        const right = sortValue(b, sortKey);
        if (left === undefined && right === undefined) return 0;
        if (left === undefined) return 1;
        if (right === undefined) return -1;
        if (typeof left === 'string' || typeof right === 'string') {
          const result = String(left).localeCompare(String(right));
          return sortDir === 'asc' ? result : -result;
        }
        const result = left - right;
        return sortDir === 'asc' ? result : -result;
      });
      return copy;
    }

    function sortable(label, key, defaultDir) {
      const active = sortKey === key;
      const indicator = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
      return node('button', {
        class: 'sort',
        text: `${label}${indicator}`,
        onclick: () => {
          if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
          else {
            sortKey = key;
            sortDir = defaultDir;
          }
          render();
        },
      });
    }

    function render() {
      if (items.length === 0) {
        content.replaceChildren(
          emptyState(
            'No model usage yet',
            'Run a request through Vessel. Models appear here once usage records exist.',
          ),
        );
        return;
      }

      const rows = sorted().map((item) => [
        node('span', { text: item.model, title: item.model }),
        fmtInt(item.requests),
        fmtInt((item.prompt_tokens || 0) + (item.completion_tokens || 0)),
        fmtInt(item.cache_read_tokens),
        fmtCost(item.cost),
      ]);

      const head = node('thead', {}, [
        node('tr', {}, [
          node('th', {}, [sortable('Model', 'model', 'asc')]),
          node('th', {}, [sortable('Requests', 'requests', 'desc')]),
          node('th', {}, [sortable('Tokens', 'tokens', 'desc')]),
          node('th', {}, [sortable('Cache read', 'cache_read_tokens', 'desc')]),
          node('th', {}, [sortable('Cost', 'cost', 'desc')]),
        ]),
      ]);
      const body = node(
        'tbody',
        {},
        rows.map((cells) =>
          node(
            'tr',
            {},
            cells.map((cell) => node('td', {}, [cell])),
          ),
        ),
      );

      content.replaceChildren(tableWrap(node('table', {}, [head, body])));
    }

    reload = load;
    load();
  }

  // ------------------------------------------------------------------ mount

  const app = document.getElementById('app');
  app.replaceChildren(node('div', { class: 'shell' }, [tabBar(), node('main', { id: 'view' })]));

  if (PAGE === 'logs') renderLogs();
  else if (PAGE === 'leaderboard') renderLeaderboard();
  else renderUsage();
})();
