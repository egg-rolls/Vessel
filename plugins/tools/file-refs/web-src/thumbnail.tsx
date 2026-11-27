/**
 * 缩略图（A4）：preview RPC 返回原样字节 data URL，web 侧 canvas 缩到 ≤40×40。
 * node 侧无图像编解码依赖（零新增 deps）；缩放发生在浏览器（诚实降级：
 * 解码失败 / 非图片 ⇒ 回落种类 ICON）。
 */

const MAX_THUMB = 40;

/** data URL → ≤40×40 webp 缩略图 data URL；失败返回 undefined（回落 ICON）。 */
export async function makeThumbnail(dataUrl: string): Promise<string | undefined> {
  try {
    const image = new Image();
    image.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('image decode failed'));
    });
    image.src = dataUrl;
    await loaded;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width === 0 || height === 0) return undefined;
    const scale = Math.min(MAX_THUMB / width, MAX_THUMB / height, 1);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return undefined;
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    return canvas.toDataURL('image/webp', 0.8);
  } catch {
    return undefined;
  }
}
