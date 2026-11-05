/**
 * 体验型 plugin 宿主管理器（CONTRACT-0.43 §3–§6）。
 *
 * 负责：descriptor 复检、按需激活 / 停用、子进程重启上限、动态 RPC 注册、
 * 事件白名单转发与限流、`plugins.list` 渲染贡献、静态 UI 挂载。
 *
 * 生命周期边界是子进程；**不是安全沙箱**（DECISION-044 §1.5）。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { type ChildExitInfo, ChildPluginProcess, type PLUGIN_TIMEOUTS } from './child.js';
import { jsonDtoViolation } from './dto.js';
import { PluginHostError, pluginError, pluginErrorCodeOf } from './errors.js';
import { EventRateLimiter, matchesEventFilter } from './events.js';
import { PLUGIN_ID_PATTERN, PluginRpcRegistry, pluginRpcName } from './registry.js';
import type {
  PluginDescriptor,
  PluginErrorCode,
  PluginEventDto,
  PluginEventSource,
  PluginHostManagerLike,
  PluginRenderContributions,
  PluginRuntimeStatus,
  PluginStaticMount,
  PluginStatusEntry,
} from './types.js';

/** 重启窗口与上限（contract §3.4） */
export const PLUGIN_RESTART_WINDOW_MS = 10 * 60 * 1000;
export const PLUGIN_MAX_RESTARTS = 3;

export type PluginLogger = (
  level: 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
) => void;

export interface PluginHostManagerOptions {
  descriptors: readonly PluginDescriptor[];
  /** `<dataDir>`；plugin 私有目录为 `<dataDir>/plugins/<id>`。 */
  dataDir: string;
  eventSource?: PluginEventSource;
  eventsPerSecond?: number;
  /** 事件 DTO 的额外变换（在事件源之后、白名单之前）。 */
  redact?: (event: PluginEventDto) => PluginEventDto;
  logger?: PluginLogger;
  onEventDropped?: (pluginId: string, dropped: number) => void;
  onPermissionDenied?: (pluginId: string, api: string) => void;
  onReady?: (pluginId: string) => void;
  onStateChange?: (status: PluginStatusEntry) => void;
  execPath?: string;
  /** 覆盖子进程协议超时（探针 / 测试用）。 */
  timeouts?: Partial<typeof PLUGIN_TIMEOUTS>;
  restartWindowMs?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  now?: () => number;
}

