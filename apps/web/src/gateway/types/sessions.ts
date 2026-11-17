/** 会话摘要（/v1/sessions 返回的 SessionInfo） */
export interface SessionInfo {
  session_id: string;
  title: string;
  preview: string;
  status: string;
  started_at: number;
  updated_at: number;
  message_count: number;
  branch?: string;
  /**
   * Additive (title_source)：标题来源。`manual` = 人显式命名过（自动命名不会覆盖）；
   * `generated` = AI 命名；缺失 = 旧 gateway / 旧数据 / 尚未命名。
   */
  title_source?: 'manual' | 'generated';
  /**
   * Additive (0.52)：会话归属。老 gateway 不返回 ⇒ 前端回落到 roster 反查
   * （`sessionAgentLabels` / `sessionAgentRetiredLabels`）。
   * `primary: false` 表示这是已退役 body 的会话（rotate 之前那具身体）。
   */
  agent?: {
    id: string;
    name?: string;
    /** 成员状态原值；`closed` = 已停用（会话默认归档，由「显示归档」开关决定是否列出）。 */
    state: string;
    presence?: 'live' | 'gone';
    primary: boolean;
  };
}

/** 会话消息角色（与 core `Message` 对齐） */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 引用种类（附件引用；与 core `MessageRefKind` 对齐） */
export type MessageRefKind = 'file' | 'image' | 'document';

/**
 * 附件引用（与 core `MessageRef` 对齐）：**只有路径与元信息，没有正文**。
 *
 * `mime` / `bytes` 是前端探测值（不可信），只用于展示；`path` 是宿主机绝对路径，
 * 渲染层只显示、不解析、不读取。
 */
export interface MessageRef {
  kind: MessageRefKind;
  path: string;
  name?: string;
  mime?: string;
  bytes?: number;
  /**
   * 内容地址（additive 0.56）：`<dataDir>/blobs/sha256/xx/<sha256>` 的文件名。
   * 只用于「这张图有没有真的发出去」的对账（wire 上的 `image_delivery[].sha8`）；
   * 前端不读文件、不拼 URL。
   */
  sha256?: string;
}

/**
 * 一张图的投递状态（additive 0.56，`Message.image_delivery` 的一项）。
 *
 * **服务端从事件派生**（`image.sent` / `context.image_dropped`），不是 `refs` 上的字段 ——
 * 所以刷新页面后仍然正确（前端不得把它存成本地状态）。
 *
 * 三态：`sent`（含 provider 名与每图 token）/ `dropped`（这一轮算过、决定不发）/
 * `not_sent`（根本没进这条通路：视觉被关 / 模型无视觉 / 没入池）。
 */
export interface ImageDelivery {
  status: 'sent' | 'dropped' | 'not_sent';
  /** 稳定短标签（`over per-request budget` / `vision_disabled` …）。 */
  reason?: string;
  /** 内容身份前 8 位。 */
  sha8?: string;
  /** `sent` 时每图的 token 数（后端 `tokenCost(1)`，不是字符数）。 */
  tokens?: number;
  /** `sent` 时用的后端 id。 */
  backend?: string;
  /** `sent` 时实际发给的模型（隐私知情：这一张去了哪家）。 */
  model?: string;
}

/** 工具调用（assistant 消息里的 tool_calls） */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 上下文投影模式（0.54 投影卡）：**照抄 ADR-104 §2.2 的闭集**，客户端不自创枚举。
 *
 * - `passthrough`：逐字一致（没被投射）—— wire 上根本不发 `projection`；
 * - `placeholder`：正文被换成占位符（`[cleared …]`），消费 C1h 豁免；
 * - `externalize`：正文被换成句柄引用（同为「消费披露」类）；
 * - `archive_notice`：卡本身不替换正文，原文靠读回（批量清单卡形态）。
 */
export type ProjectionMode = 'passthrough' | 'placeholder' | 'externalize' | 'archive_notice';

/** 原文现在在哪（决定默认视角，见 `domains/chat/projection.ts`）。 */
export type ProjectionOriginalAvailability = 'inline' | 'inline_truncated' | 'readback' | 'gone';

