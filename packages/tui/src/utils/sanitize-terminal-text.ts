/**
 * 终端控制序列清洗——纯函数
 * @module @vessel-agent/tui
 *
 * bash / 工具输出可能带 ANSI 颜色、OSC 标题、光标移动等控制序列；
 * Ink 直接渲染会破坏行布局。展示层统一先清洗（core/tool 的原始返回值不变）。
 *
 * 规则：
 * - 去除 CSI（`ESC [` / C1 `0x9b`）与 OSC（`ESC ]` / C1 `0x9d`，到 BEL 或 ST）；
 * - 去除其它 ESC 转义序列、C0 控制字符（保留 `\n`、`\t`）与 DEL/C1；
 * - `\r\n` 与单独的 `\r` 归一化为 `\n`。
 */

const C1_CSI = 0x9b;
const C1_OSC = 0x9d;

/** CSI：跳过参数字节（0x30-0x3f）、中间字节（0x20-0x2f），消费最后一个终结字节 */
function skipCsi(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if (code >= 0x20 && code <= 0x3f) {
      index++;
      continue;
    }
    // 遇到换行等非法字节：不吞掉，交给后续控制字符过滤。
    return index;
  }
  return index;
}

/** OSC：跳过到 BEL 或 ST（`ESC \`）；无终结符时消费到末尾 */
function skipOsc(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x07) return index + 1;
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2;
    // OSC 内部出现其它 ESC：按协议视为非法，停止吞并让后续过滤处理。
    if (code === 0x1b) return index;
    index++;
  }
  return index;
}

/** 纯函数：清掉终端控制序列，保留换行与制表符 */
export function sanitizeTerminalText(text: string): string {
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let output = '';
  let index = 0;

  while (index < normalized.length) {
    const code = normalized.charCodeAt(index);

    if (code === 0x1b) {
      const next = normalized.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = skipCsi(normalized, index + 2);
        continue;
      }
      if (next === 0x5d) {
        index = skipOsc(normalized, index + 2);
        continue;
      }
      // 其它 ESC 序列：ESC + 可选中间字节 + 一个终结字节。
      index++;
      while (index < normalized.length) {
        const body = normalized.charCodeAt(index);
        if (body >= 0x20 && body <= 0x2f) {
          index++;
          continue;
        }
        break;
      }
      if (index < normalized.length) {
        const final = normalized.charCodeAt(index);
        if (final >= 0x30 && final <= 0x7e) index++;
      }
      continue;
    }

    if (code === C1_CSI) {
      index = skipCsi(normalized, index + 1);
      continue;
    }
    if (code === C1_OSC) {
      index = skipOsc(normalized, index + 1);
      continue;
    }

    // 保留换行与制表符；其余 C0 / DEL / C1 一律丢弃。
    if (code === 0x0a || code === 0x09) {
      output += normalized[index];
      index++;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index++;
      continue;
    }

    output += normalized[index];
    index++;
  }

  return output;
}
