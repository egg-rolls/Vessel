/**
 * 引用路径长度闸（发送侧）。
 *
 * file-ref P3 D4：形状校验（planAttachPaths）已迁入 file-refs 插件
 * （粘贴 / 浏览入口归插件，UX 面可插件 / 数据面归宿主）；宿主只留发送闸
 * 用的单条路径字符上限（与 core MESSAGE_REF_PATH_MAX / addRef 同口径）。
 */

/** 单条引用路径字符上限（useChatSubmit 发送闸消费）。 */
export const ATTACH_PATH_MAX = 4096;
