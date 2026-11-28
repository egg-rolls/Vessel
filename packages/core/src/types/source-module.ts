/**
 * 统一信息源订阅架构 P1（q-sub-unify-p1）：SourceModule 契约叶类型。
 *
 * 与 `env-cadence.ts` 同族的零依赖形状叶：只描述「一个信息源长什么样」，
 * 不含任何实现。实现（file/health/script/agent 四源 facade）在
 * doc-subscription 插件里，经泛型参数引用插件自己的条目/上下文类型，
 * core 不反向依赖插件（设计稿 §3.1）。
 *
 * 四方法契约：resolveTarget（校验归一）/ detect（观察取 rev）/
 * cursor（游标族描述）/ format（变更→通知文案）；delivery 区分
 * ambient（BeforeLlm 环境注入）与 wake（固定推送，P2 起登记使用）。
 */

/** 一次观察的结果：rev 进双游标，material 是源自有事实（诊断/inspect 用）。 */
export interface Observation<TMaterial = unknown> {
  /** 内容指纹 / 活动签名；空串 = 尚无事实（首观基线语义由消费方定）。 */
  rev: string;
  /** 源自有观察事实（文件 size/mtime、健康快照、活动快照等）。 */
  material: TMaterial;
}

/**
 * 游标族描述（元数据，registry 不解释）：现态三源 + agent 均为
 * 双游标（notified_rev / seen_rev）上的字符串 rev；kind 说明 rev 的形状来源。
 */
export interface CursorSpec {
  kind: 'content-hash' | 'signature' | 'stdout-hash' | 'count' | 'offset' | 'flag';
  /** rev 哨兵值（诊断用；如健康源 '' / '-'）。 */
  sentinels?: readonly string[];
}

/** 通知预算（镜像现态 notice 常量；format 不得超出）。 */
export interface NoticeBudget {
  maxLines: number;
  maxDetails: number;
}

/** format 产物：scope 词 + 文案（裸 scope 前缀，无方括号——方括号属固定推送）。 */
export interface NoticePayload {
  scope: string;
  content: string;
}

/** resolveTarget 结果：合法 ⇒ 键空间键 + 归一目标；非法 ⇒ 错误码（工具面文案用）。 */
export type TargetResolution =
  | { ok: true; key: string; target: string }
  | { ok: false; error: string };

/**
 * 信息源契约（设计稿 §3.1 草图落地）。TEntry / TContext 由实现方注入
 * （插件的 SubscriptionEntry / BeforeLlmHookDeps），core 保持零依赖。
 */
export interface SourceModule<TEntry = unknown, TContext = unknown> {
  /** 源词（scope 词表登记值，★D5：agent 源统一 'agent'）。 */
  readonly source: string;
  /** 输入校验 + 归一 → 键空间键（同步或异步均可）。 */
  resolveTarget(input: string, ctx: TContext): TargetResolution | Promise<TargetResolution>;
  /** 观察一次；undefined = 本轮无事实可报（门控/降级）。 */
  detect(entry: TEntry, ctx: TContext): Promise<Observation | undefined>;
  /** 游标族描述。 */
  readonly cursor: CursorSpec;
  /** 变更列表 → 通知文案（预算内）。 */
  format(changes: readonly string[], budget: NoticeBudget): NoticePayload;
  /** 投递族：ambient = 环境注入；wake = 固定推送（P2 起）。 */
  readonly delivery: 'ambient' | 'wake';
}
