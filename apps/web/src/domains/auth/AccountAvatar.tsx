/**
 * 圆形头像：真头像 → 同源端点 → 首字母（+ 按身份稳定的渐变底色）。
 *
 * 三层，从下往上：
 * 1. **底色层**：按身份哈希出的渐变（`avatar-palette`），没身份时中性色；
 * 2. **字符层**：首字母 / 双字母，或没有身份时的通用人形。它是**常驻占位** ——
 *    图片加载完成前用户看到的就是它，所以没有 loading 骨架、也不会跳尺寸；
 * 3. **图片层**：`identity.avatarUrl` 与 `GET /auth/avatar` 依次尝试。`onLoad` 之后才
 *    淡入（时长用 `--motion-base`）；`onError`（404 / 网络错 / 不是图片）就换下一个候选，
 *    全失败就停在字符层。全程**不报错、不弹提示、不留 loading 态**。
 *
 * 候选顺序由 `avatar-source` 决定；一旦有图加载成功，后续候选列表变化（例如浮层打开后
 * 汇总接口才带回 `avatarUrl`）**不会**把已经显示的图换掉 —— 除非身份本身变了。
 *
 * 装饰性图形：语义由外层 `aria-label` 承载（头部按钮、身份区的名字），所以整块
 * `aria-hidden`；`<img>` 上仍按契约写 `alt` = 登录名。
 *
 * @module web/domains/auth/AccountAvatar
 */

import { useState } from 'react';
import { cn } from '../../components/ui';
import { avatarMonogram } from './avatar-initial';
import { avatarPalette } from './avatar-palette';
import { avatarCandidates } from './avatar-source';

export type AvatarSize = 'trigger' | 'identity';

const SIZE_CLASS: Record<AvatarSize, string> = {
  // 与头部栏其它圆形控件同尺寸（36px）；浮层身份区大一档。
  trigger: 'size-9',
  identity: 'size-10',
};

const MONOGRAM_CLASS: Record<AvatarSize, string> = {
  trigger: 'text-sm',
  identity: 'text-base',
};

/** 通用人形：没有 name 也没有 id 时的兜底图形（16 单位网格，与 `components/ui/Icon` 同一套画法）。 */
const GLYPH_SIZE: Record<AvatarSize, number> = { trigger: 18, identity: 20 };

const EMPTY_FAILED: ReadonlySet<string> = new Set();

function PersonGlyph({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className="flex-none"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.75 14c0-2.9 2.35-4.75 5.25-4.75s5.25 1.85 5.25 4.75" />
    </svg>
  );
}

export function AccountAvatar({
  name,
  id = null,
  avatarUrl = null,
  endpoint = false,
  size = 'trigger',
}: {
  /** 显示名（没有就用 id 算字符 / 底色）。 */
  name: string | null;
  /** 身份 id：字符与底色的稳定哈希都先认它。 */
  id?: string | null;
  /** 契约里的 `identity.avatarUrl`（可为缺）。 */
  avatarUrl?: string | null;
  /** 登录态才问 `/auth/avatar`：未登录时它必定 404，没必要发这一枪。 */
  endpoint?: boolean;
  size?: AvatarSize;
}) {
  const monogram = avatarMonogram(name, id);
  const palette = avatarPalette(id, name);
  const candidates = avatarCandidates({ avatarUrl, endpoint });
  const altName = (name ?? '').trim() || (id ?? '').trim();

  /**
   * 身份一换就重来：否则会拿上一张图 / 上一次失败记录接着用（换账号后头像不更新，
   * 或者明明有图却停在首字母）。
   */
  const identityKey = `${id ?? ''}\u0000${name ?? ''}`;
  const [trackedIdentity, setTrackedIdentity] = useState(identityKey);
  const [failed, setFailed] = useState<ReadonlySet<string>>(EMPTY_FAILED);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  if (trackedIdentity !== identityKey) {
    setTrackedIdentity(identityKey);
    setFailed(EMPTY_FAILED);
    setLoadedSrc(null);
  }

  /**
   * 已经加载成功的图优先级最高（只要它还在候选里）：浮层打开后汇总接口带回
   * `avatarUrl` 时，头部的图不该当着用户的面重来一次。
   */
  const preferred =
    loadedSrc !== null && candidates.includes(loadedSrc) && !failed.has(loadedSrc)
      ? loadedSrc
      : null;
  const src = preferred ?? candidates.find((candidate) => !failed.has(candidate)) ?? null;
  const shown = src !== null && loadedSrc === src;

  return (
    <span
      className={cn(
        'relative inline-flex flex-none items-center justify-center overflow-hidden rounded-full font-mono font-medium select-none',
        SIZE_CLASS[size],
        // 渐变上的字符色跟着主题翻转（亮色主题=白字、暗色主题≈黑字），见 avatar-palette 的头注释。
        palette === null ? 'bg-sunken text-muted' : 'text-surface',
      )}
      style={
        palette === null
          ? undefined
          : { backgroundColor: palette.solid, backgroundImage: palette.backgroundImage }
      }
      aria-hidden="true"
    >
      {monogram === null ? (
        <PersonGlyph size={GLYPH_SIZE[size]} />
      ) : (
        <span className={MONOGRAM_CLASS[size]}>{monogram}</span>
      )}
      {src !== null && (
        <img
          key={src}
          src={src}
          alt={altName}
          // 头像是第三方 CDN 的常态：不把本站地址带给对方。
          referrerPolicy="no-referrer"
          decoding="async"
          className={cn(
            'absolute inset-0 size-full object-cover transition-opacity duration-[var(--motion-base)] ease-[var(--ease)]',
            shown ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => {
            setLoadedSrc(src);
          }}
          onError={() => {
            setFailed((previous) => {
              const next = new Set(previous);
              next.add(src);
              return next;
            });
          }}
        />
      )}
    </span>
  );
}
