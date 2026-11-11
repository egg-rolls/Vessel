// biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative icons are marked aria-hidden

import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { ModalShell } from '../../components/Modal';
import { useToast } from '../../components/ToastProvider';
import { Button } from '../../components/ui';
import type { GatewayClient } from '../../gateway/node';
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

/**
 * 附件引用面板（0.52）：**只产出路径**的两条入口并排 —— 粘贴路径（方案 1）与
 * 浏览目录（方案 3，节点侧 `attachments.list`）。
 *
 * 为什么要有浏览：`refs[].path` 是「消费它的那台机器上的绝对路径」，人在浏览器里
 * 不知道 node 上长什么样（WSL 的 `/mnt/d/...` vs `D:\...`、远程 node 完全不可见）。
 * 面板只做三件事：列**单层**、多选、调 `addRef`；不读内容、不上传、不支持远程 URL，
 * 也不改 refs 的数据形状（同一条 `MessageRef`）。边界仍由 `runs.start` 的闸门终判 ——
 * 这里列不出来（deny / 越界）的条目在发送时同样会被拒，两道判定用同一份配置。
 *
 * 键盘：整块在 `ModalShell` 的焦点圈内（Tab 走条目 / 面包屑 / 按钮，Esc 关闭）；
 * 条目本身是原生 `button` / `checkbox`，不用自己实现 roving tabindex。
 */

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
export function pathBasename(target: string): string {
  const parts = target.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? target;
}

/** 扩展名 → `MessageRef.kind`（粗判；`kind` 只影响 chip 的图标 / 文案）。 */
export function refKindForPath(target: string): MessageRef['kind'] {
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

export interface AttachBrowsePanelProps {
  client: GatewayClient;
  /** 加一条引用；返回 `false` 表示前端上限 / 形状拒了（toast 已由调用方出）。 */
  onAddRef: (ref: MessageRef) => boolean;
  onClose: () => void;
  /** 单条消息的引用上限（与 composer 的 store 同值，缺省 32）。 */
  maxRefs?: number;
}

export function AttachBrowsePanel({
  client,
  onAddRef,
  onClose,
  maxRefs = MAX_COMPOSER_REFS,
}: AttachBrowsePanelProps) {
  const toast = useToast();
  const [tab, setTab] = useState<'browse' | 'paste'>('browse');
  const [listing, setListing] = useState<AttachmentListResult | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [selected, setSelected] = useState<readonly MessageRef[]>([]);

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

  const submitPaste = () => {
    const target = pasteValue.trim();
    if (target.length === 0) return;
    if (onAddRef({ kind: refKindForPath(target), path: target, name: pathBasename(target) })) {
      toast.success(t('chat.attach.added', { count: 1 }));
      onClose();
    }
  };

  const trail = currentDir === undefined ? [] : trailFor(currentDir, roots);

  return (
    <ModalShell
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
          <label className="attach-paste-label" htmlFor="attach-paste-input">
            {t('chat.attach.paste.label')}
          </label>
          <div className="attach-paste-row">
            <input
              id="attach-paste-input"
              className="attach-paste-input"
              value={pasteValue}
              placeholder={t('chat.attach.paste.placeholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setPasteValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitPaste();
                }
              }}
            />
            <Button variant="plain" onClick={submitPaste} disabled={pasteValue.trim().length === 0}>
              {t('chat.attach.add')}
            </Button>
          </div>
          <p className="attach-note">{t('chat.attach.paste.hint')}</p>
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
          {t('chat.attach.selected', { count: selected.length, max: maxRefs })}
        </span>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={confirmSelection} disabled={selected.length === 0}>
          {selected.length > 0
            ? t('chat.attach.addCount', { count: selected.length })
            : t('chat.attach.add')}
        </Button>
      </div>
    </ModalShell>
  );
}

/**
 * 输入框上方的「引用文件」入口（attach-paste 未合入前的**本单入口**）。
 *
 * attach-paste 合入后，它的工具栏按钮与本组件可以并存：两者都只是 `addRef` 的调用方，
 * 面板本身不依赖入口位置。按钮单独一行，避免改 `ComposerChrome` 的引用区（那是别人在改）。
 */
export function AttachBrowseLauncher({
  client,
  onAddRef,
  disabled = false,
}: {
  client: GatewayClient;
  onAddRef: (ref: MessageRef) => boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="attach-entry">
        <Button
          size="small"
          variant="plain"
          disabled={disabled}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {t('chat.attach.open')}
        </Button>
      </div>
      {open ? (
        <AttachBrowsePanel client={client} onAddRef={onAddRef} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
