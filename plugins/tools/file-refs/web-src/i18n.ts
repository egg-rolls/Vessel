/**
 * file-refs plugin copy. English is the fallback; host lang starting with `zh`
 * selects the Chinese table. Nav / badge titles live in manifest contributes.i18n
 * (host surface); embed-internal copy lives here.
 */

export type Lang = 'en' | 'zh-CN';

type Vars = Record<string, string | number>;

const EN = {
  'card.temporary': 'temp',
  'card.expired': 'expired',
  'card.uploading': 'Uploading…',
  'card.failed': 'Upload failed',
  'card.retry': 'Retry',
  'card.remove': 'Remove {name}',
  'card.copy-path': 'Copy path',
  'card.path-copied': 'Path copied',
  'card.kind.image': 'Image',
  'card.kind.document': 'Document',
  'card.kind.file': 'File',
  'drop.limit': 'Reference limit reached (32)',
  'drop.failed': 'Could not upload {name}',
} as const;

const ZH: Record<keyof typeof EN, string> = {
  'card.temporary': '临时',
  'card.expired': '已过期',
  'card.uploading': '上传中…',
  'card.failed': '上传失败',
  'card.retry': '重试',
  'card.remove': '移除 {name}',
  'card.copy-path': '复制路径',
  'card.path-copied': '路径已复制',
  'card.kind.image': '图片',
  'card.kind.document': '文档',
  'card.kind.file': '文件',
  'drop.limit': '引用已达上限（32 条）',
  'drop.failed': '无法上传 {name}',
};

export type CopyKey = keyof typeof EN;

export function translator(lang: string): (key: CopyKey, vars?: Vars) => string {
  const table = lang.startsWith('zh') ? ZH : EN;
  return (key, vars) => {
    let text: string = table[key] ?? EN[key] ?? key;
    if (vars !== undefined) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}
