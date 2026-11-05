/**
 * Host/plugin runtime helpers (iframe contract E7).
 *
 * The host injects `?lang` / `?theme` into plugin iframe URLs and sends
 * `vessel.theme` / `vessel.lang` messages when they change. These helpers
 * read/apply that context and provide the `vessel.plugin.rpc` promise bridge.
 * No copy, colors, or framework assumptions.
 */

export type HostTheme = 'light' | 'dark';

export interface HostContext {
  theme: HostTheme;
  lang: string;
}

/** Structural subset of the browser globals; keeps the package DOM-lib-light. */
interface HostWindow {
  location?: { search?: string };
  navigator?: { language?: string };
  matchMedia?: (query: string) => {
    matches: boolean;
    addEventListener?: (type: 'change', listener: () => void) => void;
    removeEventListener?: (type: 'change', listener: () => void) => void;
  };
  addEventListener?: (type: 'message', listener: (event: HostMessageEvent) => void) => void;
  removeEventListener?: (type: 'message', listener: (event: HostMessageEvent) => void) => void;
  parent?: HostWindow;
  postMessage?: (message: unknown, targetOrigin: string) => void;
}

interface HostMessageEvent {
  data: unknown;
  source?: unknown;
}

interface HostRoot {
  dataset: { theme?: string };
  lang: string;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';
const THEME_MESSAGE = 'vessel.theme';
const LANG_MESSAGE = 'vessel.lang';
const RPC_MESSAGE = 'vessel.plugin.rpc';
const RPC_RESULT = 'vessel.plugin.rpc.result';
const REFRESH_MESSAGE = 'vessel.plugin.refresh';

function hostWindow(): HostWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as HostWindow);
}

function hostRoot(): HostRoot | undefined {
  return typeof document === 'undefined'
    ? undefined
    : (document.documentElement as unknown as HostRoot);
}

/** `system` fallback: dark only when the media query says so. */
export function systemTheme(): HostTheme {
  return hostWindow()?.matchMedia?.(DARK_QUERY)?.matches ? 'dark' : 'light';
}

function themeOf(value: string | null | undefined): HostTheme {
  return value === 'light' || value === 'dark' ? value : systemTheme();
}

function langOf(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  const navigatorLang = hostWindow()?.navigator?.language?.trim();
  return navigatorLang && navigatorLang !== '' ? navigatorLang : 'en';
}

function searchOf(search?: string): string {
  if (search !== undefined) return search;
  return hostWindow()?.location?.search ?? '';
}

/**
 * Read `?theme` / `?lang` from the iframe URL with system/navigator fallbacks.
 * Pass an explicit search string for tests/probes.
 */
export function readHostContext(search?: string): HostContext {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(searchOf(search));
  } catch {
    params = new URLSearchParams();
  }
  return {
    theme: themeOf(params.get('theme')),
    lang: langOf(params.get('lang')),
  };
}

/** Apply context to `<html>` (`data-theme` + `lang`). */
export function applyHostContext(context: HostContext, root?: HostRoot): void {
  const target = root ?? hostRoot();
  if (!target) return;
  target.dataset.theme = context.theme;
  target.lang = context.lang;
}

/**
 * Listen for host context messages, apply each update, and notify `onChange`.
 * Returns a cleanup function.
 */
export function watchHostContext(onChange?: (context: HostContext) => void): () => void {
  const scope = hostWindow();
  if (!scope?.addEventListener) return () => {};
  let current = readHostContext();
  const onMessage = (event: HostMessageEvent) => {
    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.type === THEME_MESSAGE && (message.theme === 'light' || message.theme === 'dark')) {
      current = { ...current, theme: message.theme };
    } else if (
      message.type === LANG_MESSAGE &&
      typeof message.lang === 'string' &&
      message.lang.trim() !== ''
    ) {
      current = { ...current, lang: message.lang.trim() };
    } else {
      return;
    }
    applyHostContext(current);
    onChange?.(current);
  };
  scope.addEventListener('message', onMessage);
  return () => scope.removeEventListener?.('message', onMessage);
}

export class PluginRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PluginRpcError';
    this.code = code;
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface PluginRpcClientOptions {
  /** Defaults to `window.parent`. */
  target?: unknown;
}

/**
 * iframe → host `vessel.plugin.rpc` bridge with promise correlation.
 * Methods must be within the plugin's declared whitelist on the host side.
 */
export class PluginRpcClient {
  private readonly scope: HostWindow | undefined;
  private readonly target: HostWindow | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private readonly refreshListeners = new Set<() => void>();
  private nextId = 0;
  private disposed = false;

  constructor(options: PluginRpcClientOptions = {}) {
    this.scope = hostWindow();
    this.target = (options.target ?? this.scope?.parent) as HostWindow | undefined;
    this.scope?.addEventListener?.('message', this.onMessage);
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('PluginRpcClient disposed'));
    if (typeof method !== 'string' || method.trim() === '') {
      return Promise.reject(new Error('method is required'));
    }
    const id = String(++this.nextId);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.target?.postMessage?.(
        {
          type: RPC_MESSAGE,
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        },
        '*',
      );
    });
  }

  /** Host → plugin data refresh (`vessel.plugin.refresh`). */
  onRefresh(listener: () => void): () => void {
    this.refreshListeners.add(listener);
    return () => this.refreshListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scope?.removeEventListener?.('message', this.onMessage);
    for (const call of this.pending.values()) {
      call.reject(new Error('PluginRpcClient disposed'));
    }
    this.pending.clear();
    this.refreshListeners.clear();
  }

  private readonly onMessage = (event: HostMessageEvent) => {
    if (this.target !== undefined && event.source !== undefined && event.source !== this.target) {
      return;
    }
    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    const message = data as Record<string, unknown>;
    if (message.type === REFRESH_MESSAGE) {
      for (const listener of this.refreshListeners) listener();
      return;
    }
    if (message.type !== RPC_RESULT || typeof message.id !== 'string') return;
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      const raw = message.error;
      const record =
        raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      call.reject(
        new PluginRpcError(
          typeof record.code === 'string' ? record.code : 'internal',
          typeof record.message === 'string' ? record.message : 'plugin rpc failed',
        ),
      );
      return;
    }
    call.resolve(message.result);
  };
}
