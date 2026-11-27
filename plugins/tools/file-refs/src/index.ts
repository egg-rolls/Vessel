/**
 * file-refs 插件的 node 侧（最小 in-process 面）。
 *
 * 引用 UX 的主体在 web embed（composer 接缝：refs / drop / link 槽）；
 * 暂存上传 / 预览是宿主 attachments 域的通用能力（attachments.stage /
 * attachments.preview），不在本插件注册 RPC。node 侧只保留一个空安装面，
 * 让插件经既有声明式加载机制被发现 / 开关 / 删除（A7/A9）。
 *
 * `[refs]` 尾注 hook 留在宿主（refs 数据链路红线：addRef / runs.start 闸门不变）。
 */

import type { Plugin } from '@vessel-agent/core';

export const fileRefsPlugin: Plugin = {
  name: 'file-refs',
  version: '2.1.23',
  description:
    'File reference UX (composer embed contributions; staging via host attachments domain)',
  install() {
    // 无 node 侧工具 / hook：UX 全部经 contributes.composer 声明式贡献。
  },
};

export default fileRefsPlugin;
