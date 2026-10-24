import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并条件 class，并让后出现的 Tailwind utility 覆盖冲突项。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
