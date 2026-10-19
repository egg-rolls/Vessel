/**
 * ViewTone -> theme token（纯映射）
 * @module @vessel/tui
 */

import { theme } from '../theme.js';
import type { ViewTone } from './types.js';

export function toneColor(tone: ViewTone | undefined): string | undefined {
  switch (tone) {
    case 'ok':
      return theme.ok;
    case 'warn':
      return theme.warn;
    case 'danger':
      return theme.danger;
    case 'info':
      return theme.info;
    case 'brand':
      return theme.brand;
    default:
      return theme.muted;
  }
}
