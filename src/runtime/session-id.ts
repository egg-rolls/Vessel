/**
 * 会话 ID 生成（P1 批 2 纯移动，自 bootstrap.ts 迁出；零行为变更）。
 * 独立微模块：bootstrap 主干与 bootstrap-connect 共用，避免二者循环 import。
 */

/**
 * 生成会话 ID
 */
export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
  return `${ts}_${hex}`;
}