/**
 * 一条工具消息的「模型看到的是什么」（additive `sessions.get.session.messages[i].projection`）。
 *
 * 服务端派生 + **sparse**：没被投影的消息**不带**这个键，与 0.54 之前逐字节相同。
 * 与 `system_context` 同一层（wire-only 派生），core 的 `SessionState` 不认识它。
 *
 * 三条不可违反的读取纪律（排查成本最高的一类 bug 都长在这里）：
 * 1. **按 `tool_call_id` 合并**，不按数组下标 —— 消息窗口可能从 assistant 中间切起；
 * 2. `placeholder_text` 是**模型真正看到的那一字节**，只展示、**禁止** trim / 补空格 /
 *    重排换行 / 本地化（UI 复刻 formatter 就是这个字段存在的原因）；
 * 3. 体量只读 `original_bytes`（wire 给的），**禁止**从正文 parse 行数 / exit code ——
 *    正文本身超过 8 KiB 时尾部会被裁掉，parse 出来的数字是错的。
 */
export interface ProjectionView {
  mode: ProjectionMode;
  /** 与 `messages[i].tool_call_id` 相同：合并 / 汇总的唯一键。 */
  tool_call_id: string;
  /** core 渲染好的占位文本（逐字：不 trim / 不补空格 / 不重排换行）。 */
  placeholder_text: string;
  /** `placeholder_text` 的稳定摘要（sha256 前 16 位）：与实时卡去重时用。 */
  placeholder_hash: string;
  /** 原始正文的 UTF-8 字节数；**`null` = 服务端也不知道**（不是 0）。 */
  original_bytes: number | null;
  /** 原始正文的行数；同上。 */
  original_lines: number | null;
  original_available: ProjectionOriginalAvailability;
  /**
   * 跨源读回句柄（可判别联合，UI 不猜来源）。
   *
   * `kind:'events'` 的 `since_seq` 就是 `sessions.events` 的同名参数（**排他**游标：只回
   * `seq > since_seq`）；`0` = 从日志头按 `tool_call_id` 找，**不是**「没有这一段」。
   *
   * `kind:'file'` / `kind:'handle'` 的读回动作还没接线：卡只展示「原文不在这里」，
   * 不乱猜来源、也不假装读得到。
   */
  readback?:
    | { kind: 'events'; tool_call_id: string; since_seq: number }
    | { kind: 'file'; path: string; offset?: number; length?: number }
    | { kind: 'handle'; handle_id: string };
  /** 冻结集合的来源事件 `seq`（审计锚点）。**缺省 = 不知道**（服务端不写 0 冒充「从日志头起」）。 */
  since_event_seq?: number;
  /** ADR-104 D4 的声明 id；没有声明 = `null`。 */
  declaration_id: string | null;
}

/**
 * 整会话的投影汇总（additive `sessions.get.session.projection_summary`）。
 *
 * **口径 = 整个会话当前态，不是当前分页窗口**，所以它跟卡片上的单条投影不是同一个数：
 * 「这一条」看 `projection`，「这个会话一共」看这里（展示纪律见 spec §3.0：折叠态只讲
 * 本轮变化量，累计数只在展开体里出现）。
 */
export interface ProjectionSummary {
  /** 被投影的条数。 */
  total: number;
  /**
   * `Σ(original_bytes − 占位字节)` 的**净值**，**可以为负**（原文比占位还短的小结果真的存在）。
   *
   * 服务端不 clamp；展示「省了多少」时由 `domains/chat/projection.ts#savedBytesOf` 自己 clamp。
   * 只累加体量已知的条目 ⇒ `unknown_original_count > 0` 时它是**下界**。
   */
  bytes_saved: number;
  /** 每个 mode 各有几条（闭集；没出现的 mode 不登记）。 */
  modes: Partial<Record<ProjectionMode, number>>;
  /** `original_bytes === null` 的条数（= `bytes_saved` 少算了几条）。 */
  unknown_original_count: number;
}

/** 一个被裁字段的结构化裁断事实（wire `CappedFieldInfo` 的客户端形状）。 */
export interface TruncatedFieldInfo {
  /** 完整字段的 UTF-8 字节数（**截断前**）。 */
  bytes: number;
  /** 本次生效的上限（UTF-8 字节）—— 界面上「已截到前 N」这个数字只能用它。 */
  limit: number;
  /** 拼进正文的截断标记（逐字）。 */
  marker: string;
}

/**
 * 单条消息上的裁断事实（additive 0.54 `Message.truncated`）。
 *
 * **sparse**：没被裁的消息不带这个字段；被裁时才出现。
 */
export interface MessageTruncation {
  /** 工具结果正文被裁（`role==='tool'`）。 */
  content?: TruncatedFieldInfo;
  /** assistant 工具入参被裁（`bytes` 取被裁 call 里的最大值）。 */
  arguments?: TruncatedFieldInfo;
  /** `arguments` 是多个 call 的合并值时才出现：被裁的 call 数（≥2）。 */
  arguments_calls?: number;
}

