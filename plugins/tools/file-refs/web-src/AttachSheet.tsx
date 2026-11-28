/**
 * 插件自持「引用文件」弹层（S2b，GAP-1 裁 (a)：上传 / 粘贴 / 浏览三入口）。
 *
 * 宿主 ModalShell 不可 import（plugin-ui / web 组件不进 embed）——焦点圈 / Esc /
 * 归还焦点 / body 滚动锁在此按同一口径重建（结构化 DOM 访问，不依赖 bun-types
 * 受限全局）。数据走端口：上传 = pickFiles + stageFiles（共享链路）；粘贴 / 浏览
 * = addRef + insertAtomic（token 同形，消灭「粘贴 ref 无 token」态）；浏览 =
 * port.listAttachments（能力探测；旧宿主 / 旧 gateway 降级提示换粘贴）。
 */

import type {
  ComposerEditorPort,
  ComposerListEntry,
  ComposerListResult,
  ComposerRef,
  VesselPluginHost,
} from '@vessel-agent/plugin-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ATTACH_PATH_MAX, type AttachPathIssue, MAX_REFS, planAttachPaths } from './attach-paths';
import { type CopyKey, translator } from './i18n';
import { displayNameOf, kindOfPath } from './icons';
import { buildToken, stageFiles } from './staging';

type T = (key: CopyKey, vars?: Record<string, string | number>) => string;

/** 结构化 DOM 面（root tsc / bun-types 的全局 document 是受限形状）。 */
interface SheetDom {
  document: {
    activeElement: { focus?: () => void } | null;
    body: { style: { overflow: string } };
    addEventListener(
      type: 'keydown',
      listener: (event: { key: string; shiftKey: boolean; preventDefault(): void }) => void,
    ): void;
    removeEventListener(
      type: 'keydown',
      listener: (event: { key: string; shiftKey: boolean; preventDefault(): void }) => void,
    ): void;
  };
}
const dom = globalThis as unknown as SheetDom;

