/**
 * 圆形头像（首字母 / 头像图）。
 *
 * 图优先、首字母兜底：`avatarUrl` 来自汇总接口（可选字段），缺字段或加载失败就退回
 * 首字母 —— 头像永不留空白圆圈。装饰性图形，语义一律由外层 `aria-label` 承载，
 * 所以这里 `aria-hidden`。
 *
 * @module web/domains/auth/AccountAvatar
 */

import { useState } from 'react';
import { cn } from '../../components/ui';
import { avatarInitial } from './avatar-initial';

export type AvatarSize = 'trigger' | 'identity';

const SIZE_CLASS: Record<AvatarSize, string> = {
  // 与头部栏其它圆形控件同尺寸（36px）。
  trigger: 'size-9',
  identity: 'size-10',
};

const INITIAL_CLASS: Record<AvatarSize, string> = {
  trigger: 'text-sm',
  identity: 'text-base',
};

export function AccountAvatar({
  name,
  avatarUrl = null,
  size = 'trigger',
  muted = false,
}: {
  name: string | null;
  avatarUrl?: string | null;
  size?: AvatarSize;
  /** 未登录 / 身份未知：用中性底色，别用强调色冒充「有身份」。 */
  muted?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const showImage = avatarUrl !== null && avatarUrl !== '' && !broken;
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center justify-center overflow-hidden rounded-full font-mono font-medium select-none',
        SIZE_CLASS[size],
        muted ? 'bg-sunken text-muted' : 'bg-accent-soft text-accent-ink',
      )}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-full object-cover"
          onError={() => {
            setBroken(true);
          }}
        />
      ) : (
        <span className={INITIAL_CLASS[size]}>{avatarInitial(name)}</span>
      )}
    </span>
  );
}
