/**
 * 「引用文件」入口（0.52）：工具栏左侧的宿主按钮 —— **唯一入口**，点开
 * `AttachDialog`（浏览目录 / 粘贴路径两个 tab）。
 *
 * 为什么是「浏览 + 粘贴」而不是文件选择框：浏览器的文件选择对话框只给 `File` 对象，
 * 拿不到本地绝对路径（`File.path` 是 Electron 私有扩展，`webkitRelativePath` 只有
 * 相对目录名），而 `Message.refs` 只带路径、正文由 agent 用 `read` 按需取。所以
 * 这一版入口只产出路径 → 既有 `addRef` 落草稿槽；**不读文件内容、不上传、不新增 RPC**。
 *
 * 会话 `Composer` 与团队 `TeamComposer` 共用这一份：两个页面都经 `ComposerField`
 * 挂载，差异只在谁提供草稿槽（`addRef`）与哪个节点客户端（`listAttachments`）。
 *
 * 键盘：按钮是普通 tab stop，Enter / Space 打开弹层；弹层内的键盘语义
 * （焦点圈 / Esc / 归还焦点 / Ctrl+⌘+Enter 添加）由 `AttachDialog` 承担。
 */
import type { RefObject } from 'react';
import { Button, cn, Icon } from '../../components/ui';
import type { MessageRef } from '../../gateway/types';
import { t } from '../../i18n';
import type { AttachBrowseClient } from './AttachDialog';
import { composerIconControlClass, composerQuietIconTone } from './composer-controls';

/** 工具栏按钮的可访问名（宿主按钮与插件同名条目共用一句文案）。 */
export function composerAttachLabel(): string {
  return t('composer.attach.label');
}

/**
 * 工具栏左侧的宿主按钮：图标 + `aria-label`（没有可见文字），点击开关弹层。
 *
 * 外观与发送键同族：同一个 32px 正圆盒子（`composerIconControlClass`，与发送键
 * 共用一份 class），只是色调走「次要动作」—— 静止灰色图标（`--muted`），
 * hover 转 `--ink`（暗色主题即白、浅色主题即最深的 ink），不借主题色。
 *
 * 图标给 14px（`Icon size`）：两个按钮的盒子一样、viewBox 也一样（16），但回形针
 * 在视框里画得比纸飞机满 —— 路径包围盒 y 1.79–14.17 / x 2.63–15.01 ≈ 12.4 见方，
 * 纸飞机 2.5–13.5 = 11 见方，同尺寸下回形针的墨迹面积大 ~11%，看起来「更大」。
 * 按包围盒反比缩一档：16 × 11 / 12.4 ≈ 14.2 → 取 14，实际墨迹 12.4 × 14/16 ≈ 10.8，
 * 与纸飞机的 11 基本同占地（差 <2%，肉眼不辨）；描边 1.5 用户单位随盒子缩到
 * 约 1.31px，顺带让次要动作的笔画比主动作略轻 —— 这正是主次该有的差。
 *
 * `aria-haspopup="dialog"` + `aria-expanded` + `aria-controls` 指向同一个弹层；
 * 插件贡献 `attach-file` 时走的是同一份开关回调（见 `composer-toolbar.ts`），
 * 所以两个按钮不会各开一个弹层。
 */
export function ComposerAttachButton({
  open,
  dialogId,
  onClick,
  anchorRef,
}: {
  open: boolean;
  /** 弹层的 DOM id（`aria-controls`）。 */
  dialogId: string;
  onClick: () => void;
  /**
   * 外层的锚点 ref：收起弹层后把焦点还给按钮（键盘用户不丢位置）。
   *
   * 不把 ref 直接传给 `Button`：`Button` 来自 plugin-ui（根 workspace 的
   * @types/react 副本），而这里用的是 apps/web 自己的那份，两份 `Ref` 类型不可互换
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
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={onClick}
        className={cn(composerIconControlClass, composerQuietIconTone)}
      >
        <Icon name="attach" size={14} />
      </Button>
    </span>
  );
}

/**
 * 「引用文件」入口的接线（两个 composer 各喂自己的草稿槽与节点客户端）。
 *
 * 字段容器只认这三样：弹层从哪个节点列目录、怎么加一条引用、现在已有几条 ——
 * 具体写到哪个草稿槽（会话 `chat:<id>` / 团队 `team:<node>:<teamId>`）留在页面里。
 */
export interface ComposerAttachBinding {
  /** 目录浏览的数据源（`attachments.list`；旧 gateway 缺它时浏览 tab 降级成提示）。 */
  client: AttachBrowseClient;
  /** 把一条引用加进待发送引用（现有 `addRef`；返回是否写入成功）。 */
  onAddRef: (ref: MessageRef) => boolean;
  /** 该草稿槽当前已有的引用条数（粘贴的逐行上限判定与「已引用 N/32」）。 */
  refCount: number;
}

/**
 * 页面侧接线：缺客户端或 `addRef` 时返回 `undefined`（工具栏不出点了没反应的死按钮）。
 *
 * 会话页与团队页都只是把自己的草稿槽 `addRef` 与节点客户端递进来，不各自拼一份形状。
 */
export function composerAttachBinding({
  client,
  onAddRef,
  refCount,
}: {
  client?: AttachBrowseClient;
  onAddRef?: (ref: MessageRef) => boolean;
  refCount: number;
}): ComposerAttachBinding | undefined {
  if (client === undefined || onAddRef === undefined) return undefined;
  return { client, onAddRef, refCount };
}
