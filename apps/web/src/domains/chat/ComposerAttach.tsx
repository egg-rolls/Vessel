/**
 * 「引用文件」入口（0.52）：工具栏左侧的宿主按钮 + 粘贴路径 popover。
 *
 * 为什么是粘贴路径（而不是文件选择框）：浏览器的文件选择对话框只给 `File` 对象，
 * 拿不到本地绝对路径（`File.path` 是 Electron 私有扩展，`webkitRelativePath` 只有
 * 相对目录名），而 `Message.refs` 只带路径、正文由 agent 用 `read` 按需取。所以这一版
 * 入口**只接粘贴 / 手输**：一行一个绝对路径 → 既有 `addRef` 落草稿槽。
 * **不读文件内容、不上传、不新增 RPC。**
 *
 * 会话 `Composer` 与团队 `TeamComposer` 共用这一份：两个页面都经 `ComposerField` 挂载，
 * 差异只在谁提供 `addPath`（各自的草稿槽）。
 *
 * 键盘：textarea 里裸 Enter / Shift+Enter 换行（一行一个路径），Ctrl/Cmd+Enter = 添加，
 * Esc = 取消。输入框自己的 Enter 发送完全不受影响 —— 两个 textarea 是不同元素，
 * 这里也不往 document 上挂监听。
 */
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { Button, Icon, Textarea } from '../../components/ui';
import { t } from '../../i18n';
import { MAX_COMPOSER_REFS } from '../../stores/composerDraftStore';
import { ATTACH_PATH_MAX, type AttachPathIssue, planAttachPaths } from './attach-paths';

/** 工具栏按钮的可访问名（宿主按钮与插件同名条目共用一句文案）。 */
export function composerAttachLabel(): string {
  return t('composer.attach.label');
}

/**
 * 工具栏左侧的宿主按钮：图标 + `aria-label`（没有可见文字），点击开关 popover。
 *
 * `aria-expanded` / `aria-controls` 指向同一个 popover；插件贡献 `attach-file`
 * 时走的是同一份开关回调（见 `composer-toolbar.ts`），所以两个按钮不会各开一个。
 */
export function ComposerAttachButton({
  open,
  popoverId,
  onClick,
  anchorRef,
}: {
  open: boolean;
  /** popover 的 DOM id（`aria-controls`）。 */
  popoverId: string;
  onClick: () => void;
  /**
   * 外层的锚点 ref：收起 popover 后把焦点还给按钮（键盘用户不丢位置）。
   *
   * 不把 ref 直接传给 ： 来自 plugin-ui（根 workspace 的
   * @types/react 副本），而这里用的是 apps/web 自己的那份，两份  类型不可互换
   * （TS2322）。包一层 span 拿 ref 再找里面的 button，是代价最小的写法。
   */
  anchorRef?: RefObject<HTMLSpanElement | null>;
}) {
  const label = composerAttachLabel();
  return (
    <span ref={anchorRef} className="inline-flex">
      <Button
        type="button"
        variant="plain"
        size="small"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={onClick}
      >
        <Icon name="attach" />
      </Button>
    </span>
  );
}

/**
 * 「引用文件」入口的接线（两个 composer 各喂自己的草稿槽）。
 *
 * 字段容器只认这两样：怎么加一条路径、现在已有几条 —— 具体写到哪个草稿槽
 * （会话 `chat:<id>` / 团队 `team:<node>:<teamId>`）留在页面里。
 */
export interface ComposerAttachBinding {
  /** 把一条绝对路径加进待发送引用（现有 `addRef`；返回是否写入成功）。 */
  addPath: (path: string) => boolean;
  /** 该草稿槽当前已有的引用条数（上限判定与「已引用 N/32」）。 */
  refCount: number;
}

/** 一行没通过校验的原因 → 人话（行号 + 原因；超长路径不整段回显）。 */
function issueText(issue: AttachPathIssue): string {
  if (issue.reason === 'tooLong') {
    return t('composer.attach.error.tooLong', { line: issue.line, max: ATTACH_PATH_MAX });
  }
  if (issue.reason === 'tooMany') {
    return t('composer.attach.error.tooMany', { line: issue.line, max: MAX_COMPOSER_REFS });
  }
  return t('composer.attach.error.absolute', { line: issue.line, path: issue.path });
}

