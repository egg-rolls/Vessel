// biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative icons are marked aria-hidden

import type { KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { Button, Textarea } from '../../components/ui';
import { GatewayHttpError } from '../../gateway/node';
import type {
  AttachmentListEntry,
  AttachmentListParams,
  AttachmentListReason,
  AttachmentListResult,
} from '../../gateway/node/attachments';
import { ATTACHMENT_LIST_LIMIT } from '../../gateway/node/attachments';
import type { MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import { MAX_COMPOSER_REFS } from '../../stores/composerDraftStore';
import { ATTACH_PATH_MAX, type AttachPathIssue, planAttachPaths } from './attach-paths';

/**
 * 「引用文件」弹层（0.52 单一入口）：**只产出路径**的两个 tab —— 浏览目录
 * （节点侧 `attachments.list`，默认）与粘贴路径（多行，逐行校验）。
 *
 * 为什么要有浏览：`refs[].path` 是「消费它的那台机器上的绝对路径」，人在浏览器里
 * 不知道 node 上长什么样（WSL 的 `/mnt/d/...` vs `D:\...`、远程 node 完全不可见）。
 * 为什么还要有粘贴：浏览只能到允许根里、旧 gateway 根本没这个方法，粘贴是两个都会
 * 遇到的退路。两者**同一份校验口径**（`planAttachPaths` + `addRef` + `runs.start`）。
 *
 * 两个 tab 都只做一件事：调 `addRef` 把路径写进草稿槽；不读内容、不上传、不支持
 * 远程 URL，也不改 refs 的数据形状（同一条 `MessageRef`）。边界仍由 `runs.start`
 * 的闸门终判 —— 这里列不出来（deny / 越界）的条目在发送时同样会被拒，两道判定用
 * 同一份配置。
 *
 * 唯一入口是工具栏左侧的回形针（`composerAttachLabel`），弹层由 `ComposerField`
 * 挂载；会话页与团队页用的是同一份。入口位置与面板无关，所以团队页同样能用。
 *
 * 键盘：整块在 `ModalShell` 的焦点圈内（Tab 走 tab / 条目 / 面包屑 / 按钮，
 * Esc 关闭并归还焦点）；条目本身是原生 `button` / `checkbox`，不用自己实现
 * roving tabindex。粘贴 tab 里裸 Enter 换行、Ctrl/⌘+Enter 添加。
 */

/**
 * 弹层需要的唯一 node 侧能力：列一层目录。
 *
 * `GatewayClient`（当前节点）与远端的 `TeamControl` 都满足这一条，所以弹层不认识
 * 完整的 gateway 客户端，也不因此多要一个 RPC。
 */
export interface AttachBrowseClient {
  listAttachments(params?: AttachmentListParams): Promise<AttachmentListResult>;
}

/** 图片 / 文档扩展名只看形状（与 `addRef` 一样不做真实类型探测）。 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'avif',
  'ico',
]);

const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'doc',
  'docx',
  'rtf',
  'txt',
  'md',
  'csv',
  'tsv',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'json',
  'yaml',
  'yml',
  'html',
  'xml',
]);

/** 路径 → 文件名（Windows / POSIX 分隔符都认，不引入 node:path）。 */
function pathBasename(target: string): string {
  const parts = target.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? target;
}

/** 扩展名 → `MessageRef.kind`（粗判；`kind` 只影响 chip 的图标 / 文案）。 */
function refKindForPath(target: string): MessageRef['kind'] {
  const name = pathBasename(target);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  return 'file';
}

/** 字节数 → 紧凑文案（面板里的次要信息，不追求精度）。 */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KiB`;
  const mib = kib / 1024;
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
}

/** 结果体里的稳定码 → 人话（与 `refsErrorText` 同族，但这里是「列不出来」而不是「被拒」）。 */
function reasonText(reason: AttachmentListReason): string {
  switch (reason) {
    case 'refs_denied':
      return t('chat.attach.reason.denied');
    case 'refs_outside_roots':
      return t('chat.attach.reason.outside');
    default:
      return t('chat.attach.reason.invalid');
  }
}

/** 读取失败 → 人话；旧 gateway 没有这个方法时给一句「换粘贴」。 */
function loadErrorText(error: unknown): string {
  if (error instanceof GatewayHttpError) {
    if (error.code === 'not_found' || error.code === 'not_supported') {
      return t('chat.attach.unavailable');
    }
    return t('chat.attach.error', { message: error.message });
  }
  return t('chat.attach.error', {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** 一行没通过校验的原因 → 人话（行号 + 原因；超长路径不整段回显）。 */
function issueText(issue: AttachPathIssue, maxRefs: number): string {
  if (issue.reason === 'tooLong') {
    return t('composer.attach.error.tooLong', { line: issue.line, max: ATTACH_PATH_MAX });
  }
  if (issue.reason === 'tooMany') {
    return t('composer.attach.error.tooMany', { line: issue.line, max: maxRefs });
  }
  return t('composer.attach.error.absolute', { line: issue.line, path: issue.path });
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
  const trail = [{ label: pathBasename(root) || root, path: root }];
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

/** 目录图标（与 `MessageRefs` 同口径：装饰性，颜色继承 currentColor）。 */
function DirIcon(): ReactNode {
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

export interface AttachDialogProps {
  /** 弹层的 DOM id：触发按钮的 `aria-controls` 指向它。 */
  id: string;
  /** 目录浏览的数据源（`attachments.list`；旧 gateway 缺这个方法 → 浏览 tab 提示换粘贴）。 */
  client: AttachBrowseClient;
  /** 加一条引用（现有 `addRef`）；返回 `false` 表示草稿槽已满（按「超出上限」逐行报）。 */
  onAddRef: (ref: MessageRef) => boolean;
  /** 该草稿槽当前已有的引用条数（粘贴的逐行上限判定）。 */
  refCount: number;
  onClose: () => void;
  /** 单条消息的引用上限（与 composer 的 store 同值，缺省 32）。 */
  maxRefs?: number;
}

/**
 * 引用文件弹层：浏览 / 粘贴两个 tab + 一个底部动作行。
 *
 * 两个 tab 共用同一份「已选 / 已引用」计数与同一个 `addRef`：
 * - 浏览：多选后一次性加入，成功就关（失败留一条 toast）；
 * - 粘贴：逐行校验、失败不整批回滚 —— 通过的行照常进引用区（chip 立刻出现），
 *   没通过的行逐条报「第 N 行 + 原因」并留在输入框里让人改，一条都没失败才收起。
 */
export function AttachDialog({
  id,
  client,
  onAddRef,
  refCount,
  onClose,
  maxRefs = MAX_COMPOSER_REFS,
}: AttachDialogProps) {
  const toast = useToast();
  const [tab, setTab] = useState<'browse' | 'paste'>('browse');
  const [listing, setListing] = useState<AttachmentListResult | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [selected, setSelected] = useState<readonly MessageRef[]>([]);
  // 粘贴 tab：多行原文 + 上一轮的成功 / 失败明细。
  const [pasteValue, setPasteValue] = useState('');
  const [pasteIssues, setPasteIssues] = useState<readonly AttachPathIssue[]>([]);
  const [pasteAdded, setPasteAdded] = useState(0);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);
  const pasteId = `${id}-paste`;

  // 切到粘贴 tab 就把焦点放进输入区（不用 autoFocus 属性：仓库 a11y 规则不允许）。
  useEffect(() => {
    if (tab === 'paste') pasteRef.current?.focus();
  }, [tab]);

  const currentDir = listing?.dir;
  const roots = listing?.roots ?? [];
  const entries = listing?.entries ?? [];
  const reason = listing?.reason;

  const load = useCallback(
    async (dir: string | undefined, hidden: boolean) => {
      setLoading(true);
      setError(undefined);
      const params: AttachmentListParams = { limit: ATTACHMENT_LIST_LIMIT };
      if (dir !== undefined) params.dir = dir;
      if (hidden) params.include_hidden = true;
      try {
        setListing(await client.listAttachments(params));
      } catch (failure) {
        setListing(undefined);
        setError(loadErrorText(failure));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  // 打开面板先拿 roots（不带 dir），之后的每次导航 / 隐藏项开关都重取当前层。
  useEffect(() => {
    void load(undefined, false);
  }, [load]);

  const toggleEntry = (entry: AttachmentListEntry) => {
    const existing = selected.findIndex((ref) => ref.path === entry.path);
    if (existing !== -1) {
      setSelected(selected.filter((_, index) => index !== existing));
      return;
    }
    if (selected.length >= maxRefs) {
      toast.error(t('chat.refs.reject.tooMany', { max: maxRefs }));
      return;
    }
    const ref: MessageRef = {
      kind: refKindForPath(entry.path),
      path: entry.path,
      name: entry.name,
    };
    if (entry.bytes !== undefined) ref.bytes = entry.bytes;
    setSelected([...selected, ref]);
  };

  const confirmSelection = () => {
    let added = 0;
    for (const ref of selected) {
      // 失败（多半是草稿已有的引用把上限占满了）就停：再试下去只会刷一串同样的 toast。
      if (!onAddRef(ref)) break;
      added += 1;
    }
    if (added === 0) return;
    toast.success(t('chat.attach.added', { count: added }));
    onClose();
  };

  /**
   * 粘贴：多行 → 逐行校验 → 逐条 `addRef`；失败不整批回滚。
   *
   * 通过校验的行照常进引用区（chip 立刻出现），没通过的行逐条报「第 N 行 + 原因」
   * 并留在输入框里让人改；一条都没失败才收起弹层。`addRef` 返回 `false` 只可能是
   * 草稿槽满了（32 条），按「超出上限」逐行报。
   */
  const submitPaste = () => {
    // 空输入不当作「成功」：不然一次 Ctrl+Enter 就把弹层关掉、什么也没加。
    if (pasteValue.trim().length === 0) return;
    const plan = planAttachPaths(pasteValue, refCount, maxRefs);
    const failed: AttachPathIssue[] = [...plan.issues];
    let count = 0;
    for (const row of plan.accepted) {
      const ref: MessageRef = {
        kind: refKindForPath(row.path),
        path: row.path,
        name: pathBasename(row.path),
      };
      if (onAddRef(ref)) count += 1;
      else failed.push({ line: row.line, path: row.path, reason: 'tooMany' });
    }
    if (failed.length === 0) {
      onClose();
      return;
    }
    failed.sort((left, right) => left.line - right.line);
    setPasteAdded(count);
    setPasteIssues(failed);
    // 没成功的行留在输入框里，行号随下一次提交重新算（不额外维护映射）。
    setPasteValue(failed.map((issue) => issue.path).join('\n'));
  };

  const onPasteKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组字中的键一律不接管（与两个 composer 的 Enter 处理同一口径）。
    if (event.nativeEvent.isComposing) return;
    // 只有显式和弦才是「添加」：裸 Enter 在 textarea 里换行（一行一个路径）。
    // Esc 由 ModalShell 的 `useModalA11y` 统一接管（关闭 + 归还焦点）。
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitPaste();
    }
  };

  const trail = currentDir === undefined ? [] : trailFor(currentDir, roots);

  return (
    <ModalShell
      id={id}
      label={t('chat.attach.title')}
      onClose={onClose}
      closeLabel={t('common.close')}
      size="lg"
    >
      <h2 className="modal-title">{t('chat.attach.title')}</h2>
      <fieldset className="attach-tabs">
        <legend className="sr-only">{t('chat.attach.title')}</legend>
        <Button
          size="small"
          variant={tab === 'browse' ? 'primary' : 'plain'}
          aria-pressed={tab === 'browse'}
          data-autofocus
          onClick={() => setTab('browse')}
        >
          {t('chat.attach.tab.browse')}
        </Button>
        <Button
          size="small"
          variant={tab === 'paste' ? 'primary' : 'plain'}
          aria-pressed={tab === 'paste'}
          onClick={() => setTab('paste')}
        >
          {t('chat.attach.tab.paste')}
        </Button>
      </fieldset>

      {tab === 'paste' ? (
        <div className="attach-paste">
          <label className="attach-paste-label" htmlFor={pasteId}>
            {t('chat.attach.paste.label')}
          </label>
          <Textarea
            ref={pasteRef}
            id={pasteId}
            rows={3}
            value={pasteValue}
            onChange={(event) => {
              setPasteValue(event.target.value);
              setPasteAdded(0);
            }}
            placeholder={t('composer.attach.placeholder')}
            aria-label={t('composer.attach.input')}
            aria-describedby={`${pasteId}-hint`}
            invalid={pasteIssues.length > 0}
            spellCheck={false}
            className="resize-none font-mono text-sm"
            onKeyDown={onPasteKeyDown}
          />
          <p id={`${pasteId}-hint`} className="attach-note">
            {t('composer.attach.hint', { max: maxRefs })}
          </p>
          <p className="attach-note">{t('chat.attach.paste.hint')}</p>
          {pasteAdded > 0 && (
            <p className="attach-note text-accent" role="status">
              {t('composer.attach.added', { count: pasteAdded })}
            </p>
          )}
          {pasteIssues.length > 0 && (
            <div className="flex flex-col gap-1" role="alert">
              <p className="attach-note attach-note-error">
                {t('composer.attach.rejected', { count: pasteIssues.length })}
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {pasteIssues.map((issue) => (
                  <li
                    key={`${issue.line}:${issue.path}`}
                    className="break-all font-mono text-xs text-danger"
                  >
                    {issueText(issue, maxRefs)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="attach-browse">
          <div className="attach-browse-bar">
            {listing?.parent !== undefined ? (
              <Button
                size="small"
                variant="plain"
                onClick={() => void load(listing?.parent, includeHidden)}
              >
                {t('chat.attach.up')}
              </Button>
            ) : null}
            <label className="attach-hidden">
              <input
                type="checkbox"
                checked={includeHidden}
                onChange={(event) => {
                  const next = event.target.checked;
                  setIncludeHidden(next);
                  void load(currentDir, next);
                }}
              />
              {t('chat.attach.hidden')}
            </label>
            {loading ? <span className="attach-note">{t('common.loading')}</span> : null}
          </div>

          {trail.length > 0 ? (
            <nav className="attach-crumbs" aria-label={t('chat.attach.crumbs')}>
              {trail.map((crumb, index) => (
                <span className="attach-crumb-item" key={crumb.path}>
                  {index > 0 ? (
                    <span className="attach-crumb-sep" aria-hidden="true">
                      /
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="attach-crumb"
                    onClick={() => void load(crumb.path, includeHidden)}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          ) : null}

          {error !== undefined ? <p className="attach-note attach-note-error">{error}</p> : null}
          {reason !== undefined ? (
            <p className="attach-note attach-note-error">{reasonText(reason)}</p>
          ) : null}

          {currentDir === undefined && error === undefined && listing !== undefined ? (
            <div className="attach-roots">
              <p className="attach-note">{t('chat.attach.roots')}</p>
              <ul className="attach-list">
                {roots.map((root) => (
                  <li key={root}>
                    <button
                      type="button"
                      className="attach-row attach-row-dir"
                      onClick={() => void load(root, includeHidden)}
                    >
                      <span className="attach-row-icon">
                        <DirIcon />
                      </span>
                      <span className="attach-row-name">{root}</span>
                      <span className="attach-row-meta">{t('chat.attach.dir')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {currentDir !== undefined && entries.length === 0 && reason === undefined ? (
            <p className="attach-note">{t('chat.attach.empty')}</p>
          ) : null}

          {entries.length > 0 ? (
            <ul className="attach-list">
              {entries.map((entry) =>
                entry.kind === 'dir' ? (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="attach-row attach-row-dir"
                      onClick={() => void load(entry.path, includeHidden)}
                    >
                      <span className="attach-row-icon">
                        <DirIcon />
                      </span>
                      <span className="attach-row-name">{entry.name}</span>
                      <span className="attach-row-meta">{t('chat.attach.dir')}</span>
                    </button>
                  </li>
                ) : (
                  <li key={entry.path}>
                    <label className="attach-row attach-row-file">
                      <input
                        type="checkbox"
                        checked={selected.some((ref) => ref.path === entry.path)}
                        onChange={() => toggleEntry(entry)}
                      />
                      <span className="attach-row-name">{entry.name}</span>
                      <span className="attach-row-meta">{formatBytes(entry.bytes)}</span>
                    </label>
                  </li>
                ),
              )}
            </ul>
          ) : null}

          {listing?.truncated === true ? (
            <p className="attach-note">
              {t('chat.attach.truncated', { limit: ATTACHMENT_LIST_LIMIT })}
            </p>
          ) : null}
        </div>
      )}

      <div className="modal-actions">
        <span className="attach-count">
          {tab === 'paste'
            ? t('composer.attach.count', { used: refCount, max: maxRefs })
            : t('chat.attach.selected', { count: selected.length, max: maxRefs })}
        </span>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        {tab === 'paste' ? (
          <Button variant="primary" onClick={submitPaste} disabled={pasteValue.trim().length === 0}>
            {t('composer.attach.add')}
          </Button>
        ) : (
          <Button variant="primary" onClick={confirmSelection} disabled={selected.length === 0}>
            {selected.length > 0
              ? t('chat.attach.addCount', { count: selected.length })
              : t('chat.attach.add')}
          </Button>
        )}
      </div>
    </ModalShell>
  );
}