interface Entry {
  descriptor: PluginDescriptor;
  enabled: boolean;
  status: PluginRuntimeStatus;
  error?: PluginErrorCode;
  message?: string;
  child?: ChildPluginProcess;
  unsubscribe?: () => void;
  limiter: EventRateLimiter;
  dropped: number;
  denials: number;
  restarts: number[];
  restartTimer?: ReturnType<typeof setTimeout>;
  starting?: Promise<void>;
  tenantId: string;
  settings: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** 相对 UI 入口：拒绝绝对路径、`..`、反斜杠。 */
function isSafeRelativeEntry(entry: unknown): entry is string {
  if (typeof entry !== 'string' || entry.length === 0) return false;
  if (entry.startsWith('/') || entry.startsWith('\\')) return false;
  if (entry.includes('\\') || entry.includes('\0')) return false;
  return !entry.split('/').some((segment) => segment === '..' || segment === '.');
}

function safeEntry(entry: string): string {
  return entry.replace(/^\.\//, '');
}

function eventSubsetOfPermissions(
  contributed: readonly string[],
  permissions: readonly string[],
): boolean {
  return contributed.every((pattern) =>
    permissions.some(
      (allowed) =>
        allowed === '*' ||
        allowed === pattern ||
        (allowed.endsWith('.*') && pattern.startsWith(allowed.slice(0, -1))),
    ),
  );
}

/** descriptor 复检；loader 已校验过一遍，这里 fail-closed 防注入。 */
function validateDescriptor(input: PluginDescriptor): PluginDescriptor {
  if (typeof input.id !== 'string' || !PLUGIN_ID_PATTERN.test(input.id)) {
    throw pluginError('plugin_manifest_invalid', `Invalid plugin id: ${String(input.id)}`);
  }
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw pluginError('plugin_manifest_invalid', 'Plugin name is required.', { id: input.id });
  }
  if (typeof input.version !== 'string' || input.version.length === 0) {
    throw pluginError('plugin_manifest_invalid', 'Plugin version is required.', { id: input.id });
  }
  if (typeof input.pluginDir !== 'string' || input.pluginDir.length === 0) {
    throw pluginError('plugin_manifest_invalid', 'pluginDir is required.', { id: input.id });
  }
  const pluginDir = resolve(input.pluginDir);
  const entry = resolve(pluginDir, input.entry);
  if (!isWithin(pluginDir, entry) || entry === pluginDir) {
    throw pluginError('plugin_manifest_invalid', 'entry must stay inside pluginDir.', {
      id: input.id,
    });
  }
  const uiDir = input.uiDir !== undefined ? resolve(pluginDir, input.uiDir) : undefined;
  if (uiDir !== undefined && !isWithin(pluginDir, uiDir)) {
    throw pluginError('plugin_manifest_invalid', 'ui.dir must stay inside pluginDir.', {
      id: input.id,
    });
  }

  const contributes = input.contributes ?? {};
  const permissions = input.permissions ?? {};
  const events = contributes.events ?? [];
  if (events.length > 0 && !eventSubsetOfPermissions(events, permissions.events ?? [])) {
    throw pluginError(
      'plugin_manifest_invalid',
      'contributes.events must be a subset of permissions.events.',
      { id: input.id },
    );
  }
  const rpcNames = new Set<string>();
  for (const method of contributes.rpc ?? []) {
    pluginRpcName(input.id, method.name);
    if (rpcNames.has(method.name)) {
      throw pluginError('plugin_manifest_invalid', `Duplicate plugin rpc: ${method.name}`, {
        id: input.id,
      });
    }
    rpcNames.add(method.name);
  }
  for (const page of contributes.pages ?? []) {
    if (typeof page.id !== 'string' || page.id.length === 0 || typeof page.title !== 'string') {
      throw pluginError('plugin_manifest_invalid', 'pages[] requires id and title.', {
        id: input.id,
      });
    }
    if (!isSafeRelativeEntry(page.entry)) {
      throw pluginError('plugin_manifest_invalid', 'pages[].entry must be relative.', {
        id: input.id,
      });
    }
    if (
      page.nav !== undefined &&
      page.nav !== 'observe' &&
      page.nav !== 'settings' &&
      page.nav !== 'top'
    ) {
      throw pluginError('plugin_manifest_invalid', 'pages[].nav is invalid.', {
        id: input.id,
        nav: page.nav,
      });
    }
    if (
      page.order !== undefined &&
      (typeof page.order !== 'number' || !Number.isFinite(page.order))
    ) {
      throw pluginError('plugin_manifest_invalid', 'pages[].order must be a number.', {
        id: input.id,
      });
    }
  }
  for (const panel of contributes.panels ?? []) {
    if (typeof panel.slot !== 'string' || typeof panel.id !== 'string') {
      throw pluginError('plugin_manifest_invalid', 'panels[] requires slot and id.', {
        id: input.id,
      });
    }
    if (!isSafeRelativeEntry(panel.entry)) {
      throw pluginError('plugin_manifest_invalid', 'panels[].entry must be relative.', {
        id: input.id,
      });
    }
  }

  return {
    ...input,
    pluginDir,
    entry,
    ...(uiDir !== undefined ? { uiDir } : {}),
  };
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    default:
      // 未声明的 type 子集：不做臆测
      return true;
  }
}

/** 只保留 manifest 声明过的 settings；未声明键告警后丢弃。 */
function filterSettings(
  descriptor: PluginDescriptor,
  input: Record<string, unknown>,
  warn: (message: string, meta?: Record<string, unknown>) => void,
): Record<string, unknown> {
  const schema = descriptor.contributes?.settings;
  const output: Record<string, unknown> = {};
  if (schema === undefined) {
    if (Object.keys(input).length > 0) {
      warn('plugin settings ignored: manifest declares no contributes.settings', {
        plugin: descriptor.id,
      });
    }
    return output;
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = schema[key];
    if (!isRecord(spec)) {
      warn('plugin settings key ignored: not declared in manifest', {
        plugin: descriptor.id,
        key,
      });
      continue;
    }
    if (!typeMatches(spec.type, value)) {
      throw pluginError('plugin_config_invalid', `Setting "${key}" has the wrong type.`, {
        plugin: descriptor.id,
        key,
        expected: spec.type,
      });
    }
    output[key] = value;
  }
  return output;
}

