/**
 * VSCode 式设置弹窗（vscode-settings-design §3，S1）。
 *
 * 搜索框 + 左分类树 + 右设置项列表；用户/工作区/浏览器 tab（工作区 S5 前置灰）。
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
import { type CategoryNode, CategoryTree } from './CategoryTree';
import { ConnectionSection } from './ConnectionSection';
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

  const defs = useMemo(() => mergeSettings(), []);
  const serverValues = useMemo(() => resolveDisplayValues(data, pending), [data, pending]);
  const logOverrides = useMemo(() => readLogEnvOverrides(data), [data]);

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
      } else {
        map[def.id] = pending[def.key] ?? serverValues[def.key] ?? def.fallback ?? '';
      }
    }
    return map;
    // localRevision 驱动 local 存储重读（writer 写入后自增）。
  }, [defs, theme, pending, serverValues, writer.localRevision]);

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

  const scopeDefs = useMemo(() => defs.filter((def) => def.scope === tab), [defs, tab]);
  const hits = useMemo(
    () => scopeDefs.filter((def) => matchesSearch(def, parsed, { haystacks, isModified })),
    [scopeDefs, parsed, haystacks, isModified],
  );

  const commonHits = useMemo(() => hits.filter((def) => def.common === true), [hits]);
  const sections = useMemo(
    () =>
      SETTINGS_CATEGORIES.map((category) => ({
        category,
        items: hits.filter((def) => def.category === category.id),
      })).filter((section) => section.items.length > 0),
    [hits],
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
    return nodes;
  }, [commonHits, sections, searching]);

  const connected = hasToken && connectionState === 'open';
  const configAvailable = hasToken && features.includes('config');
  const coreDisabled = !connected || !configAvailable || writer.writeUnavailable;
  const coreDisabledReason = writer.writeUnavailable
    ? t('settings.dialog.writeUnavailable')
    : !configAvailable
      ? t('settings.display.unavailableReason')
      : !connected
        ? t('settings.display.unavailableReason')
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
    // designLab：S1 双轨期先开旧页；S2 换懒加载内嵌区块 + 全屏。
    return (
      <Button
        variant="link"
        className="self-start text-sm"
        onClick={() => onNavigate({ domain: 'designLab' })}
      >
        {t('settings.dialog.openDesignLab')} →
      </Button>
    );
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
        onSave={(target, raw) => void writer.save(target, raw)}
        onReset={(target) => void writer.reset(target)}
      >
        {def.type === 'view' ? renderView(def) : undefined}
      </SettingRow>
    </div>
  );

  const listBody = () => {
    if (tab === 'project') {
      return <p className="p-4 text-sm text-muted">{t('settings.dialog.projectSoon')}</p>;
    }
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
          <StaleNotice message={t('settings.display.unavailableReason')} onRetry={reloadConfig} />
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
      </>
    );
  };

  const tabs: { id: ScopeTab; label: string; disabled?: boolean }[] = [
    { id: 'user', label: t('settings.dialog.tabUser') },
    { id: 'project', label: t('settings.dialog.tabProject'), disabled: true },
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
            disabled={entry.disabled}
            title={entry.disabled ? t('settings.dialog.projectSoon') : undefined}
            className={`rounded-sm px-3 py-1 text-sm transition-colors disabled:opacity-45 ${
              tab === entry.id ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-hover'
            }`}
            onClick={() => selectTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <SettingsSearchBar query={query} onQueryChange={setQuery} pluginIds={[]} />
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