export interface ComposerAttachPopoverProps {
  /** popover 的 DOM id（触发按钮的 `aria-controls` / 标题锚点）。 */
  id: string;
  /**
   * 加一条路径：调用方包一层现有 `addRef`（形状校验在这里已经做过，返回是否写入成功）。
   * 返回 `false` 只可能是草稿槽满了（32 条），按「超出上限」逐行报。
   */
  addPath: (path: string) => boolean;
  /** 该草稿槽当前已有的引用条数（上限判定与「已引用 N/32」）。 */
  refCount: number;
  /** 整批成功 / 用户取消时收起。 */
  onClose: () => void;
}

/**
 * 粘贴路径 popover：多行 textarea + 添加 / 取消 + 逐行错误。
 *
 * 失败不整批回滚：通过校验的行照常进引用区（chip 立刻出现），没通过的行逐条报
 * 「第 N 行 + 原因」并留在输入框里让人改；一条都没失败才收起 popover。
 */
export function ComposerAttachPopover({
  id,
  addPath,
  refCount,
  onClose,
}: ComposerAttachPopoverProps) {
  const [value, setValue] = useState('');
  const [issues, setIssues] = useState<readonly AttachPathIssue[]>([]);
  const [added, setAdded] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 打开即聚焦输入区（不是 autoFocus 属性：仓库 a11y 规则不允许 autofocus）。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const plan = planAttachPaths(value, refCount);
    const failed: AttachPathIssue[] = [...plan.issues];
    let count = 0;
    for (const row of plan.accepted) {
      if (addPath(row.path)) count += 1;
      else failed.push({ line: row.line, path: row.path, reason: 'tooMany' });
    }
    if (failed.length === 0) {
      onClose();
      return;
    }
    failed.sort((a, b) => a.line - b.line);
    setAdded(count);
    setIssues(failed);
    // 没成功的行留在输入框里，行号随下一次提交重新算（不额外维护映射）。
    setValue(failed.map((issue) => issue.path).join('\n'));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME 组字中的键一律不接管（与两个 composer 的 Enter 处理同一口径）。
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    // 只有显式和弦才是「添加」：裸 Enter 在 textarea 里换行（一行一个路径）。
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      id={id}
      role="dialog"
      aria-label={t('composer.attach.title')}
      className="flex flex-col gap-2 rounded-md border border-line-strong bg-raised p-2.5 shadow-elev-2"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs uppercase tracking-wide text-faint">
          {t('composer.attach.title')}
        </span>
        <span className="flex-none font-mono text-xs text-faint">
          {t('composer.attach.count', { used: refCount, max: MAX_COMPOSER_REFS })}
        </span>
      </div>
      <Textarea
        ref={inputRef}
        rows={3}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setAdded(0);
        }}
        placeholder={t('composer.attach.placeholder')}
        aria-label={t('composer.attach.input')}
        aria-describedby={`${id}-hint`}
        invalid={issues.length > 0}
        spellCheck={false}
        className="resize-none font-mono text-sm"
      />
      <p id={`${id}-hint`} className="m-0 text-xs text-faint">
        {t('composer.attach.hint', { max: MAX_COMPOSER_REFS })}
      </p>
      {added > 0 && (
        <p className="m-0 text-xs text-accent" role="status">
          {t('composer.attach.added', { count: added })}
        </p>
      )}
      {issues.length > 0 && (
        <div className="flex flex-col gap-1" role="alert">
          <p className="m-0 text-xs text-danger">
            {t('composer.attach.rejected', { count: issues.length })}
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {issues.map((issue) => (
              <li
                key={`${issue.line}:${issue.path}`}
                className="break-all font-mono text-xs text-danger"
              >
                {issueText(issue)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="plain" size="small" onClick={onClose}>
          {t('composer.attach.cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="small"
          disabled={value.trim().length === 0}
          onClick={submit}
        >
          {t('composer.attach.add')}
        </Button>
      </div>
    </div>
  );
}