/** 单条会话消息（sessions.get 返回的 session.messages） */
export interface Message {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * 思维链（thinking 模式）：core 持久化保留、只在展示层用。
   * 历史里同样带着它，所以终止态也能渲染思考块（与运行态同一实现）。
   */
  reasoning_content?: string;
  /** 0.6.1：逐条消息时间戳（core 可能缺省；缺失时 Web 降级为不分组/不显示时间）。 */
  timestamp?: number;
  /**
   * 附件引用（additive）：只有路径 + 元信息，没有正文。
   * 旧 gateway / 旧 session 缺失该字段 → 前端按「无引用」渲染，不迁移。
   */
  refs?: MessageRef[];
  /**
   * 每张图的投递状态（additive 0.56；**sparse**，没有图之后端就不下发）。
   *
   * 与服务端 `sessions.get` 的 `image_delivery` 同形：与 `refs` 里的 image 引用
   * **一一对应**（同序）。**只有历史快照带它** —— 实时流没有这个字段，前端对新消息
   * 显示为「发送中」，刷新后拿到真实三态（状态只从事件派生，不猜）。
   */
  image_delivery?: ImageDelivery[];
  /**
   * 消息身份（additive）：这条消息属于哪个 run。
   *
   * 为什么在 wire 上要它：时间线去重（认领）以前只能拿正文内容当代理键，而落盘前的
   * Output guardrail 会改写正文（PII 打码），于是实时那份（原文）与历史那份（打码后）
   * 内容不等 ⇒ 同一段正文被当成两个对象渲染两遍。身份是结构化事实，内容被怎么改写
   * 都不影响「这是同一段」。
   *
   * **缺失 = 旧数据 / 旧 gateway**：不做回填，客户端退回既有的「内容相等」认领路径。
   */
  run_id?: string;
  /**
   * 消息身份（additive）：同一次 run 内**第几段正文**（0 起，只数非空 assistant 正文）。
   * 与 live 侧 `run-text` 的 `segmentIndex`（流式段序）同口径。
   * **缺失 = 旧数据**：同上，退回内容比较。
   */
  run_segment?: number;
  /**
   * 上下文投影（additive 0.54）：这条工具消息「模型看到的是什么」。
   *
   * **sparse**：没被投影的消息不带这个键（老 gateway / 老会话 = 与 0.54 之前逐字节相同）。
   * 只挂在 `role:'tool'` 消息上；合并 / 汇总一律按 `projection.tool_call_id`，不按下标。
   */
  projection?: ProjectionView;
  /**
   * 裁断事实（additive 0.54）：正文被裁时才有（**sparse**，没被裁就不带）。
   *
   * 投影卡的「已截到前 N」里的 N 必须取这里的 `content.limit` —— 那是本次真正生效的上限，
   * 服务端改上限时界面上的数字跟着变，不许硬编码。
   */
  truncated?: MessageTruncation;
}

/** sessions.search 的单条结果（E5 冻结形状）。 */
export interface SessionSearchHit {
  session_id: string;
  title: string;
  preview: string;
  snippet: string;
  updated_at: number;
  message_count: number;
}

