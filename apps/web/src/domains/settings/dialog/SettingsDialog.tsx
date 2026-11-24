/**
 * VSCode 式设置弹窗（vscode-settings-design §3，S1）。
 *
 * 搜索框 + 左分类树 + 右设置项列表；用户/工作区/浏览器 tab（S5：工作区层写项目
 * vessel.yaml，经 config.set scope=project）。
 * 打开态由路由驱动（{domain:'settings'} 深链可分享、后退关闭）；本组件只消费
 * 路由传入的 focusKey/query/category 初值。数据复用 useConfigStoreApi /
 * useConnection，不新建通道；写路径走 useSettingsWriter（scope 分流）。
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Route } from '../../../app/router';
import { ModalShell } from '../../../components/Modal';
import { ErrorState, LoadingState, StaleNotice } from '../../../components/States';
import { Button } from '../../../components/ui';
import { useConnection } from '../../../gateway/ConnectionProvider';
import { hasMessage, t, useLocale } from '../../../i18n';
import {
  LOG_SETTING_PREFIX,
  readLogEnvOverrides,
  resolveDisplayValues,
} from '../../../state/display-settings';
import {
  COMMON_CATEGORY_ID,
  mergeSettings,
  pluginSettingsToDefs,
  SETTINGS_CATEGORIES,
  type SettingDef,
} from '../../../state/settings-registry';
import {
  buildSearchHaystack,
  isSettingModified,
  matchesSearch,
  parseSearch,
} from '../../../state/settings-search';
import { resourceData } from '../../../state/useResource';
import { useUiStore } from '../../../stores/uiStore';
import { useConfigStoreApi } from '../../../stores/useConfigStoreApi';
import { usePluginContributions } from '../../plugins/usePluginContributions';
import { type CategoryNode, CategoryTree } from './CategoryTree';
import { ConnectionSection } from './ConnectionSection';
import { DesignLabSection } from './DesignLabSection';
import { SettingRow } from './SettingRow';
import { SettingsSearchBar } from './SettingsSearchBar';
import { readLocalSetting, useSettingsWriter } from './useSettingsWriter';

const LazyConfigView = lazy(() =>
  import('../ConfigView').then((module) => ({ default: module.ConfigView })),
);

const TAB_STORAGE_KEY = 'vessel.settings.tab';
const TREE_STORAGE_KEY = 'vessel.settings.tree.collapsed';
const SEARCH_DEBOUNCE_MS = 150;
const FOCUS_HIGHLIGHT_MS = 2000;

type ScopeTab = 'user' | 'project' | 'local';

/** 插件 config 快照值 → 表单文本（E10；object/array 走 JSON 只读视图）。 */
function pluginValueText(raw: unknown): string | undefined {
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readStoredTab(): ScopeTab {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_KEY);
    return raw === 'local' || raw === 'project' ? raw : 'user';
  } catch {
    return 'user';
  }
}

function readCollapsedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(TREE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export interface SettingsDialogProps {
  focusKey?: string;
  initialQuery?: string;
  initialCategory?: string;
  onClose: () => void;
  onNavigate: (route: Route) => void;
}

export function SettingsDialog({
  focusKey,
  initialQuery,
  initialCategory,
  onClose,
  onNavigate,
}: SettingsDialogProps) {
  useLocale();
  const { connectionState, hasToken, features } = useConnection();
  const { config, reloadConfig } = useConfigStoreApi();
  const data = resourceData(config);
  const pending = useUiStore((state) => state.settingsPending);
  const theme = useUiStore((state) => state.theme);
  const writer = useSettingsWriter();
  // S3：插件设置域自动发现——装上即出现（enabled + 声明 settings），无需手工注册。
  const { settings: pluginDomains, plugins } = usePluginContributions();

  const [tab, setTab] = useState<ScopeTab>(readStoredTab);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery ?? '');
  const [activeCategory, setActiveCategory] = useState(initialCategory ?? COMMON_CATEGORY_ID);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(readCollapsedIds);
  const [highlightId, setHighlightId] = useState<string | undefined>();
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // S4：child 模式 → restartRequired（settings 经 env 注入，spawn 后不可变）。
  const modeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const plugin of plugins) {
      if (plugin.mode !== undefined) map.set(plugin.name, plugin.mode);
    }
    return map;
  }, [plugins]);
  const defs = useMemo(
    () =>
      mergeSettings(
        pluginSettingsToDefs(pluginDomains).map((def) =>
          def.pluginId !== undefined && modeById.get(def.pluginId) === 'child'
            ? { ...def, restartRequired: true }
            : def,
        ),
      ),
    [pluginDomains, modeById],
  );
  const serverValues = useMemo(() => resolveDisplayValues(data, pending), [data, pending]);
  const logOverrides = useMemo(() => readLogEnvOverrides(data), [data]);
  // S3：插件值快照复用 E10 plugins.list[].config（不新增读 RPC）。
  const pluginConfigById = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const plugin of plugins) {
      if (plugin.config) map.set(plugin.name, plugin.config);
    }
    return map;
  }, [plugins]);

  // 值解析：核心 = 服务端快照 + pending overlay；local = storage / uiStore。
  // biome-ignore lint/correctness/useExhaustiveDependencies: localRevision 驱动 local 存储重读（回调体不引用）
  const values = useMemo(() => {
    const map: Record<string, string> = {};
    for (const def of defs) {
      if (def.type === 'view') {
        map[def.id] = '';
      } else if (def.scope === 'local') {
        map[def.id] =
          def.id === 'local.theme' ? theme : def.id === 'local.motion' ? '' : readLocalSetting(def);
      } else if (def.pluginId !== undefined) {
        const raw = pluginConfigById.get(def.pluginId)?.[def.key];
        map[def.id] = pending[def.id] ?? pluginValueText(raw) ?? def.default ?? '';
      } else {
        map[def.id] = pending[def.key] ?? serverValues[def.key] ?? def.fallback ?? '';
      }
    }
    return map;
    // localRevision 驱动 local 存储重读（writer 写入后自增）。
  }, [defs, theme, pending, serverValues, pluginConfigById, writer.localRevision]);

  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const def of defs) {
      const title = def.titleKey ? t(def.titleKey) : (def.title ?? def.id);
      const description =
        def.descriptionKey && hasMessage(def.descriptionKey)
          ? t(def.descriptionKey)
          : (def.description ?? '');
      map.set(def.id, buildSearchHaystack(def, title, description));
    }
    return map;
  }, [defs]);

  const parsed = useMemo(() => parseSearch(debouncedQuery), [debouncedQuery]);
  const searching = debouncedQuery.trim() !== '';
  const isModified = useMemo(
    () => (def: SettingDef) => isSettingModified(def, values[def.id]),
    [values],
  );

  // S5：project tab 显示 scope user/project 的服务端核心键（写工作区覆盖层）；
  // 插件键走 plugins.config.set（无层级）、view 项非配置键，均不进 project tab。
  const scopeDefs = useMemo(
    () =>
      defs.filter((def) =>
        tab === 'project'
          ? (def.scope === 'user' || def.scope === 'project') &&
            def.pluginId === undefined &&
            def.type !== 'view'
          : def.scope === tab,
      ),
    [defs, tab],
  );
  const hits = useMemo(
    () => scopeDefs.filter((def) => matchesSearch(def, parsed, { haystacks, isModified })),
    [scopeDefs, parsed, haystacks, isModified],
  );

  const commonHits = useMemo(() => hits.filter((def) => def.common === true), [hits]);
  const sections = useMemo(
    () =>
      SETTINGS_CATEGORIES.filter((category) => category.id !== 'extensions')
        .map((category) => ({
          category,
          items: hits.filter((def) => def.category === category.id),
        }))
        .filter((section) => section.items.length > 0),
    [hits],
  );
  // S3：扩展组按插件域分节（标题 = pluginT 解析的插件名）。
  const pluginSections = useMemo(
    () =>
      pluginDomains
        .map((domain) => ({
          id: `ext:${domain.pluginId}`,
          label: domain.pluginName,
          items: hits.filter((def) => def.pluginId === domain.pluginId),
        }))
        .filter((section) => section.items.length > 0),
    [pluginDomains, hits],
  );

  const treeNodes = useMemo<CategoryNode[]>(() => {
    const nodes: CategoryNode[] = [];
    if (commonHits.length > 0 || !searching) {
      nodes.push({
        id: COMMON_CATEGORY_ID,
        label: t('settings.category.common'),
        count: searching ? commonHits.length : undefined,
      });
    }
    for (const section of sections) {
      nodes.push({
        id: section.category.id,
        label: t(section.category.titleKey),
        count: searching ? section.items.length : undefined,
      });
    }
    if (pluginSections.length > 0) {
      nodes.push({
        id: 'extensions',
        label: t('settings.category.extensions'),
        children: pluginSections.map((section) => ({
          id: section.id,
          label: section.label,
          count: searching ? section.items.length : undefined,
        })),
      });
    }
    return nodes;
  }, [commonHits, sections, pluginSections, searching]);

  const connected = hasToken && connectionState === 'open';
  const configAvailable = hasToken && features.includes('config');
  const coreDisabled = !connected || !configAvailable || writer.writeUnavailable;
  const coreDisabledReason = writer.writeUnavailable
    ? t('settings.dialog.writeUnavailable')
    : !configAvailable
      ? t('settings.dialog.configUnavailable')
      : !connected
        ? t('settings.dialog.configUnavailable')
        : undefined;

  const envOverrideFor = (def: SettingDef): string | undefined => {
    if (!def.key.startsWith(LOG_SETTING_PREFIX)) return undefined;
    const field = def.key.slice(LOG_SETTING_PREFIX.length);
    return logOverrides.find((override) => override.key === field)?.env;
  };

  const selectTab = (next: ScopeTab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // 隐私模式：本会话内生效。
    }
  };

  const toggleCollapse = (id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(TREE_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // 忽略。
      }
      return next;
    });
  };

  const scrollToCategory = (id: string) => {
    setActiveCategory(id);
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 深链聚焦（R7）：定位 + 高亮衰减；focusKey 决定层级 tab（函数式更新免 tab 依赖）。
  useEffect(() => {
    if (!focusKey) return;
    const def = defs.find((entry) => entry.id === focusKey);
    if (!def) return;
    const scope = def.scope as ScopeTab;
    setTab((current) => {
      if (current === scope) return current;
      try {
        localStorage.setItem(TAB_STORAGE_KEY, scope);
      } catch {
        // 隐私模式：本会话内生效。
      }
      return scope;
    });
    const timer = setTimeout(() => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-setting-id="${CSS.escape(focusKey)}"]`,
      );
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(focusKey);
    }, 100);
    const decay = setTimeout(() => setHighlightId(undefined), FOCUS_HIGHLIGHT_MS + 100);
    return () => {
      clearTimeout(timer);
      clearTimeout(decay);
    };
  }, [focusKey, defs]);

  // Esc 两级：先清搜索再关弹窗（§3.3）。
  const handleClose = () => {
    if (query) {
      setQuery('');
      return;
    }
    onClose();
  };

  const renderView = (def: SettingDef) => {
    if (def.view === 'connection') {
      return <ConnectionSection onOpenGateway={() => onNavigate({ domain: 'gateway' })} />;
    }
    if (def.view === 'advancedConfig') {
      return (
        <Suspense fallback={<LoadingState label={t('settings.dialog.loading')} />}>
          <LazyConfigView />
        </Suspense>
      );
    }
    // designLab：S2 懒加载内嵌区块（展开/全屏）；深链 focusKey 自动展开。
    return <DesignLabSection defaultExpanded={focusKey === 'local.designLab'} />;
  };

  const renderRow = (def: SettingDef) => (
    <div
      key={def.id}
      className={
        highlightId === def.id ? 'rounded-sm ring-2 ring-accent transition-shadow' : undefined
      }
    >
      <SettingRow
        def={def}
        value={values[def.id] ?? ''}
        modified={isModified(def)}
        disabled={def.scope !== 'local' && coreDisabled}
        disabledReason={def.scope !== 'local' ? coreDisabledReason : undefined}
        saving={writer.savingKey === def.id}
        query={parsed.text}
        envOverride={envOverrideFor(def)}
        onSave={(target, raw) =>
          void writer.save(target, raw, tab === 'project' ? 'project' : 'user')
        }
        onReset={(target) => void writer.reset(target, tab === 'project' ? 'project' : 'user')}
        onReloadPlugin={def.restartRequired === true ? () => void writer.reloadPlugin() : undefined}
      >
        {def.type === 'view' ? renderView(def) : undefined}
      </SettingRow>
    </div>
  );

  const listBody = () => {
    if (tab !== 'local' && configAvailable && !data) {
      return config.status === 'error' ? (
        <ErrorState message={config.error} onRetry={reloadConfig} />
      ) : (
        <LoadingState label={t('settings.dialog.loading')} />
      );
    }
    if (hits.length === 0 && commonHits.length === 0) {
      return (
        <div className="flex flex-col items-start gap-2 p-4">
          <p className="text-sm text-muted">{t('settings.dialog.noMatches')}</p>
          <Button variant="link" className="text-sm" onClick={() => setQuery('')}>
            {t('settings.dialog.clearFilters')}
          </Button>
        </div>
      );
    }
    return (
      <>
        {!connected && hasToken && (
          <StaleNotice message={t('settings.dialog.configUnavailable')} onRetry={reloadConfig} />
        )}
        {(activeCategory === COMMON_CATEGORY_ID || searching) && commonHits.length > 0 && (
          <div
            ref={(node) => {
              sectionRefs.current[COMMON_CATEGORY_ID] = node;
            }}
          >
            <h3 className="sticky top-0 bg-raised py-1 text-sm font-medium text-muted">
              {t('settings.category.common')}
            </h3>
            {commonHits.map(renderRow)}
          </div>
        )}
        {sections
          .filter(
            (section) =>
              searching ||
              activeCategory === COMMON_CATEGORY_ID ||
              section.category.id === activeCategory,
          )
          .map((section) => (
            <div
              key={section.category.id}
              ref={(node) => {
                sectionRefs.current[section.category.id] = node;
              }}
            >
              <h3 className="sticky top-0 bg-raised py-1 text-sm font-medium text-muted">
                {t(section.category.titleKey)}
              </h3>
              {section.items.map(renderRow)}
            </div>
          ))}
        {pluginSections
          .filter(
            (section) =>
              searching ||
              activeCategory === COMMON_CATEGORY_ID ||
              activeCategory === 'extensions' ||
              section.id === activeCategory,
          )
          .map((section) => (
            <div
              key={section.id}
              ref={(node) => {
                sectionRefs.current[section.id] = node;
              }}
            >
              <h3 className="sticky top-0 bg-raised py-1 text-sm font-medium text-muted">
                {t('settings.category.extensions')} › {section.label}
              </h3>
              {section.items.map(renderRow)}
            </div>
          ))}
      </>
    );
  };

  const tabs: { id: ScopeTab; label: string }[] = [
    { id: 'user', label: t('settings.dialog.tabUser') },
    { id: 'project', label: t('settings.dialog.tabProject') },
    { id: 'local', label: t('settings.dialog.tabLocal') },
  ];

  return (
    <ModalShell
      size="xl"
      label={t('settings.title')}
      closeLabel={t('common.close')}
      onClose={handleClose}
      className="h-[min(86dvh,var(--modal-max-h))] max-compact:-m-3 max-compact:h-dvh max-compact:max-h-none max-compact:max-w-none max-compact:rounded-none"
      bodyClassName="grow overflow-hidden"
    >
      <div className="flex items-center gap-1" role="tablist" aria-label={t('settings.title')}>
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`rounded-sm px-3 py-1 text-sm transition-colors ${
              tab === entry.id
                ? 'bg-accent-soft text-accent-ink'
                : 'bg-transparent text-muted hover:bg-hover'
            }`}
            onClick={() => selectTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <SettingsSearchBar
        query={query}
        onQueryChange={setQuery}
        pluginIds={pluginDomains.map((domain) => domain.pluginId)}
      />
      <div className="flex min-h-0 grow gap-4 max-compact:flex-col max-compact:gap-2">
        <aside className="w-48 shrink-0 overflow-y-auto border-r border-line pr-2 max-compact:hidden">
          <CategoryTree
            nodes={treeNodes}
            activeId={activeCategory}
            onSelect={scrollToCategory}
            collapsedIds={collapsedIds}
            onToggleCollapse={toggleCollapse}
          />
        </aside>
        <div className="flex min-w-0 grow flex-col gap-2">
          <div className="compact:hidden">
            <CategoryTree
              nodes={treeNodes}
              activeId={activeCategory}
              onSelect={scrollToCategory}
              compact
              collapsedIds={collapsedIds}
              onToggleCollapse={toggleCollapse}
            />
          </div>
          <div ref={listRef} className="min-h-0 grow overflow-y-auto overscroll-contain pr-1">
            {listBody()}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
