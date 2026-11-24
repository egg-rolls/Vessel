/**
 * 设置搜索栏（vscode-settings-design §3.3）：SearchInput + @token 筛选菜单
 * （不必记语法）+ 清除筛选。输入防抖由父级负责（150ms）。
 */
import { useRef } from 'react';
import {
  Button,
  GHOST_BUTTON_CLASS,
  GHOST_CONTROL_CLASS,
  SearchInput,
} from '../../../components/ui';
import { cn } from '../../../components/ui/cn';
import { t } from '../../../i18n';

export interface SettingsSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  pluginIds: readonly string[];
}

export function SettingsSearchBar({ query, onQueryChange, pluginIds }: SettingsSearchBarProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const appendToken = (token: string) => {
    const trimmed = query.trim();
    if (trimmed.split(/\s+/).includes(token)) return;
    onQueryChange(trimmed ? `${trimmed} ${token}` : token);
    if (detailsRef.current) detailsRef.current.open = false;
  };

  const hasFilter = /(^|\s)@(modified|plugin:|local|user|project)/.test(query);

  return (
    <div className="flex items-center gap-2">
      <SearchInput
        className={cn('grow', GHOST_CONTROL_CLASS)}
        value={query}
        onChange={onQueryChange}
        placeholder={t('settings.dialog.searchPlaceholder')}
        ariaLabel={t('settings.dialog.searchPlaceholder')}
      />
      <details ref={detailsRef} className="relative shrink-0">
        <summary
          className={cn(
            'cursor-pointer list-none rounded-sm px-2.5 py-1.5 text-sm text-muted select-none tint-hover',
            GHOST_BUTTON_CLASS,
          )}
        >
          @ ▾
        </summary>
        <div className="absolute right-0 z-10 mt-1 flex w-56 flex-col gap-0.5 rounded-sm border border-line bg-surface p-1.5 shadow-elev">
          <button
            type="button"
            className="rounded-sm bg-transparent px-2 py-1 text-left text-sm hover:bg-hover"
            onClick={() => appendToken('@modified')}
          >
            {t('settings.dialog.filterModified')}
          </button>
          <button
            type="button"
            className="rounded-sm bg-transparent px-2 py-1 text-left text-sm hover:bg-hover"
            onClick={() => appendToken('@local')}
          >
            @local
          </button>
          <button
            type="button"
            className="rounded-sm bg-transparent px-2 py-1 text-left text-sm hover:bg-hover"
            onClick={() => appendToken('@user')}
          >
            @user
          </button>
          <button
            type="button"
            className="rounded-sm bg-transparent px-2 py-1 text-left text-sm hover:bg-hover"
            onClick={() => appendToken('@project')}
          >
            @project
          </button>
          {pluginIds.map((pluginId) => (
            <button
              key={pluginId}
              type="button"
              className="rounded-sm bg-transparent px-2 py-1 text-left text-sm hover:bg-hover"
              onClick={() => appendToken(`@plugin:${pluginId}`)}
            >
              @plugin:{pluginId}
            </button>
          ))}
        </div>
      </details>
      {(query || hasFilter) && (
        <Button variant="link" className="shrink-0 text-sm" onClick={() => onQueryChange('')}>
          {t('settings.dialog.clearFilters')}
        </Button>
      )}
    </div>
  );
}