/** 会话详情（sessions.get 返回 `{ session: SessionState + 最近 RunRecord 投影 }`） */
export interface SessionDetail {
  session_id: string;
  /** 本次返回的连续消息窗口（升序）；不传分页参数时是完整的 `state.messages`。 */
  messages: Message[];
  /**
   * 完整 `state.messages.length`（切窗之前）。S1 additive；旧 gateway 缺失时
   * 客户端按「本次 `messages` 就是全量」降级。
   */
  messages_total?: number;
  /**
   * 上一次响应的 `next_before` 游标；`start > 0` 时才有。旧 gateway 缺失时
   * 分页关闭。客户端只透传，不解析游标内容。
   */
  next_before?: string;
  title?: string;
  preview?: string;
  started_at?: number;
  updated_at?: number;
  status?: string;
  /**
   * 最近一次 run 的 id（服务端 `toSessionView` 的 `run_id`：RunRecord 优先，
   * 回退 `state.last_run_id`）。旧 gateway / 伪会话缺失。
   *
   * 与 `status` / `error` / `completed_at` 一起构成「会话级」终态快照：聊天时间线的
   * 失败卡在事件缓冲里已经没有 `run.failed` 时（刷新 / 切会话 / 环形缓冲淘汰）
   * 用它兜底，见 `domains/chat/transcript-items.ts#sessionFailureOfDetail`；
   * **live 状态的收口**（run 组 / 停止按钮 / 「正在思考」）同样靠它兜底，见
   * `sessionTerminalOfDetail` 与 `ItemSink.closeRuns`。
   */
  run_id?: string;
  /** 该 run 的错误原文（成功 / 运行中 / 旧数据缺失）。 */
  error?: string;
  /** 该 run 的终态时刻（终态 status 下等于 `updated_at`）。 */
  completed_at?: number;
  /**
   * 会话级上下文用量（additive `sessions.get.context_usage`）：
   * 服务端从**该会话的事件日志尾窗**派生，历史会话 / rotate 之后 / 进程重启之后
   * 都可用（`agents.tree` 的 `context_used` 只是 live body，重启就没了）。
   *
   * **整字段缺省 = 没有可用数据**（新会话还没跑过），不是 0；`max` 缺省 = 上下文窗口
   * 未知，此时不画比例（`ComposerContextMeter` 的既定口径）。`source` 是自查字段
   * （这个数字来自哪条事件的哪个字段），UI 不消费。旧 gateway 缺失该键。
   */
  context_usage?: {
    used: number;
    max?: number;
    at?: number;
    source?: 'pressure' | 'changed' | 'estimated' | 'prompt' | 'request';
  };
  /**
   * 「模型这一轮看到了什么系统消息」（additive `sessions.get.system_context`）。
   *
   * 服务端从**该会话的事件日志尾窗**派生（`prompt.system_context` 事件，见
   * `src/system-context.ts`），所以刷新 / 重连 / 进程重启之后仍然能拿回来 —— 它不是
   * message（`messages` 里永远没有它），事件回放窗口一淘汰就只剩这一条读路径。
   *
   * **整字段缺省 = 没有可用数据**（没跑过 / 尾部没有该事件 / 旧 gateway 未注入端口）。
   * `system_prompt` 与 `self_card` 至少有一个；`hash` 用来与事件流里那张卡去重
   * （两路都在时只出一张）。只返回**最近一条**：更早轮次的卡在刷新后不会回来。
   */
  system_context?: {
    hash: string;
    system_prompt?: string;
    self_card?: string;
    model?: string;
    message_count?: number;
    tools_count?: number;
    estimated_tokens?: number;
    context_max?: number;
    at?: number;
    run_id?: string;
    /**
     * 与上一份快照差在哪（additive，0.52）。**缺省 = 不知道**（首次快照 / 旧日志），
     * 不是「0 项变更」—— 前者退回全量快照卡，后者才是一句「没有变化」。
     */
    changed?: string[];
    previous_hash?: string;
  };
  /**
   * 整会话的投影汇总（additive 0.54 `sessions.get.session.projection_summary`）。
   *
   * **缺省 = 这个会话没有任何被投影的条目**（服务端只在 `total > 0` 时下发），
   * 不是「省了 0 B」；口径是整个会话当前态，不是当前分页窗口。
   */
  projection_summary?: ProjectionSummary;
}

/** ask 单个问题 */
export interface AskUserQuestion {
  /**
   * 题目标识（additive）：`q1` / `q2` / …，由工具按题序写进请求事件。
   *
   * 旧事件没有该字段 ⇒ 读侧按「下标 + 1」推出同一个值（`questionIdOf`），所以
   * 「这题答了没有」对老数据同样判定得出来。
   */
  id?: string;
  header: string;
  question: string;
  options?: string[];
  multi_select?: boolean;
}

/** ask 单个回答 */
export interface AskUserAnswer {
  /** 这一行挂在哪道题上（additive；不传时服务端按正文 / header / 位置回退）。 */
  question_id?: string;
  header: string;
  question: string;
  answer: string;
  /** 多选的结构化选中项（additive）：答复卡据此渲染 chips，也能判定「选了几项」。 */
  selected?: string[];
}

