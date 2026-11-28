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
  'card.preview': 'Enlarge {name}',
  'card.preview-failed': 'Preview unavailable',
  'card.inline': 'Send image with message: {name}',
  'card.copy-path': 'Copy path',
  'card.path-copied': 'Path copied',
  'card.kind.image': 'Image',
  'card.kind.document': 'Document',
  'card.kind.file': 'File',
  'drop.limit': 'Reference limit reached (32)',
  'drop.failed': 'Could not upload {name}',
  'attach.title': 'Add attachment references',
  'attach.tab.upload': 'Upload files',
  'attach.tab.browse': 'Browse folders',
  'attach.tab.paste': 'Paste path',
  'attach.upload.hint':
    'Pick files from this computer; they are uploaded to the node staging area and inserted as reference cards at the caret.',
  'attach.upload.choose': 'Choose files…',
  'attach.crumbs': 'Folder path',
  'attach.roots': 'Allowed roots on the node (paths are resolved there)',
  'attach.up': 'Up',
  'attach.hidden': 'Show hidden entries',
  'attach.dir': 'folder',
  'attach.empty': 'Nothing referenceable in this folder',
  'attach.truncated': 'Showing the first {limit} entries; open a narrower folder for more',
  'attach.selected': 'Selected {count} of {max}',
  'attach.add': 'Add reference',
  'attach.addCount': 'Add {count} references',
  'attach.added': 'Added {count} reference(s)',
  'attach.paste.label': 'Absolute path on the node',
  'attach.paste.hint':
    'The path is resolved on the machine that runs the agent; out-of-bounds paths are rejected when sending.',
  'attach.paste.placeholder': 'One absolute path per line, e.g. /home/me/a.ts or D:\\work\\b.md',
  'attach.paste.input': 'File paths to reference',
  'attach.paste.keys': 'One path per line · Ctrl/⌘+Enter to add · Esc to cancel · at most {max}',
  'attach.count': '{used}/{max} referenced',
  'attach.addedCount': 'Added {count}',
  'attach.rejected': 'These {count} line(s) were not added:',
  'attach.reason.invalid': 'This folder cannot be opened (missing or unreadable)',
  'attach.reason.denied': 'This folder is protected and cannot be browsed',
  'attach.reason.outside': 'This folder is outside the browsable roots',
  'attach.error': 'Failed to read the folder: {message}',
  'attach.unavailable':
    'This gateway version has no folder browsing (attachments.list); paste the path instead',
  'attach.error.absolute': 'Line {line} is not an absolute path: {path}',
  'attach.error.tooLong': 'Line {line} is longer than {max} characters',
  'attach.error.tooMany': 'Line {line} exceeds the limit: at most {max} references per message',
  'attach.close': 'Close',
  'attach.cancel': 'Cancel',
  'attach.loading': 'Loading…',
} as const;

const ZH: Record<keyof typeof EN, string> = {
  'card.temporary': '临时',
  'card.expired': '已过期',
  'card.uploading': '上传中…',
  'card.failed': '上传失败',
  'card.retry': '重试',
  'card.remove': '移除 {name}',
  'card.preview': '放大查看 {name}',
  'card.preview-failed': '预览不可用',
  'card.inline': '随消息发送图像：{name}',
  'card.copy-path': '复制路径',
  'card.path-copied': '路径已复制',
  'card.kind.image': '图片',
  'card.kind.document': '文档',
  'card.kind.file': '文件',
  'drop.limit': '引用已达上限（32 条）',
  'drop.failed': '无法上传 {name}',
  'attach.title': '添加附件引用',
  'attach.tab.upload': '上传文件',
  'attach.tab.browse': '浏览目录',
  'attach.tab.paste': '粘贴路径',
  'attach.upload.hint': '从本机选择文件，上传到 node 暂存区并在光标位插入引用卡片。',
  'attach.upload.choose': '选择文件…',
  'attach.crumbs': '目录路径',
  'attach.roots': 'node 上允许浏览的根（路径按跑 agent 的那台机器解析）',
  'attach.up': '上级',
  'attach.hidden': '显示隐藏项',
  'attach.dir': '目录',
  'attach.empty': '这个目录里没有可引用的条目',
  'attach.truncated': '只显示前 {limit} 项；要看更多请进入更具体的目录',
  'attach.selected': '已选 {count} / {max}',
  'attach.add': '添加引用',
  'attach.addCount': '添加 {count} 个引用',
  'attach.added': '已添加 {count} 个引用',
  'attach.paste.label': 'node 上的绝对路径',
  'attach.paste.hint': '路径按跑 agent 的那台机器解析；越界路径在发送时会被拒。',
  'attach.paste.placeholder': '一行一个绝对路径，例如 /home/me/a.ts 或 D:\\work\\b.md',
  'attach.paste.input': '要引用的文件路径',
  'attach.paste.keys': '一行一个路径 · Ctrl/⌘+Enter 添加 · Esc 取消 · 最多 {max} 条',
  'attach.count': '已引用 {used}/{max}',
  'attach.addedCount': '已添加 {count} 条引用',
  'attach.rejected': '以下 {count} 行没有添加：',
  'attach.reason.invalid': '这个目录打不开（不存在或不可读）',
  'attach.reason.denied': '这个目录属于受保护目录，不能浏览',
  'attach.reason.outside': '这个目录在允许浏览的根之外',
  'attach.error': '读取目录失败：{message}',
  'attach.unavailable': '这个 gateway 版本没有目录浏览（attachments.list），请改用粘贴路径',
  'attach.error.absolute': '第 {line} 行不是绝对路径：{path}',
  'attach.error.tooLong': '第 {line} 行的路径超过 {max} 个字符',
  'attach.error.tooMany': '第 {line} 行超出上限：单条消息最多 {max} 个引用',
  'attach.close': '关闭',
  'attach.cancel': '取消',
  'attach.loading': '加载中…',
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
