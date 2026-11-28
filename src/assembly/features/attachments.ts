/**
 * attachments feature（file-ref-ux A2/A3/A4）：附件列举 + 暂存上传 + 预览/过期探针。
 *
 * P2 迁移（ADR-107 第一批，事故模式 feature 之一）：原 cli 网络面与 bootstrap
 * 本地面各手写一份三键 deps；现由本 feature 单点声明，两表面共消费收集结果。
 *
 * 惰性纪律（ADR-107 决策 4）：getConfig 闭包读 ctx.liveConfig.current（活引用）。
 * cli 每次热应用同步写 liveConfigRef.current（cli.ts reloadVesselConfig /
 * config.set 路径），网络面语义与迁移前逐字节一致；本地面 config 源从启动
 * 快照升级为活配置（P0 plugins() 换源同款先例，additive 统一，见验证 kit delta）。
 *
 * 边界：与读文件工具同一份 basic-tools 配置（allowed_roots / deny_paths）；
 * 暂存根已由 buildPathBoundary 追加进允许根。能力注册不涉及（纯 RPC deps）。
 */

import {
  createConfigAttachmentPreviewer,
  createConfigAttachmentStager,
} from '../../data/attachment-staging';
import { createConfigAttachmentLister } from '../../data/attachments-list';
import type { AssemblyFeature } from '../feature';

export const attachmentsFeature: AssemblyFeature = {
  id: 'attachments',
  phase: 'dispatcher',
  register(ctx) {
    const getConfig = () => ctx.liveConfig.current;
    return {
      dispatcher: {
        // 0.52：attachments.list 的列举器（节点侧只读目录浏览）。
        listAttachments: createConfigAttachmentLister({ getConfig }),
        // file-ref-ux（A2/A3/A4）：暂存上传 + 预览/过期探针。
        stageAttachment: createConfigAttachmentStager({ getConfig }),
        previewAttachment: createConfigAttachmentPreviewer({ getConfig }),
      },
    };
  },
};
