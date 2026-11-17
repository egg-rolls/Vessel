/**
 * 0.56：「已登录为 X」+ 登出，挂在 AppBar 右侧。
 *
 * 没有会话时什么都不渲染，所以没配 auth.backends 的部署永远不会出现死按钮。
 *
 * @module web/auth/SessionChip
 */

import { t } from '../i18n';
import { useAuth } from './AuthProvider';

export function SessionChip() {
  const { phase, user, logout } = useAuth();
  if (phase !== 'authenticated' || user === null) return null;
  const name = user.username !== null && user.username !== '' ? user.username : user.id;
  return (
    <div className="flex flex-none items-center gap-2 max-compact:gap-1">
      <span
        className="whitespace-nowrap text-xs text-muted max-compact:hidden"
        title={t('auth.signedInAsTitle', { user: name })}
      >
        {t('auth.signedInAs', { user: name })}
      </span>
      <button
        type="button"
        className="whitespace-nowrap rounded-full bg-transparent px-2.5 py-1 text-xs text-muted transition-colors duration-150 hover:bg-hover hover:text-ink pointer-coarse:min-h-touch"
        onClick={() => {
          void logout();
        }}
      >
        {t('auth.logout')}
      </button>
    </div>
  );
}
