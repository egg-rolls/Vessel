/**
 * file-refs embed 入口（plugin-embed 契约 §10）：具名导出 composer 贡献。
 *
 * - FileRefCard：refs 槽（输入框内原子卡片渲染器，scheme vessel-ref）；
 * - onFilesDropped：drop 槽（OS 文件 / 截图粘贴 → 上传暂存 → 指针位置插卡）；
 * - FileRefLinkCard：link 槽（消息 vessel-ref 链接 → 只读卡片）。
 *
 * 数据走宿主通用 attachments 能力（host.attachments / ComposerEditorPort），
 * 插件自身不注册 RPC；开关 / 删除 ⇒ 贡献随声明式加载机制撤离（A9）。
 */

import './embed.css';

export { onFilesDropped } from './drop-handler';
export { FileRefCard } from './FileRefCard';
export { FileRefLinkCard } from './FileRefLinkCard';