interface Focusable {
  focus(): void;
  offsetParent: unknown;
}
interface SheetContainer {
  querySelectorAll(selector: string): ArrayLike<Focusable>;
  querySelector(selector: string): Focusable | null;
  focus(): void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 焦点圈 + Esc + 归还焦点 + 滚动锁（与宿主 useModalA11y 同口径，自包含）。 */
function useSheetA11y(onClose: () => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = dom.document.activeElement;
    const root = containerRef.current as unknown as SheetContainer | null;
    const previousOverflow = dom.document.body.style.overflow;
    dom.document.body.style.overflow = 'hidden';
    const focusables = (): Focusable[] => {
      if (root === null) return [];
      const all = Array.from(root.querySelectorAll(FOCUSABLE));
      return all.filter((el) => el.offsetParent !== null || el === dom.document.activeElement);
    };
    const preferred = root?.querySelector('[data-autofocus]') ?? null;
    (preferred ?? focusables()[0] ?? root)?.focus();

    const onKeyDown = (event: { key: string; shiftKey: boolean; preventDefault(): void }) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && dom.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && dom.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dom.document.addEventListener('keydown', onKeyDown);
    return () => {
      dom.document.removeEventListener('keydown', onKeyDown);
      dom.document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, []);

  return containerRef;
}

/** host 语言订阅（与 FileRefCard useHostLang 同口径）。 */
function useHostLang(host: VesselPluginHost): string {
  const [theme, setTheme] = useState(() => host.theme.get());
  useEffect(() => host.theme.subscribe(setTheme), [host]);
  return theme.lang;
}

/** 字节数 → 短文案（浏览行 meta；与宿主 formatBytes 同族粗判）。 */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 目录路径 → 面包屑（根之后按分隔符切，WSL / Windows 同一套）。 */
function trailFor(dir: string, roots: readonly string[]): { label: string; path: string }[] {
  const normalizedDir = dir.replace(/\\/g, '/');
  const root = roots.find((candidate) => {
    const normalizedRoot = candidate.replace(/\\/g, '/');
    return (
      normalizedDir === normalizedRoot ||
      normalizedDir.startsWith(normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`)
    );
  });
  if (root === undefined) return [];
  const trail = [{ label: displayNameOf(root) || root, path: root }];
  let currentPath = root;
  const tail = dir
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
  for (const part of tail) {
    const separator = currentPath.endsWith('\\') || currentPath.endsWith('/') ? '' : '/';
    currentPath = `${currentPath}${separator}${part}`;
    trail.push({ label: part, path: currentPath });
  }
  return trail;
}

function reasonText(reason: NonNullable<ComposerListResult['reason']>, t: T): string {
  switch (reason) {
    case 'refs_denied':
      return t('attach.reason.denied');
    case 'refs_outside_roots':
      return t('attach.reason.outside');
    default:
      return t('attach.reason.invalid');
  }
}

/** 读取失败 → 人话；旧 gateway 没有这个方法时给一句「换粘贴」（结构码探测）。 */
function loadErrorText(error: unknown, t: T): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'not_found' || code === 'not_supported') return t('attach.unavailable');
  return t('attach.error', {
    message: error instanceof Error ? error.message : String(error),
  });
}

function issueText(issue: AttachPathIssue, t: T): string {
  if (issue.reason === 'tooLong') {
    return t('attach.error.tooLong', { line: issue.line, max: ATTACH_PATH_MAX });
  }
  if (issue.reason === 'tooMany') {
    return t('attach.error.tooMany', { line: issue.line, max: MAX_REFS });
  }
  return t('attach.error.absolute', { line: issue.line, path: issue.path });
}

/** 目录图标（装饰性，颜色继承 currentColor）。 */
function DirIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3l1.5 2h6.5A1.5 1.5 0 0 1 17 8.5v6A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z" />
    </svg>
  );
}

export interface AttachSheetProps {
  port: ComposerEditorPort;
  host: VesselPluginHost;
  onClose: () => void;
  /** 原生选择框（attach-handler 的能力探测 + 降级档）；取消 ⇒ 空数组。 */
  pickFiles: () => Promise<File[]>;
}

export function AttachSheet({ port, host, onClose, pickFiles }: AttachSheetProps) {
  const lang = useHostLang(host);
  const t = useMemo(() => translator(lang), [lang]);
  const containerRef = useSheetA11y(onClose);
  const [tab, setTab] = useState<'upload' | 'browse' | 'paste'>('upload');
  const [listing, setListing] = useState<ComposerListResult | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [selected, setSelected] = useState<readonly ComposerRef[]>([]);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteIssues, setPasteIssues] = useState<readonly AttachPathIssue[]>([]);
  const [pasteAdded, setPasteAdded] = useState(0);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);

  const canBrowse = typeof port.listAttachments === 'function';
  const refCount = port.refs().length;

  useEffect(() => {
    if (tab === 'paste') pasteRef.current?.focus();
  }, [tab]);

  const currentDir = listing?.dir;
  const roots = listing?.roots ?? [];
  const entries = listing?.entries ?? [];
  const reason = listing?.reason;

  const load = async (dir: string | undefined, hidden: boolean) => {
    if (typeof port.listAttachments !== 'function') return;
    setLoading(true);
    setError(undefined);
    try {
      setListing(
        await port.listAttachments({
          limit: 200,
          ...(dir !== undefined ? { dir } : {}),
          ...(hidden ? { include_hidden: true } : {}),
        }),
      );
    } catch (failure) {
      setListing(undefined);
      setError(loadErrorText(failure, t));
    } finally {
      setLoading(false);
    }
  };

  // 打开浏览 tab 先拿 roots（不带 dir）；导航 / 隐藏项开关重取当前层。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在切入浏览时拉 roots，导航走显式 load
  useEffect(() => {
    if (tab !== 'browse' || !canBrowse) return;
    void load(undefined, false);
  }, [tab, canBrowse]);

  /** 加一条引用 + 同形 token（消灭「粘贴 ref 无 token」态）；false = 草稿槽满。 */
  const addOne = (ref: ComposerRef): boolean => {
    if (!port.addRef(ref)) return false;
    port.insertAtomic(buildToken(ref.name ?? displayNameOf(ref.path), ref.path));
    return true;
  };

  const toggleEntry = (entry: ComposerListEntry) => {
    const existing = selected.findIndex((ref) => ref.path === entry.path);
    if (existing !== -1) {
      setSelected(selected.filter((_, index) => index !== existing));
      return;
    }
    if (selected.length >= MAX_REFS) {
      host.toast({ kind: 'error', text: t('attach.error.tooMany', { line: 0, max: MAX_REFS }) });
      return;
    }
    const ref: ComposerRef = {
      kind: kindOfPath(entry.path),
      path: entry.path,
      name: entry.name,
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
    };
    setSelected([...selected, ref]);
  };

  const confirmSelection = () => {
    let added = 0;
    for (const ref of selected) {
      if (!addOne(ref)) break;
      added += 1;
    }
    if (added === 0) return;
    host.toast({ kind: 'success', text: t('attach.added', { count: added }) });
    onClose();
  };

  /** 粘贴：逐行校验 → 逐条 addRef + token；失败不整批回滚（与宿主旧弹层同口径）。 */
  const submitPaste = () => {
    if (pasteValue.trim().length === 0) return;
    const plan = planAttachPaths(pasteValue, refCount, MAX_REFS);
    const failed: AttachPathIssue[] = [...plan.issues];
    let count = 0;
    for (const row of plan.accepted) {
      const ref: ComposerRef = {
        kind: kindOfPath(row.path),
        path: row.path,
        name: displayNameOf(row.path),
      };
      if (addOne(ref)) count += 1;
      else failed.push({ line: row.line, path: row.path, reason: 'tooMany' });
    }
    if (failed.length === 0) {
      onClose();
      return;
    }
    failed.sort((left, right) => left.line - right.line);
    setPasteAdded(count);
    setPasteIssues(failed);
    setPasteValue(failed.map((issue) => issue.path).join('\n'));
  };

  const onPasteKeyDown = (event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    nativeEvent: { isComposing: boolean };
    preventDefault(): void;
  }) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitPaste();
    }
  };

  /** 上传：原生选择框 → 共享暂存链路（光标位插卡）→ 收起弹层。 */
  const chooseUpload = async () => {
    const files = await pickFiles();
    if (files.length === 0) return;
    stageFiles(files, port, { offset: port.getCaretOffset() });
    onClose();
  };

  const trail = currentDir === undefined ? [] : trailFor(currentDir, roots);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop mousedown closes the sheet（与宿主 ModalShell 同口径）
    <div
      className="fr-attach-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        className="fr-attach-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('attach.title')}
        tabIndex={-1}
      >
        <h2 className="fr-attach-title">{t('attach.title')}</h2>
        <fieldset className="fr-attach-tabs">
          <legend className="fr-attach-sr">{t('attach.title')}</legend>
          <button
            type="button"
            className={tab === 'upload' ? 'fr-attach-tab is-active' : 'fr-attach-tab'}
            aria-pressed={tab === 'upload'}
            data-autofocus
            onClick={() => setTab('upload')}
          >
            {t('attach.tab.upload')}
          </button>
          <button
            type="button"
            className={tab === 'browse' ? 'fr-attach-tab is-active' : 'fr-attach-tab'}
            aria-pressed={tab === 'browse'}
            onClick={() => setTab('browse')}
          >
            {t('attach.tab.browse')}
          </button>
          <button
            type="button"
            className={tab === 'paste' ? 'fr-attach-tab is-active' : 'fr-attach-tab'}
            aria-pressed={tab === 'paste'}
            onClick={() => setTab('paste')}
          >
            {t('attach.tab.paste')}
          </button>
        </fieldset>

        {tab === 'upload' ? (
          <div className="fr-attach-upload">
            <p className="fr-attach-note">{t('attach.upload.hint')}</p>
            <button type="button" className="fr-attach-primary" onClick={() => void chooseUpload()}>
              {t('attach.upload.choose')}
            </button>
          </div>
        ) : tab === 'paste' ? (
          <div className="fr-attach-paste">
            <label className="fr-attach-label" htmlFor="fr-attach-paste-input">
              {t('attach.paste.label')}
            </label>
            <textarea
              ref={pasteRef}
              id="fr-attach-paste-input"
              rows={3}
              value={pasteValue}
              onChange={(event) => {
                setPasteValue(event.target.value);
                setPasteAdded(0);
              }}
              placeholder={t('attach.paste.placeholder')}
              aria-label={t('attach.paste.input')}
              aria-describedby="fr-attach-paste-hint"
              aria-invalid={pasteIssues.length > 0}
              spellCheck={false}
              className="fr-attach-textarea"
              onKeyDown={onPasteKeyDown}
            />
            <p id="fr-attach-paste-hint" className="fr-attach-note">
              {t('attach.paste.keys', { max: MAX_REFS })}
            </p>
            <p className="fr-attach-note">{t('attach.paste.hint')}</p>
            {pasteAdded > 0 && (
              <p className="fr-attach-note fr-attach-ok" role="status">
                {t('attach.addedCount', { count: pasteAdded })}
              </p>
            )}
            {pasteIssues.length > 0 && (
              <div role="alert">
                <p className="fr-attach-note fr-attach-error">
                  {t('attach.rejected', { count: pasteIssues.length })}
                </p>
                <ul className="fr-attach-issues">
                  {pasteIssues.map((issue) => (
                    <li key={`${issue.line}:${issue.path}`}>{issueText(issue, t)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="fr-attach-browse">
            {!canBrowse ? (
              <p className="fr-attach-note fr-attach-error">{t('attach.unavailable')}</p>
            ) : (
              <>
                <div className="fr-attach-bar">
                  {listing?.parent !== undefined ? (
                    <button
                      type="button"
                      className="fr-attach-plain"
                      onClick={() => void load(listing?.parent, includeHidden)}
                    >
                      {t('attach.up')}
                    </button>
                  ) : null}
                  <label className="fr-attach-hidden">
                    <input
                      type="checkbox"
                      checked={includeHidden}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setIncludeHidden(next);
                        void load(currentDir, next);
                      }}
                    />
                    {t('attach.hidden')}
                  </label>
                  {loading ? <span className="fr-attach-note">{t('attach.loading')}</span> : null}
                </div>

                {trail.length > 0 ? (
                  <nav className="fr-attach-crumbs" aria-label={t('attach.crumbs')}>
                    {trail.map((crumb, index) => (
                      <span className="fr-attach-crumb-item" key={crumb.path}>
                        {index > 0 ? (
                          <span className="fr-attach-crumb-sep" aria-hidden="true">
                            /
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="fr-attach-crumb"
                          onClick={() => void load(crumb.path, includeHidden)}
                        >
                          {crumb.label}
                        </button>
                      </span>
                    ))}
                  </nav>
                ) : null}

                {error !== undefined ? (
                  <p className="fr-attach-note fr-attach-error">{error}</p>
                ) : null}
                {reason !== undefined ? (
                  <p className="fr-attach-note fr-attach-error">{reasonText(reason, t)}</p>
                ) : null}

                {currentDir === undefined && error === undefined && listing !== undefined ? (
                  <div>
                    <p className="fr-attach-note">{t('attach.roots')}</p>
                    <ul className="fr-attach-list">
                      {roots.map((root) => (
                        <li key={root}>
                          <button
                            type="button"
                            className="fr-attach-row fr-attach-row-dir"
                            onClick={() => void load(root, includeHidden)}
                          >
                            <span className="fr-attach-row-icon">
                              <DirIcon />
                            </span>
                            <span className="fr-attach-row-name">{root}</span>
                            <span className="fr-attach-row-meta">{t('attach.dir')}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {currentDir !== undefined && entries.length === 0 && reason === undefined ? (
                  <p className="fr-attach-note">{t('attach.empty')}</p>
                ) : null}

                {entries.length > 0 ? (
                  <ul className="fr-attach-list">
                    {entries.map((entry) =>
                      entry.kind === 'dir' ? (
                        <li key={entry.path}>
                          <button
                            type="button"
                            className="fr-attach-row fr-attach-row-dir"
                            onClick={() => void load(entry.path, includeHidden)}
                          >
                            <span className="fr-attach-row-icon">
                              <DirIcon />
                            </span>
                            <span className="fr-attach-row-name">{entry.name}</span>
                            <span className="fr-attach-row-meta">{t('attach.dir')}</span>
                          </button>
                        </li>
                      ) : (
                        <li key={entry.path}>
                          <label className="fr-attach-row fr-attach-row-file">
                            <input
                              type="checkbox"
                              checked={selected.some((ref) => ref.path === entry.path)}
                              onChange={() => toggleEntry(entry)}
                            />
                            <span className="fr-attach-row-name">{entry.name}</span>
                            <span className="fr-attach-row-meta">{formatBytes(entry.bytes)}</span>
                          </label>
                        </li>
                      ),
                    )}
                  </ul>
                ) : null}

                {listing?.truncated === true ? (
                  <p className="fr-attach-note">{t('attach.truncated', { limit: 200 })}</p>
                ) : null}
              </>
            )}
          </div>
        )}

        <div className="fr-attach-actions">
          <span className="fr-attach-count">
            {tab === 'paste'
              ? t('attach.count', { used: refCount, max: MAX_REFS })
              : tab === 'browse'
                ? t('attach.selected', { count: selected.length, max: MAX_REFS })
                : ''}
          </span>
          <button type="button" className="fr-attach-plain" onClick={onClose}>
            {t('attach.cancel')}
          </button>
          {tab === 'paste' ? (
            <button
              type="button"
              className="fr-attach-primary"
              onClick={submitPaste}
              disabled={pasteValue.trim().length === 0}
            >
              {t('attach.add')}
            </button>
          ) : tab === 'browse' ? (
            <button
              type="button"
              className="fr-attach-primary"
              onClick={confirmSelection}
              disabled={selected.length === 0}
            >
              {selected.length > 0
                ? t('attach.addCount', { count: selected.length })
                : t('attach.add')}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="fr-attach-close"
          aria-label={t('attach.close')}
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  );
}