function routeFor(pluginId: string, entry: string): string {
  return `/plugins/${pluginId}/${safeEntry(entry)}`;
}

/**
 * 单进程内的 plugin 宿主。多个 tenant 的启用列表由 loader 决定；
 * 这里的事件订阅按激活时传入的 tenantId 建立。
 */
export class PluginHostManager implements PluginHostManagerLike {
  readonly rpc = new PluginRpcRegistry();

  private readonly entries = new Map<string, Entry>();
  private readonly dataDir: string;
  private readonly logger: PluginLogger;
  private readonly now: () => number;
  private readonly eventsPerSecond: number;
  private readonly restartWindowMs: number;
  private readonly maxRestarts: number;
  private readonly restartDelayMs: number;
  private eventSource?: PluginEventSource;
  private readonly options: PluginHostManagerOptions;

  constructor(options: PluginHostManagerOptions) {
    this.options = options;
    this.dataDir = resolve(options.dataDir);
    this.logger =
      options.logger ??
      ((level, message, meta) => {
        const suffix = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
        if (level === 'error') console.error(`[vessel] ${message}${suffix}`);
        else console.warn(`[vessel] ${message}${suffix}`);
      });
    this.now = options.now ?? Date.now;
    this.eventsPerSecond = options.eventsPerSecond ?? 200;
    this.restartWindowMs = options.restartWindowMs ?? PLUGIN_RESTART_WINDOW_MS;
    this.maxRestarts = options.maxRestarts ?? PLUGIN_MAX_RESTARTS;
    this.restartDelayMs = options.restartDelayMs ?? 0;
    this.eventSource = options.eventSource;

    for (const input of options.descriptors) {
      let descriptor: PluginDescriptor;
      try {
        descriptor = validateDescriptor(input);
      } catch (error) {
        const id = typeof input.id === 'string' ? input.id : '<invalid>';
        const status: PluginStatusEntry = {
          id,
          status: 'invalid',
          enabled: false,
          error: pluginErrorCodeOf(error) ?? 'plugin_manifest_invalid',
          message: error instanceof Error ? error.message : String(error),
          events_dropped: 0,
          restarts: 0,
        };
        // 无效 descriptor 不注册，只保留可诊断状态。
        this.entries.set(id, {
          descriptor: { ...input, id, name: id, version: '', entry: '', pluginDir: '' },
          enabled: false,
          status: 'invalid',
          error: status.error,
          message: status.message,
          limiter: new EventRateLimiter(this.eventsPerSecond, this.now),
          dropped: 0,
          denials: 0,
          restarts: [],
          tenantId: 'default',
          settings: {},
        });
        continue;
      }
      if (this.entries.has(descriptor.id)) {
        const existing = this.entries.get(descriptor.id) as Entry;
        existing.enabled = false;
        existing.status = 'invalid';
        existing.error = 'plugin_id_conflict';
        existing.message = `Duplicate plugin id: ${descriptor.id}`;
        this.logger('error', 'plugin id conflict; refusing activation', {
          plugin: descriptor.id,
        });
        continue;
      }
      this.entries.set(descriptor.id, {
        descriptor,
        enabled: descriptor.enabled ?? true,
        status: (descriptor.enabled ?? true) ? 'inactive' : 'disabled',
        limiter: new EventRateLimiter(this.eventsPerSecond, this.now),
        dropped: 0,
        denials: 0,
        restarts: [],
        tenantId: 'default',
        settings: {},
      });
    }
  }