/** ask 请求（ask.user.requested） */
export interface AskUserRequest {
  requestId: string;
  questions: AskUserQuestion[];
  runId: string;
  /** 事件时间（缺失回退收到时间）；只用于与权限请求混排，不表示过期。 */
  requestedAt: number;
  /** 0.15 additive：由 run.started 反查的归属会话；旧流缺失时不参与跨 session 归类。 */
  sessionId?: string;
  /**
   * 成员 bridge 的父**会话**（事件 `parent_session_id`）；旧事件缺失。
   *
   * 0.51 前这里可能装的是父 **agent** id（0.19 的混用），所以读它之前必须过
   * `resolveParentSession`：能靠 roster 认出它是 agent id 就按 agent 上溯，
   * 见 `domains/pending/attribution.ts`。
   */
  parentSessionId?: string;
  /** 成员 bridge 的父 **agent** id（事件 `parent_agent_id` / `interactions.list`）；0.51 additive。 */
  parentAgentId?: string;
  /** 0.17 additive：发起请求的子 agent（delegate_id / agent_id）；旧流缺失。 */
  agentId?: string;
  /**
   * 成员 bridge 请求所属 Team（`interactions.list` 的 `team_id` / 事件 `team_id`）。
   * 用于「待批」页区分会话面与团队面；旧流缺失时按会话面处理。
   */
  teamId?: string;
  /**
   * 0.52：ask 的语义。`async` = 提问的工具已经返回成功、那个 run 早就结束了，
   * 但这个请求仍然有效：回答会作为一条 user 消息投给该成员并**起一次新 run**。
   *
   * 因此它不跟 run 终态一起消失（卡片必须留在待批页），并显示「异步」标记。
   * 缺省 = sync（阻塞型：应答者就在原地等）。
   */
  mode?: 'sync' | 'async';
  /**
   * 已经答完的题 id（additive，`interactions.list` 的 `answered_questions`）。
   *
   * 分批提交后一条请求可以只答了一部分：剩下的题仍是 pending，卡片要留着，而已经答过的
   * 那几题不该再让人填一遍。旧服务端 / 旧记录没有这个字段 ⇒ 当作「一道都没答」。
   */
  answeredQuestionIds?: string[];
}

/** 权限应答范围（DECISION-024 §2.1）。 */
export type PermissionScope = 'once' | 'session' | 'always';

/**
 * 待答权限请求（tool.permission.request，0.13 增加关联字段）。
 *
 * Addendum A / 0.18：权限等待默认不超时，因此没有过期字段；卡片只保留事件时间用于排序。
 */
export interface PermissionRequest {
  requestId: string;
  tool: string;
  input: unknown;
  runId: string;
  /** run 归属会话；旧 gateway 缺失时不参与跨 session 归类。 */
  sessionId?: string;
  /**
   * 成员 bridge 的父**会话**（事件 `parent_session_id`）；旧事件缺失。
   *
   * 与 ask 同一口径：旧记录里可能是父 agent id，读侧一律先过
   * `resolveParentSession`（`domains/pending/attribution.ts`）。
   */
  parentSessionId?: string;
  /** 成员 bridge 的父 **agent** id（事件 `parent_agent_id`）；0.51 additive。 */
  parentAgentId?: string;
  toolCallId?: string;
  source?: string;
  /** 0.17 additive：发起请求的子 agent（delegate_id / agent_id）；旧流缺失。 */
  agentId?: string;
  /** 事件时间（同一 run 多请求排序）。 */
  requestedAt: number;
}

/** sessions.delete 结果（级联计数用于确认/反馈） */
export interface DeleteSessionResult {
  sessions_deleted: number;
  runs_deleted: number;
  events_deleted: number;
}

export interface RenameSessionResult {
  session_id: string;
  title: string;
}

/**
 * `sessions.create` 参数（CONTRACT-0.39-create §2.1）。
 *
 * 无来源时空建；`from_session_id` 存在时从源 session 复制前缀
 * （`keep_messages` 是 `sessions.get().messages` 下标），可选 `seed: 'compact'`。
 * `mode` / `files` 是已批准的可选 git restore 字段，Phase 1 无 UI 入口。
 */
export interface SessionCreateInput {
  agent_id?: string;
  from_session_id?: string;
  seed?: 'copy' | 'compact';
  keep_messages?: number;
  startup_prompt?: string;
  /**
   * Additive (title_source): name the new session; it is marked as named so
   * automatic AI titling will not overwrite it. No UI entry point yet.
   */
  title?: string;
  mode?: 'conversation' | 'both';
  files?: { ref: string; paths: string[] };
}

/** `sessions.create` 结果；新 session 恒为 primary，源 session 退役但保留。 */
export interface SessionCreateResult {
  agent_id: string;
  session_id: string;
  source_session_id?: string;
  seed?: 'copy' | 'compact';
  keep_messages?: number;
  keep_projected?: number;
  copied_messages?: number;
  /** Additive: echoed only when the request named the session. */
  title?: string;
  primary: boolean;
  files_restored?: number;
  files_skipped?: number;
}

/** `sessions.activate` 参数（CONTRACT-0.39-create §4.1）。 */
export interface SessionActivateInput {
  session_id: string;
  startup_prompt?: string;
}

/** `sessions.activate` 结果；`noop` = 目标本来就是 primary。 */
export interface SessionActivateResult {
  agent_id: string;
  session_id: string;
  previous_session_id: string;
  epoch: number;
  noop: boolean;
}