  /** 按需激活（activationEvents 命中后由 loader 调用）。 */
  async activate(
    id: string,
    options: { tenantId?: string; settings?: Record<string, unknown> } = {},
  ): Promise<void> {
    const entry = this.requireEntry(id);
    if (!entry.enabled) {
      throw pluginError('plugin_activation_failed', `Plugin ${id} is disabled.`, { id });
    }
    if (entry.status === 'invalid') {
      throw pluginError(
        entry.error ?? 'plugin_manifest_invalid',
        entry.message ?? 'Invalid plugin.',
        {
          id,
        },
      );
    }
    await this.startEntry(entry, options.tenantId ?? entry.tenantId, options.settings ?? {});
  }

  /** 停用但保持 enabled；下次 activationEvent 可再次激活。 */
  async deactivate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (entry.restartTimer !== undefined) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    entry.status = entry.enabled ? 'inactive' : 'disabled';
    this.unsubscribeEvents(entry);
    this.rpc.unregister(id);
    const child = entry.child;
    entry.child = undefined;
    if (child !== undefined) await child.terminate();
    this.publishState(entry);
  }

  /** 禁用：停止子进程、取消订阅与 RPC，下次启动不加载。 */
  async disable(id: string): Promise<void> {
    const entry = this.requireEntry(id);
    entry.enabled = false;
    await this.deactivate(id);
  }

  /** 启用但保持懒激活。 */
  enable(id: string): void {
    const entry = this.requireEntry(id);
    if (entry.status === 'invalid') return;
    entry.enabled = true;
    if (entry.status === 'disabled') entry.status = 'inactive';
    entry.error = undefined;
    entry.message = undefined;
    this.publishState(entry);
  }

  /** 注入 / 替换事件源；active plugin 重新订阅。 */
  attachEventSource(source: PluginEventSource): void {
    this.eventSource = source;
    for (const entry of this.entries.values()) {
      if (entry.status !== 'active') continue;
      this.unsubscribeEvents(entry);
      this.subscribeEvents(entry);
    }
  }

  /** tenant →（id → 渲染字段）；只含 enabled 的体验型 plugin。 */
  contributionsFor(_tenantId: string): Record<string, PluginRenderContributions> {
    const output: Record<string, PluginRenderContributions> = {};
    for (const entry of this.entries.values()) {
      if (!entry.enabled || entry.status === 'invalid') continue;
      const contributions = renderContributions(entry.descriptor);
      if (contributions !== undefined) output[entry.descriptor.id] = contributions;
    }
    return output;
  }

  /** enabled 且声明 ui.dir 的静态挂载。 */
  staticMounts(): PluginStaticMount[] {
    const mounts: PluginStaticMount[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.enabled || entry.status === 'invalid') continue;
      const uiDir = entry.descriptor.uiDir;
      if (uiDir !== undefined) mounts.push({ id: entry.descriptor.id, uiDir });
    }
    return mounts;
  }

  /** 状态列表（`vessel plugin list`）。 */
  statuses(): PluginStatusEntry[] {
    return [...this.entries.values()]
      .map((entry) => this.statusOf(entry))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  status(id: string): PluginStatusEntry | undefined {
    const entry = this.entries.get(id);
    return entry !== undefined ? this.statusOf(entry) : undefined;
  }

  /** 被 deny 的宿主 API 次数（探针 / 诊断）。 */
  denialsFor(id: string): number {
    return this.entries.get(id)?.denials ?? 0;
  }

  /** 幂等关闭全部子进程与订阅。 */
  async stopAll(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const entry of this.entries.values()) {
      if (entry.restartTimer !== undefined) {
        clearTimeout(entry.restartTimer);
        entry.restartTimer = undefined;
      }
      this.unsubscribeEvents(entry);
      this.rpc.unregister(entry.descriptor.id);
      const child = entry.child;
      entry.child = undefined;
      if (child !== undefined) tasks.push(child.terminate());
      entry.status = entry.enabled ? 'inactive' : 'disabled';
    }
    await Promise.all(tasks);
    this.rpc.clear();
  }

  private async startEntry(
    entry: Entry,
    tenantId: string,
    settingsInput: Record<string, unknown>,
  ): Promise<void> {
    if (entry.status === 'active') return;
    if (entry.starting !== undefined) return entry.starting;
    const task = this.doStart(entry, tenantId, settingsInput);
    entry.starting = task;
    try {
      await task;
    } finally {
      entry.starting = undefined;
    }
  }

  private async doStart(
    entry: Entry,
    tenantId: string,
    settingsInput: Record<string, unknown>,
  ): Promise<void> {
    const descriptor = entry.descriptor;
    const settings = filterSettings(descriptor, settingsInput, (message, meta) => {
      this.logger('warn', message, meta);
    });
    entry.status = 'starting';
    entry.error = undefined;
    entry.message = undefined;
    this.publishState(entry);

    const dataDir = join(this.dataDir, 'plugins', descriptor.id);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const child = new ChildPluginProcess({
      descriptor,
      settings,
      dataDir,
      // §3.2.1：全局 data dir 只读；是否下发给 activate 由 child 按权限判断。
      globalDataDir: this.dataDir,
      ...(this.options.execPath !== undefined ? { execPath: this.options.execPath } : {}),
      ...(this.options.timeouts !== undefined ? { timeouts: this.options.timeouts } : {}),
      hooks: {
        onExit: (info) => this.handleExit(entry, info),
        onLog: () => {},
        onReady: () => this.options.onReady?.(descriptor.id),
        onPermissionDenied: (api) => {
          entry.denials += 1;
          this.logger('warn', 'plugin permission denied', { plugin: descriptor.id, api });
          this.options.onPermissionDenied?.(descriptor.id, api);
        },
      },
    });
    entry.child = child;
    entry.tenantId = tenantId;
    entry.settings = settings;

    try {
      await child.start();
      this.rpc.register(descriptor.id, descriptor.contributes?.rpc ?? [], (name, params) =>
        this.callRpc(entry, name, params),
      );
      entry.status = 'active';
      entry.error = undefined;
      entry.message = undefined;
      this.subscribeEvents(entry);
      this.publishState(entry);
    } catch (error) {
      this.rpc.unregister(descriptor.id);
      entry.child = undefined;
      entry.error = pluginErrorCodeOf(error) ?? 'plugin_activation_failed';
      entry.message = error instanceof Error ? error.message : String(error);
      entry.status =
        entry.error === 'plugin_manifest_invalid' || entry.error === 'plugin_config_invalid'
          ? 'invalid'
          : 'unhealthy';
      this.publishState(entry);
      throw error;
    }
  }

  private async callRpc(
    entry: Entry,
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const child = entry.child;
    if (child === undefined || entry.status !== 'active') {
      throw pluginError('plugin_activation_failed', 'Plugin is not active.', {
        plugin: entry.descriptor.id,
      });
    }
    try {
      return await child.callRpc(name, params);
    } catch (error) {
      const code = pluginErrorCodeOf(error);
      // 重启上限已把 plugin 禁用时，迟到的 RPC 拒绝不得把状态改回 unhealthy。
      // 读 helper 而不是直接比较 `entry.status`：TS 在前面已把它收窄成 'active'。
      if (
        (code === 'plugin_timeout' || code === 'plugin_crashed') &&
        entry.enabled &&
        this.statusNow(entry) !== 'disabled'
      ) {
        entry.status = 'unhealthy';
        entry.error = code;
        entry.message = error instanceof Error ? error.message : String(error);
        this.publishState(entry);
      }
      throw error;
    }
  }

  /** 读取运行期状态（防止 TS 把已收窄的字段当成不变）。 */
  private statusNow(entry: Entry): PluginRuntimeStatus {
    return entry.status;
  }

  private handleExit(entry: Entry, info: ChildExitInfo): void {
    entry.child = undefined;
    this.unsubscribeEvents(entry);
    this.rpc.unregister(entry.descriptor.id);

    // 宿主主动触发（deactivate / disable / 超时）：不再自动重启。
    if (info.expected) {
      if (info.errorCode === 'plugin_timeout' || info.errorCode === 'plugin_payload_too_large') {
        entry.status = 'unhealthy';
        entry.error = info.errorCode;
        entry.message = info.message;
      }
      this.publishState(entry);
      return;
    }

    entry.status = 'unhealthy';
    entry.error = info.errorCode ?? 'plugin_crashed';
    entry.message = info.message ?? 'Plugin process exited unexpectedly.';
    this.publishState(entry);
    this.scheduleRestart(entry);
  }

  private scheduleRestart(entry: Entry): void {
    const now = this.now();
    entry.restarts = entry.restarts.filter((timestamp) => now - timestamp < this.restartWindowMs);
    if (entry.restarts.length >= this.maxRestarts) {
      entry.enabled = false;
      entry.status = 'disabled';
      entry.message = `Exceeded ${this.maxRestarts} restarts within ${Math.round(
        this.restartWindowMs / 60000,
      )} minutes.`;
      this.logger('error', 'plugin disabled after repeated crashes', {
        plugin: entry.descriptor.id,
        restarts: entry.restarts.length,
      });
      this.publishState(entry);
      return;
    }
    entry.restarts.push(now);
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      void this.startEntry(entry, entry.tenantId, entry.settings).catch(() => {
        // 启动失败已写入状态；不再无限重试
      });
    }, this.restartDelayMs);
  }

  private subscribeEvents(entry: Entry): void {
    const source = this.eventSource;
    if (source === undefined || entry.unsubscribe !== undefined) return;
    const patterns = entry.descriptor.contributes?.events ?? [];
    if (patterns.length === 0) return;
    entry.unsubscribe = source.subscribe(entry.tenantId, (event) => {
      const transformed = this.options.redact !== undefined ? this.options.redact(event) : event;
      if (!matchesEventFilter(transformed.type, patterns)) return;
      const dtoViolation = jsonDtoViolation(transformed, 'event');
      if (dtoViolation !== null) {
        this.recordDrop(entry);
        return;
      }
      if (!entry.limiter.allow()) {
        this.recordDrop(entry);
        return;
      }
      entry.child?.notifyEvent(transformed);
    });
  }

  private unsubscribeEvents(entry: Entry): void {
    if (entry.unsubscribe === undefined) return;
    try {
      entry.unsubscribe();
    } catch {
      // 幂等退订
    }
    entry.unsubscribe = undefined;
  }

  private recordDrop(entry: Entry): void {
    entry.dropped += 1;
    this.options.onEventDropped?.(entry.descriptor.id, entry.dropped);
  }

  private statusOf(entry: Entry): PluginStatusEntry {
    const now = this.now();
    const restarts = entry.restarts.filter((timestamp) => now - timestamp < this.restartWindowMs);
    return {
      id: entry.descriptor.id,
      status: entry.status,
      enabled: entry.enabled,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.message !== undefined ? { message: entry.message } : {}),
      events_dropped: entry.dropped,
      restarts: restarts.length,
    };
  }

  private publishState(entry: Entry): void {
    this.options.onStateChange?.(this.statusOf(entry));
  }

  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw pluginError('plugin_manifest_invalid', `Unknown plugin: ${id}`, { id });
    }
    return entry;
  }
}

/** 只返回可渲染字段（contract §2.7）；能力插件 / 无 UI 贡献 → undefined。 */
export function renderContributions(
  descriptor: PluginDescriptor,
): PluginRenderContributions | undefined {
  const contributes = descriptor.contributes;
  if (contributes === undefined) return undefined;
  const pages = (contributes.pages ?? []).map((page) => ({
    id: page.id,
    title: page.title,
    nav: page.nav ?? 'observe',
    order: page.order ?? 100,
    entry: safeEntry(page.entry),
    route: routeFor(descriptor.id, page.entry),
  }));
  const panels = (contributes.panels ?? []).map((panel) => ({
    slot: panel.slot,
    id: panel.id,
    ...(panel.title !== undefined ? { title: panel.title } : {}),
    order: panel.order ?? 100,
    entry: safeEntry(panel.entry),
    route: routeFor(descriptor.id, panel.entry),
  }));
  const commands = (contributes.commands ?? []).map((command) => ({
    name: command.name,
    title: command.title,
  }));
  // E1 amendment：bare 方法名；web iframe bridge 用它做 RPC 白名单。
  const rpc = (contributes.rpc ?? []).map((method) => method.name);
  if (pages.length === 0 && panels.length === 0 && commands.length === 0 && rpc.length === 0) {
    return undefined;
  }
  return { pages, panels, commands, rpc };
}

export { PluginHostError };
